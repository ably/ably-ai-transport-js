'use client';

import type { Delivery } from '@ably/ai-transport';
import { useDeliveries, useTransport } from '@ably/ai-transport/react';
import type { VercelEvent } from '@ably/ai-transport/vercel';
import { useAbly, useChannelStateListener } from 'ably/react';
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';

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

export function Chat({ channelName }: { channelName: string }) {
  const { transport } = useTransport<VercelEvent>();
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
  // locks it once its next live chunk lands.
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
  const [attached, setAttached] = useState(channel.state === 'attached');
  useChannelStateListener(channelName, (change) => {
    setAttached(change.current === 'attached');
  });

  // `held` is the fuse: undefined in normal operation, an array while a
  // history walk runs. Live deliveries that land during the walk are parked
  // in it and released, in arrival order, once the walk has been applied, so
  // nothing newer is shown before something older. It starts closed, and the
  // load below opens it once the stored conversation and history are on the
  // page.
  const lastSeen = useRef<string | undefined>(undefined);
  const held = useRef<Delivery<VercelEvent>[] | undefined>([]);
  const [status, setStatus] = useState<'loading' | 'recovering' | undefined>('loading');

  const apply = useCallback(
    (delivery: Delivery<VercelEvent>, live: boolean) => {
      // The second tab shows every delivery as the pair the handler received.
      setDeliveries((prev) => [...prev, delivery]);
      // Recorded after applying, so it never points past what the page shows.
      lastSeen.current = delivery.message.serial;
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
      } else if (live && replies.current.has(from)) {
        setStreaming(true);
      }
    },
    [merge, upsert],
  );

  useDeliveries<VercelEvent>((delivery) => {
    if (held.current) {
      held.current.push(delivery);
      return;
    }
    apply(delivery, true);
  });

  // Page history back from the attach point until `seen`, the last serial the
  // page holds, and apply what is newer. Pages arrive newest first, so the
  // gap is collected and then applied oldest first. Serials sort as strings.
  // With no `seen` the whole channel is read. A stream cut by the gap heals
  // on its own: its next append arrives as a full-content update and the
  // codec hands on the unseen tail. The walk runs with the fuse closed and
  // opens it at the end, draining what arrived live meanwhile.
  const catchUp = useCallback(
    async (seen: string | undefined, why: 'loading' | 'recovering') => {
      if (transport === undefined) return;
      held.current ??= [];
      setStatus(why);
      try {
        const missed: Delivery<VercelEvent>[] = [];
        let page = await transport.history({ limit: 100 });
        for (;;) {
          const newer = page.items.filter((d) => seen === undefined || (d.message.serial ?? '') > seen);
          missed.unshift(...newer);
          if (newer.length < page.items.length || !page.hasNext) break;
          page = await page.next();
        }
        for (const delivery of missed) apply(delivery, false);
      } finally {
        const parked = held.current ?? [];
        held.current = undefined;
        for (const delivery of parked) apply(delivery, true);
        setStatus(undefined);
      }
    },
    [transport, apply],
  );

  // On load, the conversation comes from the server's store, and the channel
  // is read from the stored serial forward: the turns saved so far, then
  // whatever landed after them, then live delivery. A transport the provider
  // rebuilt underneath the walk (a Strict Mode remount, a channel change)
  // drops its result.
  useEffect(() => {
    if (transport === undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/messages?channel=${encodeURIComponent(channelName)}`);
        const stored = (await res.json()) as StoredConversation;
        if (cancelled) return;
        setMessages(stored.messages);
        lastSeen.current = stored.serial;
        await catchUp(stored.serial, 'loading');
      } catch (error) {
        if (!cancelled) console.error('load failed', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [transport, channelName, catchUp]);

  useEffect(() => {
    if (transport === undefined) return;
    return transport.on('discontinuity', () => {
      // Closing the client detaches the channel, which the transport reports
      // as a discontinuity. There is nothing to recover then, and a history
      // read on a closing connection would only fail.
      const { state } = client.connection;
      if (state === 'closing' || state === 'closed') return;
      catchUp(lastSeen.current, 'recovering').catch((error: unknown) => {
        console.error('recovery failed', error);
      });
    });
  }, [transport, catchUp, client]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (text === '' || streaming || transport === undefined) return;
    setInput('');
    const message: UIMessage = { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] };
    // Publish the message on the channel first, then wake the agent with it.
    // The server holds the conversation so far in its store and adds this
    // message to it.
    await transport.send({ type: 'user-message', message }, { headers: { requestId: message.id } });
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
            <span>Every delivery the transport handed the page, as its decoded event and the Ably message it came from.</span>
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
