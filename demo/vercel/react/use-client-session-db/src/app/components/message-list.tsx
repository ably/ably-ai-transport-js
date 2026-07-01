'use client';

import { useRef, useEffect } from 'react';
import type { UIMessage } from 'ai';
import { MessageBubble } from './message-bubble';
import { IntroCard } from './intro-card';

/** The bubble-rendering vocabulary for an assistant message's owning run. */
export type BubbleStatus = 'streaming' | 'complete' | 'cancelled' | 'error' | 'suspended';

interface MessageListProps {
  /**
   * The composed, linear conversation (seed ⧺ live channel tail). Rendered in
   * order; no branch navigation or codec-message-id correlation — this demo is
   * deliberately linear (see `Chat`).
   */
  messages: UIMessage[];
  /**
   * Resolve the bubble status for a rendered message. Only assistant messages
   * carry a status; the last one reflects the latest run's live state (see
   * `Chat`). Returns `undefined` when no status should be shown.
   */
  statusOf: (message: UIMessage, index: number) => BubbleStatus | undefined;
  /**
   * Approve a pending tool call, addressed by its `toolCallId`. `Chat` maps
   * the id back to the owning assistant's codec-message-id and publishes the
   * approval on the channel.
   */
  onToolApprove?: (toolCallId: string) => void;
  /** Deny a pending tool call, addressed by its `toolCallId`. */
  onToolDeny?: (toolCallId: string) => void;
}

export function MessageList({ messages, statusOf, onToolApprove, onToolDeny }: MessageListProps) {
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
  };

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto px-4 py-4 space-y-4"
    >
      <IntroCard />
      {messages.length === 0 && (
        <p className="text-sm text-zinc-600 text-center mt-20">Send a message to start chatting.</p>
      )}
      {messages.map((message, index) => (
        <MessageBubble
          key={message.id}
          message={message}
          status={statusOf(message, index)}
          onToolApprove={onToolApprove}
          onToolDeny={onToolDeny}
        />
      ))}
      <div ref={endRef} />
    </div>
  );
}
