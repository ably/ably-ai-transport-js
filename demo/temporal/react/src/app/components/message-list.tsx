'use client';

import { useEffect, useRef } from 'react';
import type * as AI from 'ai';

import { MessageBubble } from './message-bubble';

interface MessageListProps {
  messages: readonly AI.UIMessage[];
  streamingId: string | undefined;
}

export function MessageList({ messages, streamingId }: MessageListProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const prevLastIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const lastId = messages.at(-1)?.id;
    if (lastId !== undefined && lastId !== prevLastIdRef.current) {
      prevLastIdRef.current = lastId;
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  return (
    <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
      {messages.length === 0 && (
        <p className="mt-20 text-center text-sm text-zinc-600">Send a message to start chatting.</p>
      )}
      {messages.map((message) => (
        <MessageBubble
          key={message.id}
          message={message}
          streaming={message.id === streamingId}
        />
      ))}
      <div ref={endRef} />
    </div>
  );
}
