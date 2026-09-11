'use client';

import { Providers, useAblyReady } from '@ably-ai-demos/frontend/ably-provider';
import { ClientTransportProvider } from '@ably/ai-transport/react';
import { Chat } from './components/chat';
import { responsesCodec } from './lib/openai-thread';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { generateChannelSlug, generateClientName } from '@ably-ai-demos/frontend/lib/channel-name';

const CHANNEL_NAMESPACE = process.env.NEXT_PUBLIC_ABLY_CHANNEL_NAMESPACE ?? 'ai:';

function ChatWhenReady({
  channelName,
  clientId,
  historyPageSize,
}: {
  channelName: string;
  clientId?: string;
  historyPageSize?: number;
}) {
  const ready = useAblyReady();

  if (!ready) {
    return <div className="flex h-dvh items-center justify-center text-sm text-zinc-600">Connecting...</div>;
  }

  return (
    <ClientTransportProvider
      channelName={channelName}
      codec={responsesCodec}
      clientId={clientId}
      historyPageSize={historyPageSize}
    >
      <Chat
        chatId={channelName}
        clientId={clientId}
        api="api/chat"
      />
    </ClientTransportProvider>
  );
}

function ChatPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const paramChannel = searchParams.get('channel');
  const paramClientId = searchParams.get('clientId') ?? undefined;
  // Wire-message limit per history round trip; a small value forces the
  // hydration to page in several batches (the multi-batch stress case).
  const historyPageSize = Number(searchParams.get('limit')) || undefined;

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
        historyPageSize={historyPageSize}
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
