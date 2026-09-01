'use client';

import { ChatTransportProvider } from '@ably/ai-transport/vercel/react';
import { Chat } from './components/chat';
import { Providers, useAblyReady, generateChannelSlug, generateClientName } from '@ably-ai-demos/frontend';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { useChatHydration } from './hooks/use-chat-hydration';

const CHANNEL_NAMESPACE = process.env.NEXT_PUBLIC_ABLY_CHANNEL_NAMESPACE ?? 'ai:';

/**
 * Hydrate the conversation under the provider, then mount the chat. The hook
 * connects the transport, reads the stored conversation, and walks the channel
 * forward from the serial it is complete up to — so `useChat` reads the full
 * conversation synchronously at init, and a run still streaming at page load
 * is picked up by the adapter's resume path rather than rendered twice.
 */
function HydratedChat({ channelName, clientId }: { channelName: string; clientId?: string }) {
  const state = useChatHydration({ channelName });

  if (state.status === 'loading') {
    return (
      <div className="flex h-dvh items-center justify-center text-sm text-muted-foreground">Loading conversation…</div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="flex h-dvh items-center justify-center text-sm text-destructive">
        Failed to load conversation: {state.error.message}
      </div>
    );
  }

  return (
    <Chat
      chatId={channelName}
      clientId={clientId}
      chatTransport={state.chatTransport}
      initialMessages={state.initialMessages}
      initialHasOlder={state.hasOlder}
    />
  );
}

function ChatWhenReady({ channelName, clientId }: { channelName: string; clientId?: string }) {
  const ready = useAblyReady();

  if (!ready) {
    return <div className="flex h-dvh items-center justify-center text-sm text-muted-foreground">Connecting...</div>;
  }

  // ChatTransportProvider creates and connects the client transport plus the
  // useChat adapter, and wraps its children in ably-js's ChannelProvider for
  // the same channel — the shell's presence avatars resolve it from there. It
  // must mount inside the ready gate: Providers only supplies the AblyProvider
  // context once its client exists.
  return (
    <ChatTransportProvider
      channelName={channelName}
      clientId={clientId}
    >
      <HydratedChat
        channelName={channelName}
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
