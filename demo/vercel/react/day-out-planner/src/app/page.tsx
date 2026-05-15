'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { UIMessageCodec } from '@ably/ai-transport/vercel';
import { Providers, useAblyReady, SessionHooks } from './providers';
import { useName } from './hooks/use-name';
import { NameModal } from './components/name-modal';
import { Planner } from './components/planner';

const { ClientSessionProvider } = SessionHooks;

// The chat channel must live under the `ai:` namespace so Ably's mutable-message
// support (which the AI Transport SDK relies on) is enabled — without this you
// get "Can only update/delete/append messages on channels with mutableMessages
// enabled" (code 93002).
const DEFAULT_CHANNEL = process.env.NEXT_PUBLIC_ABLY_CHANNEL ?? 'ai:day-out-planner:demo';

function PlannerWhenReady({
  channelName,
  name,
  onChangeName,
}: {
  channelName: string;
  name: string;
  onChangeName: () => void;
}) {
  const ready = useAblyReady();

  if (!ready) {
    return <div className="flex h-dvh items-center justify-center text-sm text-zinc-600">Connecting...</div>;
  }

  return (
    <ClientSessionProvider
      channelName={channelName}
      codec={UIMessageCodec}
      clientId={name}
      api="api/chat"
      body={() => ({ sessionName: channelName })}
    >
      <Planner
        channelName={channelName}
        name={name}
        onChangeName={onChangeName}
      />
    </ClientSessionProvider>
  );
}

function PlannerPage() {
  const searchParams = useSearchParams();
  const channelName = searchParams.get('channel') ?? DEFAULT_CHANNEL;
  const userParam = searchParams.get('user') ?? undefined;
  const { name, setName, clearName } = useName(userParam);

  if (!name) {
    return <NameModal onSubmit={setName} />;
  }

  return (
    <Providers clientId={name}>
      <PlannerWhenReady
        channelName={channelName}
        name={name}
        onChangeName={clearName}
      />
    </Providers>
  );
}

export default function Home() {
  return (
    <Suspense>
      <PlannerPage />
    </Suspense>
  );
}
