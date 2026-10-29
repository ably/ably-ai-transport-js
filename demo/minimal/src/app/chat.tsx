'use client';

import type { Delivery } from '@ably/ai-transport';
import { type VercelEvent, vercelAdaptor, vercelDecoder } from '@ably/ai-transport/vercel';
import type * as Ably from 'ably';
import { useAbly, useChannelStateListener } from 'ably/react';
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** What `/api/messages` returns: the stored conversation, and the serial to read history from. */
interface StoredConversation {
  messages: UIMessage[];
  serial?: string;
}

const textOf = (message: UIMessage): string =>
  message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/**
 * The `requestId` header the publishing call attached, read off the raw Ably
 * message. The client stamps it on its prompt and the route on the reply and
 * any abort, so every message of a turn carries the prompt's id.
 * @param message - The delivered Ably message.
 * @returns The request id, or `undefined` for a message without one.
 */
const requestIdOf = (message: Delivery<VercelEvent>['message']): string | undefined => {
  const extras: unknown = message.extras;
  if (!isRecord(extras) || !isRecord(extras.headers)) return undefined;
  const { requestId } = extras.headers;
  return typeof requestId === 'string' ? requestId : undefined;
};

/**
 * The messages on the channel after `serial`, newest first, read back from the
 * point the channel attached. Serials are compared on when each message was
 * created, so a stream appended to after `serial` was published still counts
 * as at or before it.
 * @param channel - The attached channel.
 * @param serial - The serial of the last message the store holds.
 * @returns The newer messages, newest first, as history pages them.
 */
const messagesAfter = async (channel: Ably.RealtimeChannel, serial: string): Promise<Ably.InboundMessage[]> => {
  const newer: Ably.InboundMessage[] = [];
  let page = await channel.history({ untilAttach: true });
  for (;;) {
    newer.push(...page.items.filter((m) => (m.serial ?? '') > serial));
    if (page.items.some((m) => (m.serial ?? '') <= serial) || !page.hasNext()) return newer;
    const next = await page.next();
    if (!next) return newer;
    page = next;
  }
};

export function Chat({ channelName }: { channelName: string }) {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery<VercelEvent>[]>([]);
  const [tab, setTab] = useState<'chat' | 'wire'>('chat');
  const [input, setInput] = useState('');
  // The AI SDK's reducer merges one reply per stream: the `start` chunk opens
  // a stream, every chunk until `finish` is enqueued on it, and each state the
  // reducer yields replaces the message in the list. Streams are keyed by the
  // `requestId` header the client stamps on its prompt and the route on the
  // reply and its abort, so two replies from one agent process, or from two
  // tabs, cannot land in each other's stream. The form still takes one prompt
  // at a time.
  const replies = useRef(new Map<string, ReadableStreamDefaultController<UIMessageChunk>>());
  // Whether a reply is streaming now, which holds the composer. Set by a live
  // chunk of a reply the page is merging and cleared when the last open reply
  // ends, so a reply cut off in the past (a `start` in history with no
  // `finish`) never locks the page, and a reply in flight when the page loads
  // locks it once its next live chunk arrives.
  const [streaming, setStreaming] = useState(false);

  // Put a message in the list by id: a message the list already holds is
  // replaced in place, so a reply keeps its position as the reducer yields
  // each fuller state of it, and a new id goes on the end.
  const upsert = useCallback((message: UIMessage) => {
    setMessages((prev) =>
      prev.some((m) => m.id === message.id) ? prev.map((m) => (m.id === message.id ? message : m)) : [...prev, message],
    );
  }, []);

  const merge = useCallback(
    async (stream: ReadableStream<UIMessageChunk>) => {
      for await (const message of readUIMessageStream({ stream })) upsert(message);
    },
    [upsert],
  );

  // The first subscribe below attaches the channel; the indicator and the
  // composer follow the channel's own state. The listener reports
  // transitions only, so the initial value is read off the channel: a mount
  // on a channel that is already ATTACHED would otherwise show connecting…
  // until the next change.
  const client = useAbly();
  const channel = client.channels.get(channelName);
  // One decoder for the channel, for live delivery and history together, so
  // a message both carry decodes once. The page mounts a Chat per channel, so
  // the decoder lives as long as the channel does. The page publishes the
  // user's message through an adaptor on the same channel.
  const [decoder] = useState(() => vercelDecoder());
  const adaptor = useMemo(() => vercelAdaptor(channel), [channel]);
  const [attached, setAttached] = useState(channel.state === 'attached');
  useChannelStateListener(channelName, (change) => {
    setAttached(change.current === 'attached');
  });

  // Whether the page is still applying history, for the composer lock.
  const replaying = useRef(true);
  const [status, setStatus] = useState<'loading' | undefined>('loading');

  const apply = useCallback(
    (delivery: Delivery<VercelEvent>) => {
      // The second tab shows every delivery as the pair the handler received.
      setDeliveries((prev) => [...prev, delivery]);
      const { event, message } = delivery;
      if (event === undefined) return;
      // The user's own message comes back as an ordinary channel delivery, so
      // every tab, this one included, shows it from the same source.
      if (event.type === 'user-message') {
        upsert(event.message);
        return;
      }
      const from = requestIdOf(message) ?? '';
      if (event.type === 'start') {
        // Reserve the reply's place in the list now. The reducer yields its
        // first state asynchronously, and a replayed batch would otherwise
        // put the next user message ahead of the reply it follows.
        if (event.messageId !== undefined) upsert({ id: event.messageId, role: 'assistant', parts: [] });
        const stream = new ReadableStream<UIMessageChunk>({
          start: (controller) => {
            replies.current.set(from, controller);
          },
        });
        void merge(stream);
      }
      replies.current.get(from)?.enqueue(event);
      // `finish` ends a reply; `abort` is what the route publishes when its
      // pipe was cancelled and no `finish` will come.
      if (event.type === 'finish' || event.type === 'abort') {
        replies.current.get(from)?.close();
        replies.current.delete(from);
        setStreaming(replies.current.size > 0);
      } else if (!replaying.current && replies.current.has(from)) {
        setStreaming(true);
      }
    },
    [merge, upsert],
  );

  // On load, the conversation comes from the server's store, and the channel
  // is read from the stored serial forward: the turns saved so far, then
  // whatever arrived after them, then live delivery. The listener decodes each
  // live message as it arrives and holds the deliveries while history is read,
  // so the decoder sees live first and drops history's copy of anything live
  // already delivered. History is decoded newest first, as it pages, and
  // applied oldest first, then the held live deliveries follow. An effect
  // that is torn down underneath the load (a Strict Mode remount, a channel
  // change) unsubscribes and drops its result.
  useEffect(() => {
    let cancelled = false;
    let held: Delivery<VercelEvent>[] | undefined = [];
    const listener = (message: Ably.InboundMessage) => {
      const deliveries = decoder.decode(message);
      if (held === undefined) for (const delivery of deliveries) apply(delivery);
      else held.push(...deliveries);
    };
    void (async () => {
      try {
        const res = await fetch(`/api/messages?channel=${encodeURIComponent(channelName)}`);
        const stored = (await res.json()) as StoredConversation;
        if (cancelled) return;
        setMessages(stored.messages);
        await channel.subscribe(listener);
        // Without a stored serial the server has nothing stored, so the
        // channel holds nothing to catch up on.
        const newer = stored.serial === undefined ? [] : await messagesAfter(channel, stored.serial);
        if (cancelled) return;
        const fromHistory = newer.map((m) => decoder.decode(m)).toReversed();
        for (const deliveries of fromHistory) for (const delivery of deliveries) apply(delivery);
      } catch (error) {
        // A failed load leaves the page live with a gap.
        if (!cancelled) console.error('load failed', error);
      } finally {
        if (!cancelled) {
          const live = held ?? [];
          held = undefined;
          replaying.current = false;
          setStatus(undefined);
          for (const delivery of live) apply(delivery);
        }
      }
    })();
    return () => {
      cancelled = true;
      channel.unsubscribe(listener);
    };
  }, [channel, channelName, decoder, apply]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (text === '' || streaming) return;
    setInput('');
    const message: UIMessage = { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] };
    // Publish the message on the channel first, then wake the agent with it.
    // The server holds the conversation so far in its store and adds this
    // message to it.
    await adaptor.send({ type: 'user-message', message }, { headers: { requestId: message.id } });
    await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channelName, message }),
    });
  };

  const copyAll = async () => {
    await navigator.clipboard.writeText(JSON.stringify(deliveries, null, 2));
  };

  return (
    <main>
      <header>
        <span>{channelName}</span>
        <nav className="tabs">
          <button
            type="button"
            className={tab === 'chat' ? 'active' : ''}
            onClick={() => setTab('chat')}
          >
            Conversation
          </button>
          <button
            type="button"
            className={tab === 'wire' ? 'active' : ''}
            onClick={() => setTab('wire')}
          >
            Ably messages ({deliveries.length})
          </button>
        </nav>
        <span>{status !== undefined ? `${status}…` : streaming ? 'streaming…' : attached ? 'live' : 'connecting…'}</span>
      </header>
      {tab === 'chat' ? (
        <>
          <div className="messages">
            {messages.map((message) => (
              <div
                key={message.id}
                className={`message ${message.role}`}
              >
                {textOf(message)}
              </div>
            ))}
          </div>
          <form onSubmit={send}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={streaming ? 'Waiting for the reply…' : 'Say something'}
              disabled={streaming}
              autoFocus
            />
            <button
              type="submit"
              disabled={!attached || streaming || input.trim() === ''}
            >
              Send
            </button>
          </form>
        </>
      ) : (
        <>
          <div className="toolbar">
            <span>Every delivery the decoder gave the page, as its decoded event and the Ably message it came from.</span>
            <button
              type="button"
              onClick={copyAll}
              disabled={deliveries.length === 0}
            >
              Copy all
            </button>
          </div>
          <div className="deliveries">
            {deliveries.map((delivery, i) => (
              <pre key={`${delivery.message.serial ?? ''}:${delivery.message.version?.serial ?? String(i)}`}>
                {JSON.stringify(delivery, null, 2)}
              </pre>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
