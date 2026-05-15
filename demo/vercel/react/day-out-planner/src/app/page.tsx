'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { UIMessageCodec } from '@ably/ai-transport/vercel';
import { Providers, useAblyReady, SessionHooks } from './providers';
import { useName } from './hooks/use-name';
import { NameModal } from './components/name-modal';
import { Planner } from './components/planner';

const { ClientSessionProvider } = SessionHooks;

const DEFAULT_CHANNEL = process.env.NEXT_PUBLIC_ABLY_CHANNEL ?? 'day-out-planner:demo';

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
  const { name, ready, setName, clearName } = useName();

  if (!ready) {
    return <div className="flex h-dvh items-center justify-center text-sm text-zinc-600" />;
  }

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
