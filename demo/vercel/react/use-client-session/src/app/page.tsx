'use client';

import { Providers, useAblyReady, SessionHooks } from './providers';
import { UIMessageCodec } from '@ably/ai-transport/vercel';
import { Chat } from './components/chat';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

const { ClientSessionProvider } = SessionHooks;

const DEFAULT_CHANNEL = process.env.NEXT_PUBLIC_ABLY_CHANNEL ?? 'ai:demo';

function ChatWhenReady({ channelName, clientId, limit }: { channelName: string; clientId?: string; limit?: number }) {
  const ready = useAblyReady();

  if (!ready) {
    return <div className="flex h-dvh items-center justify-center text-sm text-zinc-600">Connecting...</div>;
  }

  return (
    <ClientSessionProvider
      channelName={channelName}
      codec={UIMessageCodec}
      clientId={clientId}
      api="api/chat"
      body={() => ({ sessionName: channelName })}
    >
      <Chat
        chatId={channelName}
        clientId={clientId}
        historyLimit={limit}
      />
    </ClientSessionProvider>
  );
}

function ChatPage() {
  const searchParams = useSearchParams();
  const baseChannel = searchParams.get('channel') ?? DEFAULT_CHANNEL;
  const clientId = searchParams.get('clientId') ?? undefined;
  const limit = Number(searchParams.get('limit')) || undefined;
  const tab = searchParams.get('tab') === 'images' ? 'images' : 'chat';

  // Each tab uses a `-${tab}` suffix on the base channel so chat and image
  // histories live on different Ably channels. The URL keeps the base; the
  // effective channel below is what we actually attach to.
  const effectiveChannel = `${baseChannel}-${tab}`;

  return (
    <Providers clientId={clientId}>
      <ChatWhenReady
        key={effectiveChannel}
        channelName={effectiveChannel}
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
