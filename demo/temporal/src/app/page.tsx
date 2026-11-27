'use client';

import { createChatTransport } from '@ably/ai-transport/vercel';
import { createClient, type PubSubClient } from '@ably/pubsub-device';
import { useChat } from '@ai-sdk/react';
import type { UIMessage } from 'ai';
import { type FormEvent, useEffect, useMemo, useState } from 'react';

import { channelNameOf } from '../shared/chat';

const textOf = (message: UIMessage): string =>
  message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');

function Chat({ client, chatId }: { client: PubSubClient; chatId: string }) {
  // The transport posts each turn to /api/chat, and reads the reply off the
  // chat's channel, where the relay publishes it.
  const transport = useMemo(
    () => createChatTransport({ channel: client.channels.get(channelNameOf(chatId)) }),
    [client, chatId],
  );
  useEffect(() => () => transport.close(), [transport]);
  const { messages, sendMessage, status, error } = useChat({ id: chatId, transport });
  const [input, setInput] = useState('');
  const busy = status === 'submitted' || status === 'streaming';

  const send = (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (text === '' || busy) return;
    setInput('');
    void sendMessage({ text });
  };

  return (
    <main>
      <header>
        <span>{channelNameOf(chatId)}</span>
        <span>{error ? 'the reply failed; send again' : busy ? 'streaming…' : 'ready'}</span>
      </header>
      <div className="messages">
        {messages.map((message) => (
          <div
            key={message.id}
            className={`message ${message.role}`}
          >
            {textOf(message)}
          </div>
        ))}
      </div>
      <form onSubmit={send}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Say something"
          disabled={busy}
          autoFocus
        />
        <button
          type="submit"
          disabled={busy || input.trim() === ''}
        >
          Send
        </button>
      </form>
    </main>
  );
}

export default function Home() {
  // The Ably client and the chat's id are made in an effect, so they exist
  // only in the browser, and the server render matches the first one.
  const [session, setSession] = useState<{ client: PubSubClient; chatId: string }>();
  useEffect(() => {
    const client = createClient({ authUrl: '/api/auth/ably-token' });
    setSession({ client, chatId: crypto.randomUUID().slice(0, 8) });
    return () => {
      client.close();
    };
  }, []);

  if (session === undefined) {
    return (
      <main>
        <header>
          <span>connecting…</span>
        </header>
      </main>
    );
  }
  return (
    <Chat
      client={session.client}
      chatId={session.chatId}
    />
  );
}
