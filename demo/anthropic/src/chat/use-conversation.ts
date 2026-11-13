import type { Delivery } from '@ably/ai-transport';
import { anthropicAdaptor, anthropicDecoder, type AnthropicEvent } from '@ably/ai-transport/anthropic';
import { useChannelStateListener, usePubSubClient } from '@ably/pubsub-device/react';
import { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { type Entry, inputEntries, requestIdOf, type StoredConversation } from './lib';

/** The channel a conversation lives on, what the server stored of it, and what to do when the channel loses continuity. */
export interface UseConversationOptions {
  /** The channel the conversation lives on, which the page mounted to rewind to the stored serial. */
  channelName: string;
  /** The entries the server stored, shown before anything the channel delivers. */
  stored: StoredConversation['entries'];
  /** Called when the channel loses continuity, so the page can read the store again and mount a fresh chat. */
  onDiscontinuity: () => void;
}

/** The conversation on one channel, as the page shows it, and the way to add to it. */
export interface ConversationHandle {
  /** The messages on the page, in order, each replaced in place as its reply grows. */
  entries: Entry[];
  /** Every delivery the decoder gave the page, for the wire tab. */
  deliveries: Delivery<AnthropicEvent>[];
  /** Whether the channel is ATTACHED. */
  attached: boolean;
  /** Whether a reply is streaming now, from its `message_start` to its `message_stop` or `error`. */
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

/** What the page POSTs to `/api/chat`: the text and serial of a message it has published, or answers to the pending tool calls. */
type TurnRequest = { text: string; serial: string | undefined } | { approvals: Record<string, boolean> };

/**
 * Shows the stored conversation, decodes what the rewound channel delivers
 * after it, and builds every reply with the Anthropic SDK's own reducer.
 * @param options - The channel, the stored entries and the discontinuity callback.
 * @returns The conversation and the way to add to it.
 */
export function useConversation({ channelName, stored, onDiscontinuity }: UseConversationOptions): ConversationHandle {
  const [entries, setEntries] = useState<Entry[]>(() =>
    stored.map(({ id, param }) => ({ id, role: param.role, content: param.content })),
  );
  const [deliveries, setDeliveries] = useState<Delivery<AnthropicEvent>[]>([]);
  const [busy, setBusy] = useState(false);

  // The SDK's reducer builds one Message per stream: each `message_start`
  // opens a stream, every event until `message_stop` is enqueued on it as the
  // newline-delimited JSON `MessageStream.fromReadableStream` reads, and each
  // snapshot it emits replaces the Message on the page. Streams are keyed by
  // the `requestId` header, so an event only ever reaches its own turn's
  // stream.
  const replies = useRef(new Map<string, ReadableStreamDefaultController<Uint8Array>>());
  // Whether a reply is streaming now, which holds the composer. The route
  // sends an `error` for any reply it could not finish, so a reply is left
  // open only if the agent itself dies mid-stream.
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

  // The effect below attaches the channel; the indicator and the composer
  // follow the channel's own state. The listener reports transitions only,
  // so the initial value is read off the channel.
  const client = usePubSubClient();
  const channel = client.channels.get(channelName);
  // The page publishes the user's message through an adaptor on the channel.
  const adaptor = useMemo(() => anthropicAdaptor(channel), [channel]);
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

      // The agent publishes an `error` when a reply fails. The page closes the
      // reply's stream rather than failing it: failing a stream drops the
      // events still queued in it, and a page that loads after the failure
      // gets the whole reply at once, so it would show the reply empty.
      // Closing keeps the part that arrived on the page and frees the composer.
      if (event.type === 'error') {
        console.error('reply failed', event.error.message);
        replies.current.get(from)?.close();
        replies.current.delete(from);
        setStreaming(replies.current.size > 0);
        return;
      }

      if (event.type === 'message_start') {
        // Reserve the reply's place now. The reducer emits its first snapshot
        // asynchronously, and a rewound batch would otherwise put the next
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
      } else if (replies.current.has(from)) {
        setStreaming(true);
      }
    },
    [openReply, upsert],
  );

  // The page mounted the channel to rewind to the stored serial, so this one
  // subscription delivers, in channel order, everything after the entries the
  // server stored, then live messages. One decoder sees all of it, so a
  // message is decoded once and a block's first delivery, a full-content
  // update, reduces the appends after it to their new text. A decoder is
  // built per run: a run that is torn down and started again (a Strict Mode
  // remount, Fast Refresh) must not reuse one that has already seen the
  // messages. Teardown closes the reply streams still open and clears the
  // wire tab, so a re-run starts from what it receives.
  useEffect(() => {
    const decoder = anthropicDecoder();
    decoder.onEvent(apply);
    decoder.onError((error) => {
      console.error('decode failed', error);
    });

    // ChannelProvider turns off the Pub/Sub SDK's attach on subscribe, so the
    // effect attaches the channel itself. The listener goes on first, so the
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
      for (const controller of open.values()) controller.close();
      open.clear();
      setStreaming(false);
      setDeliveries([]);
    };
  }, [channel, apply]);

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
  // text and the serial its publish returned. The server holds the
  // conversation so far in its store and adds the message to it, with that
  // serial, so a page that loads while the reply streams rewinds to just
  // after the message.
  const submit = async (text: string) => {
    const requestId = crypto.randomUUID();
    setBusy(true);
    try {
      const { serial } = await adaptor.send(
        { type: 'input', messages: [{ role: 'user', content: text }] },
        { headers: { requestId } },
      );
      await postTurn(requestId, { text, serial });
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

  return { entries, deliveries, attached, streaming, busy, submit, approve };
}
