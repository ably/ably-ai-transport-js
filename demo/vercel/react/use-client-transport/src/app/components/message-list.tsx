'use client';

import { useRef, useEffect } from 'react';
import type { UIMessage, UIMessageChunk } from 'ai';
import type { ClientTransport } from '@ably/ai-transport';
import type { ConversationTreeHandle } from '@ably/ai-transport/react';
import { MessageBubble } from './message-bubble';

interface MessageListProps {
  messages: UIMessage[];
  transport: ClientTransport<UIMessageChunk, UIMessage>;
  tree: ConversationTreeHandle<UIMessage>;
  hasNext: boolean;
  loading: boolean;
  onNext: () => void;
  onRegenerate: (messageId: string) => void;
  onEdit: (messageId: string, newText: string) => void;
}

/**
 * Resolve the tree node ID for a UIMessage. The tree is keyed by
 * x-ably-msg-id (from transport headers), which may differ from
 * the UIMessage's .id field.
 */
function treeMsgId(msg: UIMessage, transport: ClientTransport<UIMessageChunk, UIMessage>): string {
  const headers = transport.getMessageHeaders(msg);
  return headers?.['x-ably-msg-id'] ?? msg.id;
}

export function MessageList({
  messages,
  transport,
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
    const lastId = messages.length > 0 ? messages[messages.length - 1].id : undefined;
    if (lastId && lastId !== prevLastIdRef.current) {
      prevLastIdRef.current = lastId;
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

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
      {messages.length === 0 && !loading && (
        <p className="text-sm text-zinc-600 text-center mt-20">Send a message to start chatting.</p>
      )}
      {messages.map((msg) => {
        const nodeId = treeMsgId(msg, transport);
        return (
          <MessageBubble
            key={msg.id}
            message={msg}
            headers={transport.getMessageHeaders(msg)}
            hasSiblings={tree.hasSiblings(nodeId)}
            siblings={tree.getSiblings(nodeId)}
            selectedIndex={tree.getSelectedIndex(nodeId)}
            onSelectSibling={(index) => tree.selectSibling(nodeId, index)}
            onRegenerate={msg.role === 'assistant' ? () => onRegenerate(nodeId) : undefined}
            onEdit={msg.role === 'user' ? (text) => onEdit(nodeId, text) : undefined}
          />
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
