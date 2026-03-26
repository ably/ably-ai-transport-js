'use client';

import { useRef, useEffect } from 'react';
import type { UIMessage } from 'ai';
import type { MessageWithHeaders } from '@ably/ai-transport';
import type { ConversationTreeHandle } from '@ably/ai-transport/react';
import { MessageBubble } from './message-bubble';

interface MessageListProps {
  messagesWithHeaders: MessageWithHeaders<UIMessage>[];
  tree: ConversationTreeHandle<UIMessage>;
  hasNext: boolean;
  loading: boolean;
  onNext: () => void;
  onRegenerate: (messageId: string) => void;
  onEdit: (messageId: string, newText: string) => void;
}

export function MessageList({
  messagesWithHeaders,
  tree,
  hasNext,
  loading,
  onNext,
  onRegenerate,
  onEdit,
}: MessageListProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLastIdRef = useRef<string | undefined>(undefined);

  // Auto-scroll to bottom only when the last message changes
  useEffect(() => {
    const lastId =
      messagesWithHeaders.length > 0 ? messagesWithHeaders[messagesWithHeaders.length - 1].message.id : undefined;
    if (lastId && lastId !== prevLastIdRef.current) {
      prevLastIdRef.current = lastId;
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messagesWithHeaders]);

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
      {messagesWithHeaders.length === 0 && !loading && (
        <p className="text-sm text-zinc-600 text-center mt-20">Send a message to start chatting.</p>
      )}
      {messagesWithHeaders.map(({ message, headers }) => {
        const msgId = headers!['x-ably-msg-id'];
        return (
          <MessageBubble
            key={message.id}
            message={message}
            headers={headers}
            hasSiblings={tree.hasSiblings(msgId)}
            siblings={tree.getSiblings(msgId)}
            selectedIndex={tree.getSelectedIndex(msgId)}
            onSelectSibling={(index) => tree.selectSibling(msgId, index)}
            onRegenerate={message.role === 'assistant' ? () => onRegenerate(msgId) : undefined}
            onEdit={message.role === 'user' ? (text) => onEdit(msgId, text) : undefined}
          />
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
