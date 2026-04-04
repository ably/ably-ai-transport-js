'use client';

import { Suspense, useState, useCallback, useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { ChannelProvider, useChannel, usePresence } from 'ably/react';
import type { UIMessage, UIMessageChunk } from 'ai';
import { useClientTransport, useView } from '@ably/ai-transport/react';
import { UIMessageCodec } from '@ably/ai-transport/vercel';
import { Providers, useAblyReady } from '../providers';
import { MessageList } from '../components/message-list';

const DEFAULT_CHANNEL = process.env.NEXT_PUBLIC_ABLY_CHANNEL ?? 'ai:support-demo';
const AGENT_CLIENT_ID = 'support-agent';

// ---------------------------------------------------------------------------
// Agent chat view — reuses customer MessageList for identical rendering
// ---------------------------------------------------------------------------

function AgentChat({ chatId }: { chatId: string }) {
  const { channel } = useChannel({ channelName: chatId });

  // Enter presence so the customer's /api/chat route detects us
  usePresence({ channelName: chatId }, { role: 'support-agent' });

  // Use the client transport for reading — identical message rendering to customer.
  // api points to a no-op endpoint since we publish directly to the channel.
  const transport = useClientTransport({
    channel,
    codec: UIMessageCodec,
    clientId: AGENT_CLIENT_ID,
    api: '/api/agent/chat',
    body: () => ({ id: chatId }),
  });

  const view = useView(transport, { limit: 50 });
  const [input, setInput] = useState('');

  // Publish directly to the channel — bypasses transport POST entirely.
  // Uses the codec encoder to write messages in the correct wire format.
  const publishDirect = useCallback(async (text: string) => {
    const msg: UIMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text }],
    };

    const encoder = UIMessageCodec.createEncoder(channel, {
      clientId: AGENT_CLIENT_ID,
      extras: {
        headers: {
          'x-ably-role': 'user',
          'x-ably-turn-client-id': AGENT_CLIENT_ID,
          'x-ably-turn-id': crypto.randomUUID(),
          'x-ably-msg-id': crypto.randomUUID(),
        },
      },
    });
    await encoder.writeMessages([msg], { clientId: AGENT_CLIENT_ID });
  }, [channel]);

  const handleSubmit = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    publishDirect(text);
  }, [input, publishDirect]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (input.trim()) handleSubmit();
    }
  };

  return (
    <div className="flex h-dvh flex-col bg-zinc-950">
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3">
        <div className="h-2 w-2 rounded-full bg-emerald-500" />
        <h1 className="text-sm font-medium text-zinc-300">Support Agent View</h1>
        <span className="ml-auto text-xs text-zinc-600 font-mono">{chatId}</span>
      </header>

      {/* Reuse the customer's MessageList for identical rendering */}
      <MessageList
        view={view}
        onCancelTurn={() => {}}
        onSendMessage={() => {}}
      />

      {/* Input */}
      <div className="border-t border-zinc-800 px-4 py-3">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message to the customer..."
            className="flex-1 rounded-md bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-emerald-700"
            autoFocus
          />
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!input.trim()}
            className="rounded-md bg-emerald-900/60 px-4 py-2 text-sm font-medium text-emerald-300 hover:bg-emerald-900/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard — channel picker + join
// ---------------------------------------------------------------------------

function AgentDashboard({ channelName }: { channelName: string }) {
  const ready = useAblyReady();
  const [joined, setJoined] = useState(false);
  const [channel, setChannel] = useState(channelName);

  if (!ready) {
    return <div className="flex h-dvh items-center justify-center text-sm text-zinc-600">Connecting...</div>;
  }

  if (!joined) {
    return (
      <div className="flex h-dvh items-center justify-center bg-zinc-950">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 max-w-sm w-full">
          <h1 className="text-lg font-medium text-zinc-200 mb-1">Support Agent</h1>
          <p className="text-xs text-zinc-500 mb-4">Join a customer conversation</p>
          <label className="block text-xs text-zinc-500 mb-1">Channel</label>
          <input
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            className="w-full rounded-md bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-emerald-700 mb-4 font-mono"
          />
          <button
            onClick={() => setJoined(true)}
            className="w-full rounded-md bg-emerald-900/60 py-2.5 text-sm font-medium text-emerald-300 hover:bg-emerald-900/80 transition-colors"
          >
            Join conversation
          </button>
        </div>
      </div>
    );
  }

  return (
    <ChannelProvider channelName={channel}>
      <AgentChat chatId={channel} />
    </ChannelProvider>
  );
}

// ---------------------------------------------------------------------------
// Page entry
// ---------------------------------------------------------------------------

function AgentPage() {
  const searchParams = useSearchParams();
  const channelName = searchParams.get('channel') ?? DEFAULT_CHANNEL;

  return (
    <Providers clientId={AGENT_CLIENT_ID}>
      <AgentDashboard channelName={channelName} />
    </Providers>
  );
}

export default function Agent() {
  return (
    <Suspense>
      <AgentPage />
    </Suspense>
  );
}
