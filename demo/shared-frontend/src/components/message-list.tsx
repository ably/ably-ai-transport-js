'use client';

import { useRef, useEffect } from 'react';
import type { UIMessage } from 'ai';
import type { BranchHandle, CodecMessage, RunInfo } from '@ably/ai-transport';
import { MessageBubble } from './message-bubble';
import { IntroCard, type DemoStep } from './intro-card';

interface ViewLookupApi {
  branchSelection: (codecMessageId: string) => BranchHandle<UIMessage>;
  runOf: (codecMessageId: string) => RunInfo | undefined;
}

interface MessageListProps {
  // Visible messages paired with their codec-message-ids. The list keys all
  // View correlation (runOf / branchSelection / edit / regenerate) on the
  // codec-message-id, never the domain `message.id`.
  messages: CodecMessage<UIMessage>[];
  hasOlder: boolean;
  loading: boolean;
  view: ViewLookupApi;
  onLoadOlder: () => void;
  onRegenerate: (codecMessageId: string) => void;
  onEdit: (codecMessageId: string, newText: string) => void;
  onToolApprove?: (codecMessageId: string, toolCallId: string) => void;
  onToolDeny?: (codecMessageId: string, toolCallId: string) => void;
  /**
   * Custom demo-scenario list shown by the pinned {@link IntroCard} when the
   * conversation is empty. Defaults to the shared UI's baseline list; each
   * demo can pass its own to swap in scenarios (e.g. the LiveObjects
   * checklist demo adds its own row).
   */
  demoSteps?: readonly DemoStep[];
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
  demoSteps,
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
      <IntroCard steps={demoSteps} />
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
      {messages.map(({ codecMessageId, message }) => {
        // Project the owning Run + branch-selection bundle into primitives
        // at this glue layer so the MessageBubble component stays free of
        // SDK type dependencies. The bundle is total — safe to destructure
        // for any message; non-anchor bubbles return `siblings = [message]`
        // (length 1) so the bubble's render condition uses `hasSiblings`.
        // All correlation keys on the codec-message-id, not `message.id`.
        const run = view.runOf(codecMessageId);
        const branch = view.branchSelection(codecMessageId);
        // Translate the literal Run lifecycle state to the bubble's
        // rendering vocabulary: `'active'` → `'streaming'`.
        const bubbleStatus = run?.status === 'active' ? 'streaming' : run?.status;
        // Surface the message's step alongside its run: a run.pipe reply has one
        // implicit step; show its id (the latest if a run ran several steps).
        const steps = run?.steps ?? [];
        const lastStep = steps[steps.length - 1];
        return (
          <MessageBubble
            key={codecMessageId}
            message={message}
            codecMessageId={codecMessageId}
            clientId={run?.clientId || undefined}
            runId={run?.runId}
            stepId={lastStep?.stepId}
            stepCount={steps.length}
            status={bubbleStatus}
            errorMessage={run?.error?.message}
            hasSiblings={branch.hasSiblings}
            siblingCount={branch.siblings.length}
            selectedIndex={branch.index}
            onSelectSibling={(index) => {
              branch.select(index);
            }}
            onRegenerate={message.role === 'assistant' ? () => onRegenerate(codecMessageId) : undefined}
            onEdit={message.role === 'user' ? (text) => onEdit(codecMessageId, text) : undefined}
            onToolApprove={onToolApprove}
            onToolDeny={onToolDeny}
          />
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
