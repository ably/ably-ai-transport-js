'use client';

import type { Delivery } from '@ably/ai-transport';
import { useDeliveries, useTransport } from '@ably/ai-transport/react';
import type { VercelEvent } from '@ably/ai-transport/vercel';
import { useChannelStateListener } from 'ably/react';
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';

const textOf = (message: UIMessage): string =>
  message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');

export function Chat({ channelName }: { channelName: string }) {
  const { transport } = useTransport<VercelEvent>();
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery<VercelEvent>[]>([]);
  const [tab, setTab] = useState<'chat' | 'wire'>('chat');
  const [input, setInput] = useState('');
  // The AI SDK's reducer folds one reply per stream: the `start` chunk opens
  // a stream, every chunk until `finish` is enqueued on it, and each state the
  // reducer yields replaces the message in the list.
  const reply = useRef<ReadableStreamDefaultController<UIMessageChunk> | null>(null);

  const upsert = useCallback((message: UIMessage) => {
    setMessages((prev) =>
      prev.some((m) => m.id === message.id) ? prev.map((m) => (m.id === message.id ? message : m)) : [...prev, message],
    );
  }, []);

  const fold = useCallback(
    async (stream: ReadableStream<UIMessageChunk>) => {
      for await (const message of readUIMessageStream({ stream })) upsert(message);
    },
    [upsert],
  );

  // The first subscribe below attaches the channel; the indicator and the
  // composer follow the channel's own state.
  const [attached, setAttached] = useState(false);
  useChannelStateListener(channelName, (change) => {
    setAttached(change.current === 'attached');
  });

  // Recovery from a discontinuity. `held` is the fuse: undefined in normal
  // operation, an array while a history walk runs. Live deliveries that land
  // during the walk are parked in it and released, in arrival order, once the
  // gap has been applied, so nothing newer is shown before something older.
  const lastSeen = useRef<string | undefined>(undefined);
  const held = useRef<Delivery<VercelEvent>[] | undefined>(undefined);
  const [recovering, setRecovering] = useState(false);

  const apply = useCallback(
    (delivery: Delivery<VercelEvent>) => {
      // The second tab shows every delivery as the pair the handler received.
      setDeliveries((prev) => [...prev, delivery]);
      // Recorded after applying, so it never points past what the page shows.
      lastSeen.current = delivery.message.serial;
      const { event } = delivery;
      if (event === undefined) return;
      // The user's own message comes back as an ordinary channel delivery, so
      // every tab, this one included, shows it from the same source.
      if (event.type === 'user-message') {
        upsert(event.message);
        return;
      }
      if (event.type === 'start') {
        const stream = new ReadableStream<UIMessageChunk>({
          start: (controller) => {
            reply.current = controller;
          },
        });
        void fold(stream);
      }
      reply.current?.enqueue(event);
      if (event.type === 'finish') {
        reply.current?.close();
        reply.current = null;
      }
    },
    [fold, upsert],
  );

  useDeliveries<VercelEvent>((delivery) => {
    if (held.current) {
      held.current.push(delivery);
      return;
    }
    apply(delivery);
  });

  useEffect(() => {
    if (transport === undefined) return;
    return transport.on('discontinuity', async () => {
      held.current = [];
      setRecovering(true);
      try {
        // Page history back from the new attach point until the last serial
        // applied. Pages arrive newest first, so the gap is collected and then
        // applied oldest first. Serials sort as strings. A stream cut by the
        // gap heals on its own: its next append arrives as a full-content
        // update and the codec hands on the unseen tail.
        const missed: Delivery<VercelEvent>[] = [];
        const seen = lastSeen.current;
        let page = await transport.history({ limit: 100 });
        for (;;) {
          const newer = page.items.filter((d) => seen === undefined || (d.message.serial ?? '') > seen);
          missed.unshift(...newer);
          if (newer.length < page.items.length || !page.hasNext) break;
          page = await page.next();
        }
        for (const delivery of missed) apply(delivery);
      } finally {
        // Close the fuse, then drain what arrived live during the walk.
        const parked = held.current ?? [];
        held.current = undefined;
        for (const delivery of parked) apply(delivery);
        setRecovering(false);
      }
    });
  }, [transport, apply]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (text === '' || transport === undefined) return;
    setInput('');
    const message: UIMessage = { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] };
    // Publish the message on the channel first, then wake the agent with the
    // conversation so far.
    await transport.send({ type: 'user-message', message });
    await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channelName, messages: [...messages, message] }),
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
        <span>{recovering ? 'recovering…' : attached ? 'live' : 'connecting…'}</span>
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
              placeholder="Say something"
              autoFocus
            />
            <button
              type="submit"
              disabled={!attached || input.trim() === ''}
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
