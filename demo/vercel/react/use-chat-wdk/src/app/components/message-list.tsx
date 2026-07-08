'use client';

import type { UIMessage } from 'ai';
import type { CodecMessage, RunInfo } from '@ably/ai-transport';
import { useEffect, useRef } from 'react';

import { IntroCard } from './intro-card';
import { MessageBubble } from './message-bubble';

interface ViewLookupApi {
  /** Resolve the Run (and its steps) that owns a codec-message-id, for the badges. */
  runOf: (codecMessageId: string) => RunInfo | undefined;
}

interface MessageListProps {
  /** Visible messages paired with their codec-message-ids (View correlation keys on the codec-message-id). */
  messages: CodecMessage<UIMessage>[];
  hasOlder: boolean;
  loading: boolean;
  view: ViewLookupApi;
  onLoadOlder: () => void;
  onToolApprove?: (approvalId: string) => void;
  onToolDeny?: (approvalId: string) => void;
}

export function MessageList({
  messages,
  hasOlder,
  loading,
  view,
  onLoadOlder,
  onToolApprove,
  onToolDeny,
}: MessageListProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the view is "stuck" to the bottom. While true, streaming tokens keep
  // the latest output in view; set false when the user scrolls up.
  const pinnedToBottomRef = useRef(true);

  useEffect(() => {
    if (pinnedToBottomRef.current) {
      endRef.current?.scrollIntoView({ behavior: 'auto' });
    }
  }, [messages]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
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
      className="flex-1 space-y-4 overflow-y-auto px-4 py-4"
    >
      <IntroCard />
      {hasOlder && (
        <div className="text-center">
          <button
            onClick={onLoadOlder}
            disabled={loading}
            className="text-xs text-zinc-500 transition-colors hover:text-zinc-300 disabled:opacity-40"
          >
            {loading ? 'Loading...' : 'Load older messages'}
          </button>
        </div>
      )}
      {loading && <div className="animate-pulse text-center text-xs text-zinc-600">Loading history...</div>}
      {messages.map(({ codecMessageId, message }) => {
        const run = view.runOf(codecMessageId);
        const bubbleStatus = run?.status === 'active' ? 'streaming' : run?.status;
        // Show the message's canonical step: its id (the latest if a run ran
        // several) and how many physical attempts it took — a WDK retry adds one.
        const steps = run?.steps ?? [];
        const lastStep = steps[steps.length - 1];
        return (
          <MessageBubble
            key={codecMessageId}
            message={message}
            clientId={run?.clientId || undefined}
            runId={run?.runId}
            stepId={lastStep?.stepId}
            stepCount={steps.length}
            attemptCount={lastStep?.attemptCount ?? 1}
            status={bubbleStatus}
            errorMessage={run?.error?.message}
            onToolApprove={onToolApprove}
            onToolDeny={onToolDeny}
          />
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
