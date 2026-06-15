'use client';

import { useRef, useEffect } from 'react';
import type { UIMessage } from 'ai';
import type { BranchSelection, CodecMessage, RunInfo } from '@ably/ai-transport';
import { MessageBubble } from './message-bubble';
import { IntroCard } from './intro-card';

interface ViewLookupApi {
  branchSelection: (codecMessageId: string) => BranchSelection<UIMessage>;
  selectSibling: (codecMessageId: string, index: number) => void;
  runOf: (codecMessageId: string) => RunInfo | undefined;
}

interface MessageListProps {
  // Visible messages paired with their codec-message-ids. View correlation
  // (runOf / branchSelection / selectSibling) keys on the codec-message-id;
  // useChat operations (regenerate / edit) key on the domain `message.id`,
  // which the ChatTransport maps back to the codec-message-id internally.
  messages: CodecMessage<UIMessage>[];
  hasOlder: boolean;
  loading: boolean;
  view: ViewLookupApi;
  onLoadOlder: () => void;
  onRegenerate: (messageId: string) => void;
  onEdit: (messageId: string, newText: string) => void;
  onToolApprove?: (approvalId: string) => void;
  onToolDeny?: (approvalId: string) => void;
}

export function MessageList({
  messages,
  hasOlder,
  loading,
  view,
  onLoadOlder,
  onRegenerate,
  onEdit,
  onToolApprove,
  onToolDeny,
}: MessageListProps) {
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
      className="flex-1 overflow-y-auto px-4 py-4 space-y-4"
    >
      <IntroCard />
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
      {messages.map(({ codecMessageId, message }) => {
        // View lookups key on the codec-message-id; useChat regenerate/edit
        // key on the domain `message.id` (the id useChat references).
        const run = view.runOf(codecMessageId);
        const branch = view.branchSelection(codecMessageId);
        const bubbleStatus = run?.status === 'active' ? 'streaming' : run?.status;
        return (
          <MessageBubble
            key={codecMessageId}
            message={message}
            clientId={run?.clientId || undefined}
            runId={run?.runId}
            status={bubbleStatus}
            hasSiblings={branch.hasSiblings}
            siblingCount={branch.hasSiblings ? branch.siblings.length : undefined}
            selectedIndex={branch.hasSiblings ? branch.index : undefined}
            onSelectSibling={branch.hasSiblings ? (index) => view.selectSibling(codecMessageId, index) : undefined}
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
