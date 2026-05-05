'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

import { resolveSessionName } from './helpers';
import { ChatBootstrap } from './providers';
import { Chat } from './components/chat';

const DEFAULT_SESSION = process.env.NEXT_PUBLIC_ABLY_SESSION ?? 'demo-session';
const NAMESPACE = process.env.NEXT_PUBLIC_ABLY_NAMESPACE;

function ChatPage() {
  const searchParams = useSearchParams();
  const baseName = searchParams.get('session') ?? DEFAULT_SESSION;
  const clientId = searchParams.get('clientId') ?? undefined;
  const sessionName = resolveSessionName(baseName, NAMESPACE);

  return (
    <ChatBootstrap
      sessionName={sessionName}
      clientId={clientId}
    >
      {(handle) => (
        <Chat
          handle={handle}
          clientId={clientId}
        />
      )}
    </ChatBootstrap>
  );
}

export default function Home() {
  return (
    <Suspense>
      <ChatPage />
    </Suspense>
  );
}
