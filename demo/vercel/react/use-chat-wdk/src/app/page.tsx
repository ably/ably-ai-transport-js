'use client';

import { ChatTransportProvider } from '@ably/ai-transport/vercel/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';

import { Providers, useAblyReady, generateChannelSlug, generateClientName } from '@ably-ai-demos/frontend';
import { Chat } from './chat';
import type { FaultMode } from './lib/fault';

const CHANNEL_NAMESPACE = process.env.NEXT_PUBLIC_ABLY_CHANNEL_NAMESPACE ?? 'ai:';

function ChatWhenReady({ channelName, clientId, limit }: { channelName: string; clientId?: string; limit?: number }) {
  const ready = useAblyReady();

  // The armed fault rides the send POST via prepareSendMessagesRequest. It reads
  // a ref (not state) so the transport options stay stable — a new reference
  // would recreate the ChatTransport.
  const faultRef = useRef<FaultMode | undefined>(undefined);
  const chatOptions = useMemo(
    () => ({
      prepareSendMessagesRequest: () => {
        // One-shot: the fault applies to the send that carries it — never to
        // the auto-submitted continuations (tool results, approvals) that
        // follow through this same hook. A faulted continuation would retry
        // its `ai-run-resume` publish, an out-of-model double-resume.
        const fault = faultRef.current;
        faultRef.current = undefined;
        return fault ? { body: { fault } } : {};
      },
    }),
    [],
  );

  if (!ready) {
    return <div className="flex h-dvh items-center justify-center text-sm text-muted-foreground">Connecting...</div>;
  }

  return (
    <ChatTransportProvider
      channelName={channelName}
      chatOptions={chatOptions}
    >
      <Chat
        chatId={channelName}
        clientId={clientId}
        historyLimit={limit}
        faultRef={faultRef}
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
