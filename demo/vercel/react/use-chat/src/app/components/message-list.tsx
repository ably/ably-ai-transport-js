'use client';

import { useRef, useEffect } from 'react';
import type { UIMessage } from 'ai';
import type { BranchHandle, CodecMessage, RunInfo } from '@ably/ai-transport';
import { MessageBubble } from './message-bubble';
import { IntroCard } from './intro-card';

interface ViewLookupApi {
  branchSelection: (codecMessageId: string) => BranchHandle<UIMessage>;
  runOf: (codecMessageId: string) => RunInfo | undefined;
}

interface MessageListProps {
  // Visible messages paired with their codec-message-ids. View correlation
  // (runOf / branchSelection) keys on the codec-message-id;
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
  // Whether the view is "stuck" to the bottom. While true, new content
  // (including tokens streaming into the last message) keeps the latest output
  // in view so it stays in sync across tabs. Set false when the user scrolls
  // up, so we obey the scrollbar instead of yanking it back down.
  const pinnedToBottomRef = useRef(true);

  // Follow streaming output, not just new messages: this runs on every render
  // caused by a `messages` change, which includes tokens appended to the last
  // message. Only auto-scroll while pinned to the bottom.
  useEffect(() => {
    if (pinnedToBottomRef.current) {
      endRef.current?.scrollIntoView({ behavior: 'auto' });
    }
  }, [messages]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;

    // Re-pin once the user is within a small threshold of the bottom; unpin as
    // soon as they scroll away. The threshold absorbs sub-pixel rounding and
    // the scroll event fired by our own auto-scroll.
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedToBottomRef.current = distanceFromBottom < 80;

    if (hasOlder && !loading && el.scrollTop < 60) {
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
            errorMessage={run?.error?.message}
            hasSiblings={branch.hasSiblings}
            siblingCount={branch.hasSiblings ? branch.siblings.length : undefined}
            selectedIndex={branch.hasSiblings ? branch.index : undefined}
            onSelectSibling={branch.hasSiblings ? (index) => branch.select(index) : undefined}
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
