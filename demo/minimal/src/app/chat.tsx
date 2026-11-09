'use client';

import type { Delivery } from '@ably/ai-transport';
import { type VercelEvent, vercelAdaptor, vercelDecoder } from '@ably/ai-transport/vercel';
import { useChannelStateListener, usePubSubClient } from '@ably/pubsub-device/react';
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** What `/api/messages` returns: the stored conversation, and the serial the channel rewinds to. */
export interface StoredConversation {
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
 * Call `enqueue` or `close` on a reply's stream. The AI SDK's reducer cancels
 * that stream when a chunk does not fit what it has seen, and the controller
 * then throws on every call. The reply is over at that point, and the
 * reducer's `onError` has logged why, so the call is dropped.
 * @param call - The controller call.
 */
const callReply = (call: () => void): void => {
  try {
    call();
  } catch {
    // The reducer cancelled this reply's stream.
  }
};

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

/** What the page passes to {@link Chat}. */
interface ChatProps {
  channelName: string;
  /** The conversation the server stored, rendered before anything the channel delivers. */
  stored: UIMessage[];
  /** Called once when the channel loses continuity, so the page can re-read the store and mount a fresh Chat. */
  onDiscontinuity: () => void;
}

export function Chat({ channelName, stored, onDiscontinuity }: ChatProps) {
  const [messages, setMessages] = useState<UIMessage[]>(stored);
  const [deliveries, setDeliveries] = useState<Delivery<VercelEvent>[]>([]);
  const [tab, setTab] = useState<'chat' | 'wire'>('chat');
  const [input, setInput] = useState('');
  // Why the last send did not go through, shown in the header until the next send.
  const [failure, setFailure] = useState<string>();
  // Whether the prompt's publish is in flight. The input is disabled meanwhile,
  // so a failed publish can put the prompt back without overwriting new text.
  const [sending, setSending] = useState(false);
  // The AI SDK's reducer merges one reply per stream: the `start` chunk opens
  // a stream, every chunk until `finish` is enqueued on it, and each state the
  // reducer yields replaces the message in the list. Streams are keyed by the
  // `requestId` header the client stamps on its prompt and the route on the
  // reply and its abort, so two replies from one agent process, or from two
  // tabs, cannot land in each other's stream. The form still takes one prompt
  // at a time.
  const replies = useRef(new Map<string, ReadableStreamDefaultController<UIMessageChunk>>());
  // Whether a reply is streaming now, which holds the composer. Set by a
  // chunk of a reply the page is merging and cleared when the last open reply
  // ends with its `finish` or `abort`. A reply the channel rewinds to while it
  // is in flight locks the page too, and the route publishes an `abort` for
  // any reply it could not finish, so a reply is left open only if the agent
  // itself dies mid-stream.
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
      const states = readUIMessageStream({
        stream,
        onError: (error) => {
          console.error('reply rejected', error);
        },
      });
      for await (const message of states) upsert(message);
    },
    [upsert],
  );

  // The effect below attaches the channel; the indicator and the
  // composer follow the channel's own state. The listener reports
  // transitions only, so the initial value is read off the channel: a mount
  // on a channel that is already ATTACHED would otherwise show connecting…
  // until the next change.
  const client = usePubSubClient();
  const channel = client.channels.get(channelName);
  // The page publishes the user's message through an adaptor on the channel.
  const adaptor = useMemo(() => vercelAdaptor(channel), [channel]);
  const [attached, setAttached] = useState(channel.state === 'attached');
  // Whether this mount has seen the channel attached. The first ATTACHED it
  // sees is the attach its own effect started, so it does not count as a
  // loss, and a mount that never attaches does not ask for a re-init: a
  // channel that cannot attach would otherwise re-init forever.
  const hasAttached = useRef(channel.state === 'attached');
  useChannelStateListener(channelName, (change) => {
    setAttached(change.current === 'attached');
    if (change.current === 'attached' && !hasAttached.current) {
      hasAttached.current = true;
      return;
    }
    if (!hasAttached.current) return;
    // DETACHED and FAILED clear the channel's serial, so its next attach
    // cannot resume and would rewind from the page-load serial again. An
    // attach or update that did not resume has skipped messages. Either way
    // the page re-reads the store and rewinds from the serial it returns.
    // SUSPENDED keeps the serial, so the reattach after it normally resumes.
    const lost =
      change.current === 'detached' || change.current === 'failed' || (change.current === 'attached' && !change.resumed);
    if (lost) onDiscontinuity();
  });


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
      const reply = replies.current.get(from);
      if (reply !== undefined) callReply(() => reply.enqueue(event));
      // `finish` ends a reply; `abort` is what the route publishes when its
      // pipe was cancelled and no `finish` will come.
      if (event.type === 'finish' || event.type === 'abort') {
        if (reply !== undefined) callReply(() => reply.close());
        replies.current.delete(from);
        setStreaming(replies.current.size > 0);
      } else if (replies.current.has(from)) {
        setStreaming(true);
      }
    },
    [merge, upsert],
  );

  // The page mounted the channel to rewind to the stored serial, so this one
  // subscription delivers, in channel order, everything after the turns the
  // server stored, then live messages. One decoder sees all of it, so a
  // message is decoded once and a stream's first delivery, a full-content
  // update, reduces the appends after it to their new text. A decoder is
  // built per run: a run that is torn down and started again (a Strict Mode
  // remount, Fast Refresh) must not reuse one that has already seen the
  // messages. Rewind applies only when the channel attaches, so a re-run on a
  // channel that is still attached replays nothing and misses what arrived
  // while it was unsubscribed. Teardown closes the reply streams still open
  // and clears the wire tab, so a re-run starts from what it receives.
  useEffect(() => {
    const decoder = vercelDecoder();
    decoder.onEvent(apply);
    decoder.onError((error) => {
      console.error('decode failed', error);
    });
    // ChannelProvider turns off the Pub/Sub SDK's attach on subscribe, so the effect
    // attaches the channel itself. The listener goes on first, so the
    // messages the rewind delivers on attach reach it.
    const start = async (): Promise<void> => {
      await channel.subscribe(decoder.receive);
      await channel.attach();
    };
    start().catch((error: unknown) => {
      // The channel did not attach: the page stays on connecting… and Send
      // stays disabled.
      console.error('attach failed', error);
    });
    const open = replies.current;
    return () => {
      channel.unsubscribe(decoder.receive);
      for (const controller of open.values()) callReply(() => controller.close());
      open.clear();
      setStreaming(false);
      setDeliveries([]);
    };
  }, [channel, apply]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (text === '' || streaming || sending) return;
    setInput('');
    setFailure(undefined);
    const message: UIMessage = { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] };
    // Publish the message on the channel first, then wake the agent with it.
    // The server holds the conversation so far in its store and adds this
    // message to it, with the serial its publish returned, so a page that
    // loads while the reply streams rewinds to just after this message.
    let serial: string | undefined;
    setSending(true);
    try {
      ({ serial } = await adaptor.send({ type: 'user-message', message }, { headers: { requestId: message.id } }));
    } catch (error) {
      // The prompt never reached the channel, so it goes back in the box.
      console.error('send failed', error);
      setInput(text);
      setFailure('unable to send; try again');
      return;
    } finally {
      setSending(false);
    }
    // The route answers once the reply has finished, so an error status can
    // come after part of the reply streamed. The prompt is on the channel
    // and stays in the list either way.
    let res: Response;
    try {
      res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channelName, message, serial }),
      });
    } catch (error) {
      console.error('agent request failed', error);
      setFailure('unable to reach the agent; send again');
      return;
    }
    if (!res.ok) {
      console.error('reply failed', res.status);
      setFailure('the reply failed; send again');
    }
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
        <span>{failure ?? (streaming ? 'streaming…' : attached ? 'live' : 'connecting…')}</span>
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
              disabled={streaming || sending}
              autoFocus
            />
            <button
              type="submit"
              disabled={!attached || streaming || sending || input.trim() === ''}
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
