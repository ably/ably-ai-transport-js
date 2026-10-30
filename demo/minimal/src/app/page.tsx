'use client';

import { createClient, type PubSubClient } from '@ably/pubsub-device';
import { ChannelProvider, PubSubClientProvider } from '@ably/pubsub-device/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

import { Chat, type StoredConversation } from './chat';

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
  const [client, setClient] = useState<PubSubClient>();
  // The conversation the server stored for the channel, read before the
  // channel is mounted: its serial is where the channel rewinds to.
  const [stored, setStored] = useState<{ channelName: string; conversation: StoredConversation }>();
  // A load that failed, for the channel it was for, so the page says so rather
  // than staying on connecting….
  const [failed, setFailed] = useState<string>();

  useEffect(() => {
    if (channelName !== undefined) return;
    const name = `ai:${crypto.randomUUID().slice(0, 8)}`;
    setChannelName(name);
    router.replace(`?channel=${name}`);
  }, [channelName, router]);

  useEffect(() => {
    if (channelName === undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/messages?channel=${encodeURIComponent(channelName)}`);
        if (!res.ok) throw new Error(`the server answered ${String(res.status)}`);
        const conversation = (await res.json()) as StoredConversation;
        if (!cancelled) setStored({ channelName, conversation });
      } catch (error) {
        if (cancelled) return;
        console.error('load failed', error);
        setFailed(channelName);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channelName]);

  useEffect(() => {
    const pubsubClient = createClient({ authUrl: '/api/auth/ably-token' });
    setClient(pubsubClient);
    return () => {
      pubsubClient.close();
    };
  }, []);

  if (client === undefined || channelName === undefined || stored?.channelName !== channelName) {
    return (
      <main>
        <header>
          <span>{failed === channelName ? 'unable to load the conversation; reload to try again' : 'connecting…'}</span>
        </header>
      </main>
    );
  }

  // The channel rewinds to the stored serial: on attach the platform delivers
  // every message after it through the ordinary subscription, then live
  // messages, in channel order. The serial itself is not replayed, and a
  // message that was appended to arrives first as one full-content update.
  // Rewind applies only when the channel attaches, so it is set here, before
  // the Chat below subscribes.
  const { serial } = stored.conversation;
  return (
    <PubSubClientProvider client={client}>
      <ChannelProvider
        channelName={channelName}
        options={serial === undefined ? undefined : { params: { rewind: serial } }}
      >
        <Chat
          key={channelName}
          channelName={channelName}
          stored={stored.conversation.messages}
        />
      </ChannelProvider>
    </PubSubClientProvider>
  );
}

export default function Home() {
  return (
    <Suspense>
      <ChatPage />
    </Suspense>
  );
}
