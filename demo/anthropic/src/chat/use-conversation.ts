import { type Delivery, fromSerial, type Subscription, untilEvent } from '@ably/ai-transport';
import type { AnthropicEvent } from '@ably/ai-transport/anthropic';
import { useTransport } from '@ably/ai-transport/react';
import { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { useAbly, useChannelStateListener } from 'ably/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { type Entry, inputEntries, requestIdOf } from './lib';

/** What `/api/messages` returns: the stored conversation, and the serial to read history from. */
interface StoredConversation {
  entries: { id: string; param: MessageParam }[];
  serial?: string;
}

/** The conversation on one channel, as the page shows it, and the way to add to it. */
export interface ConversationHandle {
  /** The messages on the page, in order, each replaced in place as its reply grows. */
  entries: Entry[];
  /** Every delivery the subscription received, for the wire tab. */
  deliveries: Delivery<AnthropicEvent>[];
  /** Whether the channel is ATTACHED. */
  attached: boolean;
  /** `'loading'` until the stored conversation and the history after it are in. */
  status: 'loading' | undefined;
  /** Whether a reply is streaming now, from its `message_start` to its `message_stop`. */
  streaming: boolean;
  /** Whether this tab's own turn is in flight, from publishing its input to the route's response. */
  busy: boolean;
  /** Publishes the user's message on the channel as the codec's `input` event, then asks the agent to reply. */
  submit: (text: string) => Promise<void>;
  /**
   * Sends the user's answer to each pending tool call, by tool use id, to the
   * agent, which runs the approved calls, publishes every result and replies.
   */
  approve: (approvals: Record<string, boolean>) => Promise<void>;
}

/** What the page POSTs to `/api/chat`: the text of a message it has published, or answers to the pending tool calls. */
type TurnRequest = { text: string } | { approvals: Record<string, boolean> };

/**
 * Loads a channel's stored conversation, replays the channel from its serial
 * and builds every reply with the Anthropic SDK's own reducer.
 * @param channelName - The channel the conversation lives on.
 * @returns The conversation and the way to add to it.
 */
export function useConversation(channelName: string): ConversationHandle {
  const { transport } = useTransport<AnthropicEvent>();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery<AnthropicEvent>[]>([]);
  const [busy, setBusy] = useState(false);

  // The SDK's reducer builds one Message per stream: each `message_start`
  // opens a stream, every event until `message_stop` is enqueued on it as the
  // newline-delimited JSON `MessageStream.fromReadableStream` reads, and each
  // snapshot it emits replaces the Message on the page. Streams are keyed by
  // the `requestId` header, so an event only ever reaches its own turn's
  // stream.
  const replies = useRef(new Map<string, ReadableStreamDefaultController<Uint8Array>>());
  const [streaming, setStreaming] = useState(false);

  // Put an entry in the list by id: an entry the list already holds is
  // replaced in place, so a Message keeps its position as the reducer emits
  // each fuller state of it, and a new id goes on the end.
  const upsert = useCallback((entry: Entry) => {
    setEntries((prev) =>
      prev.some((e) => e.id === entry.id) ? prev.map((e) => (e.id === entry.id ? entry : e)) : [...prev, entry],
    );
  }, []);

  const openReply = useCallback(
    (from: string) => {
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          replies.current.set(from, controller);
        },
      });
      const reply = MessageStream.fromReadableStream(stream);

      // The snapshot is the reducer's own object, changed in place, so React
      // gets a copy of it.
      reply.on('streamEvent', (_event, snapshot) => {
        upsert({ id: snapshot.id, role: 'assistant', content: structuredClone(snapshot.content) });
      });
      reply.on('error', (error) => {
        console.error('reply stream failed', error);
      });
    },
    [upsert],
  );

  // The first subscribe below attaches the channel; the indicator and the
  // composer follow the channel's own state. The listener reports
  // transitions only, so the initial value is read off the channel.
  const client = useAbly();
  const channel = client.channels.get(channelName);
  const [attached, setAttached] = useState(channel.state === 'attached');
  useChannelStateListener(channelName, (change) => {
    setAttached(change.current === 'attached');
  });

  const subscription = useRef<Subscription | undefined>(undefined);
  const replaying = useRef(false);
  const [status, setStatus] = useState<'loading' | undefined>('loading');

  const apply = useCallback(
    (delivery: Delivery<AnthropicEvent>) => {
      // The wire tab shows every delivery as the pair the handler received.
      setDeliveries((prev) => [...prev, delivery]);

      const { event, message } = delivery;
      if (event === undefined) return;

      const from = requestIdOf(message) ?? '';

      // A client's input comes back as an ordinary channel delivery, so every
      // tab, this one included, shows it from the same source.
      if (event.type === 'input') {
        for (const entry of inputEntries(from, event.messages)) upsert(entry);
        return;
      }

      if (event.type === 'message_start') {
        // Reserve the reply's place now. The reducer emits its first snapshot
        // asynchronously, and a replayed batch would otherwise put the next
        // input ahead of the reply it follows.
        upsert({ id: event.message.id, role: 'assistant', content: [] });
        replies.current.get(from)?.close();
        openReply(from);
      }

      replies.current.get(from)?.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));

      if (event.type === 'message_stop') {
        replies.current.get(from)?.close();
        replies.current.delete(from);
        setStreaming(replies.current.size > 0);
      } else if (!replaying.current && replies.current.has(from)) {
        // Only a live delivery marks a reply as streaming, so a reply cut off
        // in the past, which never got its `message_stop`, never locks the page.
        setStreaming(true);
      }
    },
    [openReply, upsert],
  );

  // Subscribes with the history after `after` replayed first, the stored
  // conversation's serial on load. Without `after` no reply has landed yet,
  // and the whole channel is replayed: a predicate that matches nothing pages
  // history back to its start. The transport buffers this handler's live
  // deliveries until the replay is done, so the page shows history before
  // live, in channel order.
  const subscribeFrom = useCallback(
    (after: string | undefined) => {
      if (transport === undefined) return;

      subscription.current?.();
      replaying.current = true;
      setStatus('loading');

      const replay = after === undefined ? untilEvent<AnthropicEvent>(() => false) : fromSerial<AnthropicEvent>(after);
      const sub = transport.subscribe(apply, { history: { replay } });
      subscription.current = sub;

      void (async () => {
        // A failed replay leaves the handler live with a gap, so the page
        // goes live either way and logs the failure.
        let failure: unknown;
        try {
          await sub.replayed;
        } catch (error) {
          failure = error;
        }

        if (subscription.current !== sub) return;

        replaying.current = false;
        setStatus(undefined);
        if (failure !== undefined) console.error('loading failed', failure);
      })();
    },
    [transport, apply],
  );

  // On load, the conversation comes from the server's store, and the channel
  // is read from the stored serial forward.
  useEffect(() => {
    if (transport === undefined) return;

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/messages?channel=${encodeURIComponent(channelName)}`);
        const stored = (await res.json()) as StoredConversation;
        if (cancelled) return;

        setEntries(stored.entries.map(({ id, param }) => ({ id, role: param.role, content: param.content })));
        subscribeFrom(stored.serial);
      } catch (error) {
        if (!cancelled) console.error('load failed', error);
      }
    })();

    return () => {
      cancelled = true;
      subscription.current?.();
      subscription.current = undefined;
    };
  }, [transport, channelName, subscribeFrom]);

  // Ask the agent for a turn. The route answers once the turn's reply has
  // landed, so the caller holds the composer until this resolves.
  const postTurn = async (requestId: string, request: TurnRequest) => {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channelName, requestId, ...request }),
    });
    if (!res.ok) console.error('turn failed', await res.text());
  };

  // Publish the message on the channel first, then wake the agent with its
  // text. The server holds the conversation so far in its store and adds the
  // message to it.
  const submit = async (text: string) => {
    if (transport === undefined) return;

    const requestId = crypto.randomUUID();
    setBusy(true);
    try {
      await transport.send({ type: 'input', messages: [{ role: 'user', content: text }] }, { headers: { requestId } });
      await postTurn(requestId, { text });
    } finally {
      setBusy(false);
    }
  };

  // The agent runs the tools, so it builds their results and publishes them
  // itself; the page sends only the user's decisions.
  const approve = async (approvals: Record<string, boolean>) => {
    setBusy(true);
    try {
      await postTurn(crypto.randomUUID(), { approvals });
    } finally {
      setBusy(false);
    }
  };

  return { entries, deliveries, attached, status, streaming, busy, submit, approve };
}
