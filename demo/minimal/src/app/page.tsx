'use client';

import { TransportProvider } from '@ably/ai-transport/react';
import { vercel } from '@ably/ai-transport/vercel';
import Ably from 'ably';
import { AblyProvider } from 'ably/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

import { Chat } from './chat';

function ChatPage() {
  // One channel per conversation. `?channel=<name>` pins it, so a second tab
  // opened at the same URL joins the same conversation; with no param, a name
  // is picked in the browser and put in the URL. Both the name and the Ably
  // client are created in effects, so the server render and the browser's
  // first render agree (a placeholder), and the client only exists in the
  // browser, where the token route gives it an identity and the capability
  // to use `ai:*` channels.
  const searchParams = useSearchParams();
  const router = useRouter();
  const [channelName, setChannelName] = useState(searchParams.get('channel') ?? undefined);
  const [client, setClient] = useState<Ably.Realtime>();

  useEffect(() => {
    if (channelName !== undefined) return;
    const name = `ai:${crypto.randomUUID().slice(0, 8)}`;
    setChannelName(name);
    router.replace(`?channel=${name}`);
  }, [channelName, router]);

  useEffect(() => {
    const realtime = new Ably.Realtime({ authUrl: '/api/auth/ably-token' });
    setClient(realtime);
    return () => {
      realtime.close();
    };
  }, []);

  if (client === undefined || channelName === undefined) {
    return (
      <main>
        <header>
          <span>connecting…</span>
        </header>
      </main>
    );
  }

  return (
    <AblyProvider client={client}>
      <TransportProvider
        channelName={channelName}
        codec={vercel}
      >
        <Chat channelName={channelName} />
      </TransportProvider>
    </AblyProvider>
  );
}

export default function Home() {
  return (
    <Suspense>
      <ChatPage />
    </Suspense>
  );
}
