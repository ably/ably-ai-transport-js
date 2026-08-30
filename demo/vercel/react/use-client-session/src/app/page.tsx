'use client';

import {
  Providers,
  useAblyReady,
  SessionHooks,
  Chat,
  COMMON_SCENARIOS,
  generateChannelSlug,
  generateClientName,
  type Scenario,
} from '@ably-ai-demos/frontend';
import { OBJECT_MODES } from '@ably/ai-transport/react';
import { createUIMessageSessionCodec } from '@ably/ai-transport/vercel';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { ChecklistSlot } from './components/checklist-slot';

const { ClientSessionProvider } = SessionHooks;

const CHANNEL_NAMESPACE = process.env.NEXT_PUBLIC_ABLY_CHANNEL_NAMESPACE ?? 'ai:';
const uiMessageCodec = createUIMessageSessionCodec();

// Base scenarios plus the LiveObjects checklist entry this demo demonstrates.
// The base list is shared across demos; the checklist row is specific here. One
// scenario feeds both the intro card and the suggestion chip.
const DEMO_SCENARIOS: readonly Scenario[] = [
  ...COMMON_SCENARIOS.slice(0, 3),
  {
    id: 'checklist',
    tag: 'LiveObjects checklist',
    title: 'LiveObjects checklist',
    prompt: 'write me a short blog post about Ably — outline it, draft it, then tidy it up',
    blurb:
      'The assistant plans a task checklist in Ably LiveObjects and flips each step to done as it works. The widget below the chat renders the live progress and restores it on reload.',
  },
  ...COMMON_SCENARIOS.slice(3),
];

function ChatWhenReady({ channelName, clientId, limit }: { channelName: string; clientId?: string; limit?: number }) {
  const ready = useAblyReady();

  if (!ready) {
    return <div className="flex h-dvh items-center justify-center text-sm text-zinc-600">Connecting...</div>;
  }

  return (
    <ClientSessionProvider
      channelName={channelName}
      codec={uiMessageCodec}
      channelModes={OBJECT_MODES}
    >
      <Chat
        chatId={channelName}
        clientId={clientId}
        historyLimit={limit}
        api="api/chat"
        extraSlot={<ChecklistSlot />}
        scenarios={DEMO_SCENARIOS}
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
    <Providers
      clientId={clientId}
      liveObjects
    >
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
