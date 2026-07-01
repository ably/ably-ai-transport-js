'use client';

import { ChatTransportProvider } from '@ably/ai-transport/vercel/react';
import type { UIMessage } from 'ai';
import { Chat } from './components/chat';
import { Providers, useAblyReady } from './providers';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { generateChannelSlug, generateClientName } from './lib/channel-name';

const CHANNEL_NAMESPACE = process.env.NEXT_PUBLIC_ABLY_CHANNEL_NAMESPACE ?? 'ai:';

/**
 * Fetch the persisted conversation, then mount the seeded chat. The seed is
 * fetched before mount so `useChat` reads it synchronously at init. The agent
 * persists every completed run, so no per-request flag is needed.
 */
function SeededChatWhenLoaded({ channelName, clientId }: { channelName: string; clientId?: string }) {
  const [seed, setSeed] = useState<UIMessage[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(`/api/messages?conversationId=${encodeURIComponent(channelName)}`);
        const data: unknown = await response.json();
        // CAST: trust boundary — the /api/messages body is our own persisted
        // UIMessage[], narrowed by the Array.isArray guard.
        if (!cancelled) setSeed(Array.isArray(data) ? (data as UIMessage[]) : []);
      } catch {
        if (!cancelled) setSeed([]);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [channelName]);

  if (seed === null) {
    return (
      <div className="flex h-dvh items-center justify-center text-sm text-muted-foreground">
        Loading saved conversation…
      </div>
    );
  }

  return (
    <ChatTransportProvider channelName={channelName}>
      <Chat
        chatId={channelName}
        clientId={clientId}
        seed={seed}
      />
    </ChatTransportProvider>
  );
}

function ChatWhenReady({ channelName, clientId }: { channelName: string; clientId?: string }) {
  const ready = useAblyReady();

  if (!ready) {
    return <div className="flex h-dvh items-center justify-center text-sm text-muted-foreground">Connecting...</div>;
  }

  return (
    <SeededChatWhenLoaded
      channelName={channelName}
      clientId={clientId}
    />
  );
}

function ChatPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const paramChannel = searchParams.get('channel');
  const paramClientId = searchParams.get('clientId') ?? undefined;

  const [channelName] = useState(() => paramChannel ?? `${CHANNEL_NAMESPACE}${generateChannelSlug()}`);
  const [clientId] = useState(() => paramClientId ?? generateClientName());

  useEffect(() => {
    if (paramChannel && paramClientId) return;
    const params = new URLSearchParams(searchParams.toString());
    if (!paramChannel) params.set('channel', channelName);
    if (!paramClientId) params.set('clientId', clientId);
    // `:` is valid unencoded in a query string (RFC 3986); un-escape it so the
    // address bar shows "ai:foo" instead of "ai%3Afoo".
    router.replace(`?${params.toString().replaceAll('%3A', ':')}`);
  }, [paramChannel, paramClientId, channelName, clientId, router, searchParams]);

  return (
    <Providers clientId={clientId}>
      <ChatWhenReady
        channelName={channelName}
        clientId={clientId}
      />
    </Providers>
  );
}

export default function Home() {
  return (
    <Suspense>
      <ChatPage />
    </Suspense>
  );
}
