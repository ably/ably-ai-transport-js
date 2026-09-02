'use client';

import { ChatTransportProvider } from '@ably/ai-transport/vercel/react';
// OBJECT_MODES is not re-exported from the vercel/react entry point, so import
// it from the package root.
import { OBJECT_MODES } from '@ably/ai-transport';
import { Providers, useAblyReady, generateChannelSlug, generateClientName } from '@ably-ai-demos/frontend';
import { Chat } from './chat';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

const CHANNEL_NAMESPACE = process.env.NEXT_PUBLIC_ABLY_CHANNEL_NAMESPACE ?? 'ai:';

function ChatWhenReady({ channelName, clientId }: { channelName: string; clientId?: string }) {
  const ready = useAblyReady();

  if (!ready) {
    return <div className="flex h-dvh items-center justify-center text-sm text-muted-foreground">Connecting...</div>;
  }

  return (
    <ChatTransportProvider
      channelName={channelName}
      channelModes={OBJECT_MODES}
    >
      <Chat
        chatId={channelName}
        clientId={clientId}
      />
    </ChatTransportProvider>
  );
}

function ChatPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const paramChannel = searchParams.get('channel');
  const paramClientId = searchParams.get('clientId') ?? undefined;

  const [channelName] = useState(() => paramChannel ?? `${CHANNEL_NAMESPACE}${generateChannelSlug()}`);
  const [clientId] = useState(() => paramClientId ?? generateClientName());

  // Only the channel goes in the URL. Sharing the address is how a second tab
  // joins the same conversation, and a `clientId` carried along with it would
  // give both tabs one identity — which is exactly what the multi-tab scenario
  // watches for, since it counts distinct `run-client-id` values. A clientId
  // supplied explicitly in the URL is still honoured.
  useEffect(() => {
    if (paramChannel) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set('channel', channelName);
    // `:` is valid unencoded in a query string (RFC 3986); un-escape it so the
    // address bar shows "ai:foo" instead of "ai%3Afoo".
    router.replace(`?${params.toString().replaceAll('%3A', ':')}`);
  }, [paramChannel, channelName, router, searchParams]);

  return (
    <Providers
      clientId={clientId}
      liveObjects
    >
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
