'use client';

import { useRef, useEffect } from 'react';
import type { UIMessage } from 'ai';
import type { CodecMessage, RunInfo } from '@ably/ai-transport';
import { MessageBubble } from './message-bubble';

interface MessageListProps {
  /** Visible messages paired with their codec-message-ids. */
  messages: CodecMessage<UIMessage>[];
  hasOlder: boolean;
  loading: boolean;
  /** View lookup: which run (and so which publisher) a message belongs to. */
  runOf: (codecMessageId: string) => RunInfo | undefined;
  onLoadOlder: () => void;
}

export function MessageList({ messages, hasOlder, loading, runOf, onLoadOlder }: MessageListProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLastIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const lastId = messages.length > 0 ? messages[messages.length - 1].codecMessageId : undefined;
    if (lastId && lastId !== prevLastIdRef.current) {
      prevLastIdRef.current = lastId;
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el || !hasOlder || loading) return;
    if (el.scrollTop < 60) {
      onLoadOlder();
    }
  };

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 space-y-4 overflow-y-auto px-4 py-4"
    >
      {hasOlder && (
        <div className="text-center">
          <button
            onClick={onLoadOlder}
            disabled={loading}
            className="text-xs text-zinc-500 transition-colors hover:text-zinc-300 disabled:opacity-40"
          >
            {loading ? 'Loading...' : 'Load older messages'}
          </button>
        </div>
      )}
      {loading && <div className="animate-pulse text-center text-xs text-zinc-600">Loading history...</div>}
      {messages.map(({ codecMessageId, message }) => {
        const run = runOf(codecMessageId);
        const bubbleStatus = run?.status === 'active' ? 'streaming' : run?.status;
        return (
          <MessageBubble
            key={codecMessageId}
            message={message}
            clientId={run?.clientId || undefined}
            status={bubbleStatus}
          />
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
