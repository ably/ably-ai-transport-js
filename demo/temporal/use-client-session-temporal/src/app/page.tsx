'use client';

import {
  Providers,
  useAblyReady,
  SessionHooks,
  Chat,
  generateChannelSlug,
  generateClientName,
} from '@ably-ai-demos/frontend';
import { UIMessageCodec } from '@ably/ai-transport/vercel';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

import {
  TEMPORAL_DEMO_STEPS,
  TEMPORAL_INTRO_TITLE,
  TEMPORAL_INTRO_DESCRIPTION,
  STOCK_RETRY_STEP,
} from './demo-content';

const { ClientSessionProvider } = SessionHooks;

const CHANNEL_NAMESPACE = process.env.NEXT_PUBLIC_ABLY_CHANNEL_NAMESPACE ?? 'ai:';

function ChatWhenReady({ channelName, clientId, limit }: { channelName: string; clientId?: string; limit?: number }) {
  const ready = useAblyReady();

  if (!ready) {
    return <div className="flex h-dvh items-center justify-center text-sm text-zinc-600">Connecting...</div>;
  }

  return (
    <ClientSessionProvider
      channelName={channelName}
      codec={UIMessageCodec}
    >
      <Chat
        chatId={channelName}
        clientId={clientId}
        historyLimit={limit}
        api="api/chat"
        demoSteps={TEMPORAL_DEMO_STEPS}
        demoTitle={TEMPORAL_INTRO_TITLE}
        demoDescription={TEMPORAL_INTRO_DESCRIPTION}
        extraProgressSteps={[STOCK_RETRY_STEP]}
      />
    </ClientSessionProvider>
  );
}

function ChatPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const paramChannel = searchParams.get('channel');
  const paramClientId = searchParams.get('clientId') ?? undefined;
  const limit = Number(searchParams.get('limit')) || undefined;

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
