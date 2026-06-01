'use client';

import { useRef, useEffect } from 'react';
import type { UIMessage } from 'ai';
import type { BranchSelection, RunInfo } from '@ably/ai-transport';
import { MessageBubble } from './message-bubble';
import { IntroCard } from './intro-card';

interface ViewLookupApi {
  branchSelection: (codecMessageId: string) => BranchSelection<UIMessage>;
  selectSibling: (codecMessageId: string, index: number) => void;
  runOf: (codecMessageId: string) => RunInfo | undefined;
}

interface MessageListProps {
  messages: UIMessage[];
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
      {messages.map((message) => {
        const run = view.runOf(message.id);
        const branch = view.branchSelection(message.id);
        const bubbleStatus = run?.status === 'active' ? 'streaming' : run?.status;
        return (
          <MessageBubble
            key={message.id}
            message={message}
            clientId={run?.clientId || undefined}
            runId={run?.runId}
            status={bubbleStatus}
            hasSiblings={branch.hasSiblings}
            siblingCount={branch.hasSiblings ? branch.siblings.length : undefined}
            selectedIndex={branch.hasSiblings ? branch.index : undefined}
            onSelectSibling={branch.hasSiblings ? (index) => view.selectSibling(message.id, index) : undefined}
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
