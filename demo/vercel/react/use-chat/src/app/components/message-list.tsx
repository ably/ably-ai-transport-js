'use client';

import { useRef, useEffect } from 'react';
import type { UIMessage } from 'ai';
import type { ConversationNode } from '@ably/ai-transport';
import { MessageBubble } from './message-bubble';

interface MessageListProps {
  nodes: ConversationNode<UIMessage>[];
  hasNext: boolean;
  loading: boolean;
  onNext: () => void;
  onRegenerate: (messageId: string) => void;
}

export function MessageList({ nodes, hasNext, loading, onNext, onRegenerate }: MessageListProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLastIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const lastId = nodes.length > 0 ? nodes[nodes.length - 1].message.id : undefined;
    if (lastId && lastId !== prevLastIdRef.current) {
      prevLastIdRef.current = lastId;
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [nodes]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el || !hasNext || loading) return;
    if (el.scrollTop < 60) {
      onNext();
    }
  };

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto px-4 py-4 space-y-4"
    >
      {hasNext && (
        <div className="text-center">
          <button
            onClick={onNext}
            disabled={loading}
            className="text-xs text-zinc-500 hover:text-zinc-300 disabled:opacity-40 transition-colors"
          >
            {loading ? 'Loading...' : 'Load older messages'}
          </button>
        </div>
      )}
      {loading && <div className="text-center text-xs text-zinc-600 animate-pulse">Loading history...</div>}
      {nodes.length === 0 && !loading && (
        <p className="text-sm text-zinc-600 text-center mt-20">Send a message to start chatting.</p>
      )}
      {nodes.map(({ message, headers }) => (
        <MessageBubble
          key={message.id}
          message={message}
          headers={headers}
          onRegenerate={message.role === 'assistant' ? () => onRegenerate(message.id) : undefined}
        />
      ))}
      <div ref={endRef} />
    </div>
  );
}
