'use client';

import { Providers, useAblyReady, TransportHooks } from './providers';
import { UIMessageCodec } from '@ably/ai-transport/vercel';
import { Chat } from './components/chat';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

const { TransportProvider } = TransportHooks;

const DEFAULT_CHANNEL = process.env.NEXT_PUBLIC_ABLY_CHANNEL ?? 'ai:demo';

function ChatWhenReady({ channelName, clientId, limit }: { channelName: string; clientId?: string; limit?: number }) {
  const ready = useAblyReady();

  if (!ready) {
    return <div className="flex h-dvh items-center justify-center text-sm text-zinc-600">Connecting...</div>;
  }

  return (
    <TransportProvider
      channelName={channelName}
      codec={UIMessageCodec}
      clientId={clientId}
      body={() => ({ id: channelName })}
    >
      <Chat
        chatId={channelName}
        clientId={clientId}
        historyLimit={limit}
      />
    </TransportProvider>
  );
}

function ChatPage() {
  const searchParams = useSearchParams();
  const channelName = searchParams.get('channel') ?? DEFAULT_CHANNEL;
  const clientId = searchParams.get('clientId') ?? undefined;
  const limit = Number(searchParams.get('limit')) || undefined;

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
