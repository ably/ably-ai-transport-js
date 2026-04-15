'use client';

import { useRef, useEffect } from 'react';
import type { ViewHandle } from '@ably/ai-transport/react';
import type { AgentCodecEvent, AgentMessage } from '@ably/ai-transport/anthropic';
import { MessageBubble } from './message-bubble';

interface MessageListProps {
  view: ViewHandle<AgentCodecEvent, AgentMessage>;
}

export function MessageList({ view }: MessageListProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(0);

  const { nodes, hasOlder, loading, loadOlder } = view;

  // Auto-scroll when new messages arrive
  useEffect(() => {
    if (nodes.length > prevCountRef.current) {
      prevCountRef.current = nodes.length;
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [nodes]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el || !hasOlder || loading) return;
    if (el.scrollTop < 60) {
      void loadOlder();
    }
  };

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto px-4 py-4 space-y-4"
    >
      {hasOlder && (
        <div className="text-center">
          <button
            onClick={() => void loadOlder()}
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
      {nodes.map((node) => (
        <MessageBubble
          key={node.msgId}
          message={node.message}
          headers={node.headers}
        />
      ))}
      <div ref={endRef} />
    </div>
  );
}
