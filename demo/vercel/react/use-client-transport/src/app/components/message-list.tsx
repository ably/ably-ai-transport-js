'use client';

import { useRef, useEffect } from 'react';
import type { UIMessage } from 'ai';
import type { TreeNode } from '@ably/ai-transport';
import type { TreeHandle } from '@ably/ai-transport/react';
import { MessageBubble } from './message-bubble';

interface MessageListProps {
  nodes: TreeNode<UIMessage>[];
  tree: TreeHandle<UIMessage>;
  hasOlder: boolean;
  loading: boolean;
  onLoadOlder: () => void;
  onRegenerate: (messageId: string) => void;
  onEdit: (messageId: string, newText: string) => void;
}

export function MessageList({ nodes, tree, hasOlder, loading, onLoadOlder, onRegenerate, onEdit }: MessageListProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLastIdRef = useRef<string | undefined>(undefined);

  // Auto-scroll to bottom only when the last message changes
  useEffect(() => {
    const lastId = nodes.length > 0 ? nodes[nodes.length - 1].message.id : undefined;
    if (lastId && lastId !== prevLastIdRef.current) {
      prevLastIdRef.current = lastId;
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [nodes]);

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
      className="flex-1 overflow-y-auto px-4 py-4 space-y-4"
    >
      {hasOlder && (
        <div className="text-center">
          <button
            onClick={onLoadOlder}
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
          key={node.message.id}
          message={node.message}
          headers={node.headers}
          hasSiblings={tree.hasSiblings(node.msgId)}
          siblings={tree.getSiblings(node.msgId)}
          selectedIndex={tree.getSelectedIndex(node.msgId)}
          onSelectSibling={(index) => tree.select(node.msgId, index)}
          onRegenerate={node.message.role === 'assistant' ? () => onRegenerate(node.msgId) : undefined}
          onEdit={node.message.role === 'user' ? (text) => onEdit(node.msgId, text) : undefined}
        />
      ))}
      <div ref={endRef} />
    </div>
  );
}
