'use client';

import { useRef, useEffect } from 'react';
import type { UIMessage } from 'ai';
import type { ViewHandle } from '@ably/ai-transport/react';
import type { VercelEvent, VercelProjection } from '@ably/ai-transport/vercel';
import { MessageBubble } from './message-bubble';

interface MessageListProps {
  view: ViewHandle<VercelEvent, VercelProjection, UIMessage>;
  onRegenerate: (messageId: string) => void;
  onEdit: (messageId: string, newText: string) => void;
  onToolApprove?: (msgId: string, toolCallId: string, input: unknown) => void;
  onToolDeny?: (msgId: string, toolCallId: string, input: unknown) => void;
}

export function MessageList({ view, onRegenerate, onEdit, onToolApprove, onToolDeny }: MessageListProps) {
  const { messages, hasOlder, loading, loadOlder } = view;
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
    if (!el || !hasOlder || loading) return;
    if (el.scrollTop < 60) {
      onLoadOlder();
    }
  };

  const onLoadOlder = () => {
    void loadOlder();
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
      {messages.length === 0 && !loading && (
        <p className="text-sm text-zinc-600 text-center mt-20">Send a message to start chatting.</p>
      )}
      {messages.map((message) => {
        const owningRun = view.getRunByMsgId(message.id);
        // Use the msg-anchored branch-nav API so the arrow buttons attach to
        // the correct bubble: the user prompt for edits, the assistant for
        // regens. The runId-based hasSiblingRuns(runId) reports true for
        // every msg in a Run that's in a sibling group, which is too coarse.
        const hasSiblings = view.hasMessageSiblings(message.id);
        return (
          <MessageBubble
            key={message.id}
            message={message}
            owningRun={owningRun}
            hasSiblings={hasSiblings}
            siblings={hasSiblings ? view.getMessageSiblings(message.id) : []}
            selectedIndex={hasSiblings ? view.getSelectedMessageSiblingIndex(message.id) : 0}
            onSelectSibling={(index) => {
              view.selectMessageSibling(message.id, index);
            }}
            onRegenerate={message.role === 'assistant' ? () => onRegenerate(message.id) : undefined}
            onEdit={message.role === 'user' ? (text) => onEdit(message.id, text) : undefined}
            onToolApprove={onToolApprove}
            onToolDeny={onToolDeny}
          />
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
