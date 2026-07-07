'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { ArrowDownIcon, Loader2Icon } from 'lucide-react';
import type { UIMessage } from 'ai';
import type { BranchHandle, CodecMessage, RunInfo } from '@ably/ai-transport';
import { Button } from '@/components/ui/button';
import { MessageBubble } from './message-bubble';
import { IntroCard } from './intro-card';

interface ViewLookupApi {
  branchSelection: (codecMessageId: string) => BranchHandle<UIMessage>;
  runOf: (codecMessageId: string) => RunInfo | undefined;
}

// Quiet spinner shown while an older history page is loading.
function LoadingHistory() {
  return (
    <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
      <Loader2Icon className="size-3.5 animate-spin" />
      Loading history…
    </div>
  );
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
  // Receives a "snap to the live edge" callback while the transcript is
  // mounted; the composer calls it on send.
  scrollToEndRef: RefObject<(() => void) | null>;
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
  scrollToEndRef,
}: MessageListProps) {
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

    // History pagination triggers only at the very top of the scrollback: the
    // reader has to scroll right up past the intro's start before the next page
    // is requested (never on open). `loading` gates re-entrancy.
    if (hasOlder && !loading && el.scrollTop < 60) {
      onLoadOlder();
    }
  };

  // Empty conversation: show the onboarding intro from the top. Kept rendered
  // once messages have existed so a transient empty re-emission mid-flow (the
  // useChat↔useView churn) does not flash the intro-only state back in.
  const [hadMessages, setHadMessages] = useState(false);
  if (messages.length > 0 && !hadMessages) setHadMessages(true);
  if (messages.length === 0 && !hadMessages) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <IntroCard />
        {loading && <LoadingHistory />}
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
              oldest loaded message, so it remains reachable mid-chat. */}
          <IntroCard />
          {hasOlder && (
            <div className="text-center">
              <Button
                variant="ghost"
                size="xs"
                onClick={onLoadOlder}
                disabled={loading}
                data-testid="load-older"
                className="text-muted-foreground"
              >
                {loading ? 'Loading...' : 'Load older messages'}
              </Button>
            </div>
          )}
          {loading && <LoadingHistory />}

          {messages.map(({ codecMessageId, message }) => {
            // View lookups key on the codec-message-id; useChat regenerate/edit
            // key on the domain `message.id` (the id useChat references).
            const run = view.runOf(codecMessageId);
            const branch = view.branchSelection(codecMessageId);
            const bubbleStatus = run?.status === 'active' ? 'streaming' : run?.status;
            // Surface the message's step alongside its run: the latest step id
            // (with a +N count when the run ran several).
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
