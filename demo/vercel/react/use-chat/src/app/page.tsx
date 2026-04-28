'use client';

import { ChatTransportProvider } from '@ably/ai-transport/vercel/react';
import { Chat } from './chat';
import { Providers, useAblyReady } from './providers';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { generateChannelSlug } from './lib/channel-name';

const CHANNEL_NAMESPACE = process.env.NEXT_PUBLIC_ABLY_CHANNEL_NAMESPACE ?? 'ai:';

function ChatWhenReady({ channelName, clientId, limit }: { channelName: string; clientId?: string; limit?: number }) {
  const ready = useAblyReady();

  if (!ready) {
    return <div className="flex h-dvh items-center justify-center text-sm text-zinc-600">Connecting...</div>;
  }

  return (
    <ChatTransportProvider
      channelName={channelName}
      clientId={clientId}
    >
      <Chat
        chatId={channelName}
        clientId={clientId}
        historyLimit={limit}
      />
    </ChatTransportProvider>
  );
}

function ChatPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const paramChannel = searchParams.get('channel');
  const paramClientId = searchParams.get('clientId') ?? undefined;
  const limit = Number(searchParams.get('limit')) || undefined;

  const [channelName] = useState(() => paramChannel ?? `${CHANNEL_NAMESPACE}${generateChannelSlug()}`);
  const [clientId] = useState(() => paramClientId ?? `user-${crypto.randomUUID().slice(0, 8)}`);

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
        limit={limit}
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
