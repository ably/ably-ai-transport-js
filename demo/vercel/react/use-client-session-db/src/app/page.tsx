'use client';

import { Providers, useAblyReady, SessionHooks } from './providers';
import { UIMessageCodec } from '@ably/ai-transport/vercel';
import type { UIMessage } from 'ai';
import { SeededChat } from './components/seeded-chat';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { generateChannelSlug, generateClientName } from './lib/channel-name';

const { ClientSessionProvider } = SessionHooks;

const CHANNEL_NAMESPACE = process.env.NEXT_PUBLIC_ABLY_CHANNEL_NAMESPACE ?? 'ai:';

const AGENT_API = 'api/chat';

/**
 * Fetch the persisted conversation, then mount the session and the seeded chat.
 * The seed is fetched before mount so the seam walk has it from the first
 * render. The agent persists every completed turn, so no per-request flag is
 * needed.
 */
function SeededChatWhenLoaded({ channelName }: { channelName: string }) {
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
      <div className="flex h-dvh items-center justify-center text-sm text-zinc-600">Loading saved conversation…</div>
    );
  }

  return (
    <ClientSessionProvider
      channelName={channelName}
      codec={UIMessageCodec}
    >
      <SeededChat
        chatId={channelName}
        seed={seed}
        api={AGENT_API}
      />
    </ClientSessionProvider>
  );
}

function ChatWhenReady({ channelName }: { channelName: string }) {
  const ready = useAblyReady();

  if (!ready) {
    return <div className="flex h-dvh items-center justify-center text-sm text-zinc-600">Connecting...</div>;
  }

  return <SeededChatWhenLoaded channelName={channelName} />;
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
      <ChatWhenReady channelName={channelName} />
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
