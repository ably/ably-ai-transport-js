'use client';

import { createClient, type PubSubClient } from '@ably/pubsub-device';
import { ChannelProvider, PubSubClientProvider } from '@ably/pubsub-device/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';

import { Chat, type StoredConversation } from '../chat';

/**
 * Read the conversation the server stored for a channel.
 * @param channelName - The channel.
 * @returns The stored entries and the serial the channel rewinds to.
 */
const loadConversation = async (channelName: string): Promise<StoredConversation> => {
  const res = await fetch(`/api/messages?channel=${encodeURIComponent(channelName)}`);
  if (!res.ok) throw new Error(`the server answered ${String(res.status)}`);

  return (await res.json()) as StoredConversation;
};

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
  // Counts the re-inits, so each one mounts a fresh Chat with a fresh decoder.
  const [generation, setGeneration] = useState(0);
  // Whether a re-init is in flight. The ref stops a second one from starting;
  // the state renders reconnecting… while the Chat is unmounted.
  const [reloading, setReloading] = useState(false);
  const reloadingRef = useRef(false);

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
        const conversation = await loadConversation(channelName);
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

  // The channel lost continuity, so the Chat unmounts, which unsubscribes its
  // decoder and closes its open replies, and the page starts again from the
  // store. Detaching first means the next attach always rewinds: a channel
  // that is still ATTACHED would not reattach for an unchanged serial, since
  // setting equal options does not reattach. The detach is best effort; it
  // rejects on a FAILED channel, which the next attach recovers from anyway.
  const reinit = useCallback(async () => {
    if (client === undefined || channelName === undefined || reloadingRef.current) return;

    reloadingRef.current = true;
    setReloading(true);
    try {
      try {
        await client.channels.get(channelName).detach();
      } catch (error) {
        console.error('detach failed', error);
      }

      const conversation = await loadConversation(channelName);
      setStored({ channelName, conversation });
      setGeneration((g) => g + 1);
    } catch (error) {
      console.error('reload failed', error);
      setFailed(channelName);
    } finally {
      reloadingRef.current = false;
      setReloading(false);
    }
  }, [client, channelName]);

  useEffect(() => {
    const pubsubClient = createClient({ authUrl: '/api/auth/ably-token' });
    setClient(pubsubClient);

    return () => {
      pubsubClient.close();
    };
  }, []);

  if (
    client === undefined ||
    channelName === undefined ||
    stored?.channelName !== channelName ||
    reloading ||
    failed === channelName
  ) {
    return (
      <main>
        <header>
          <span>
            {failed === channelName
              ? 'unable to load the conversation; reload to try again'
              : reloading
                ? 'reconnecting…'
                : 'connecting…'}
          </span>
        </header>
      </main>
    );
  }

  // The channel rewinds to the stored serial: on attach the platform delivers
  // every message after it through the ordinary subscription, then live
  // messages, in channel order. The serial itself is not replayed, and a
  // message that was appended to arrives first as one full-content update.
  // Rewind applies only when the channel attaches, so it is set here, before
  // the Chat below subscribes. When the channel loses continuity later, the
  // Chat calls reinit, which reads the store again and remounts the Chat
  // under a new key, so the channel rewinds from the newer serial.
  const { serial } = stored.conversation;

  return (
    <PubSubClientProvider client={client}>
      <ChannelProvider
        channelName={channelName}
        options={serial === undefined ? undefined : { params: { rewind: serial } }}
      >
        <Chat
          key={`${channelName}:${String(generation)}`}
          channelName={channelName}
          stored={stored.conversation.entries}
          onDiscontinuity={() => {
            // reinit catches its own failures and shows them in the header.
            void reinit();
          }}
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
