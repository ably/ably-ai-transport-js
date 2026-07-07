'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { ArrowDownIcon } from 'lucide-react';
import type { UIMessage } from 'ai';
import { Button } from '@/components/ui/button';
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
  /**
   * Receives a "snap to the live edge" callback while the transcript is
   * mounted; the composer calls it on send.
   */
  scrollToEndRef: RefObject<(() => void) | null>;
}

export function MessageList({ messages, statusOf, onToolApprove, onToolDeny, scrollToEndRef }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the transcript is stuck to the bottom. While true, streamed output
  // keeps the latest content in view. It is released ONLY when the reader
  // scrolls up (a decrease in scrollTop), never by content growing below: a
  // tall block (a forecast table, a tool card) landing in one emission grows
  // scrollHeight without moving scrollTop, and must not read as "scrolled away".
  const pinnedToBottomRef = useRef(true);
  // The scrollTop seen on the previous scroll event, used to tell a reader
  // scrolling up (scrollTop decreased) from content growing below (unchanged).
  const lastScrollTopRef = useRef(0);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Follow streamed output, not just new messages: this runs on every render
  // caused by a `messages` change — tokens appended to the newest message and
  // tool parts changing state anywhere in the transcript (an approval's output
  // card can land on an earlier message). Only auto-scroll while pinned.
  useEffect(() => {
    if (pinnedToBottomRef.current) scrollToBottom();
  }, [messages, scrollToBottom]);

  // Publish "snap to the live edge" for the composer: sending re-pins and jumps
  // to the bottom, wherever the reader was.
  useEffect(() => {
    scrollToEndRef.current = () => {
      pinnedToBottomRef.current = true;
      setShowJumpToLatest(false);
      scrollToBottom();
    };
    return () => {
      scrollToEndRef.current = null;
    };
  }, [scrollToEndRef, scrollToBottom]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const scrolledUp = el.scrollTop < lastScrollTopRef.current;
    lastScrollTopRef.current = el.scrollTop;

    // Re-pin whenever the reader is at the bottom; release the pin only when
    // they deliberately scroll up. The 80px threshold absorbs sub-pixel
    // rounding and the scroll event fired by our own auto-scroll.
    if (distanceFromBottom < 80) {
      pinnedToBottomRef.current = true;
    } else if (scrolledUp) {
      pinnedToBottomRef.current = false;
    }
    setShowJumpToLatest(!pinnedToBottomRef.current);
  };

  // Empty conversation: show the onboarding intro from the top. Kept rendered
  // once messages have existed so a transient empty re-emission mid-flow does
  // not flash the intro-only state back in.
  const [hadMessages, setHadMessages] = useState(false);
  if (messages.length > 0 && !hadMessages) setHadMessages(true);
  if (messages.length === 0 && !hadMessages) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <IntroCard />
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        data-testid="message-viewport"
        className="scroll-fade-b min-h-0 flex-1 overflow-y-auto scrollbar-thin scrollbar-gutter-stable px-4 py-4"
      >
        <div
          data-testid="messages"
          className="flex flex-col gap-6"
        >
          {/* The demo walkthrough stays at the top of the scrollback, above the
              first message, so it remains reachable mid-chat. */}
          <IntroCard />
          {messages.map((message, index) => (
            <MessageBubble
              key={message.id}
              message={message}
              status={statusOf(message, index)}
              onToolApprove={onToolApprove}
              onToolDeny={onToolDeny}
            />
          ))}
        </div>
      </div>

      {showJumpToLatest && (
        <Button
          type="button"
          variant="secondary"
          size="icon-sm"
          onClick={() => {
            pinnedToBottomRef.current = true;
            setShowJumpToLatest(false);
            scrollToBottom();
          }}
          data-testid="scroll-to-latest"
          aria-label="Scroll to latest"
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-border shadow-md"
        >
          <ArrowDownIcon />
        </Button>
      )}
    </div>
  );
}
