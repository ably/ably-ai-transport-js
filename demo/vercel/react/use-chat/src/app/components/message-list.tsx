'use client';

import type { UIEvent } from 'react';
import { Loader2Icon } from 'lucide-react';
import type { UIMessage } from 'ai';
import type { BranchHandle, CodecMessage, RunInfo } from '@ably/ai-transport';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller';
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
  // History pagination triggers only at the very top of the scrollback: the
  // reader has to scroll right up past the intro's start before the next page
  // is requested (never on open, and never while merely approaching the oldest
  // message). `loading` gates re-entrancy, and preserveScrollOnPrepend anchors
  // the reading position when the page lands, moving the viewport back off the
  // top edge.
  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    if (hasOlder && !loading && event.currentTarget.scrollTop < 60) {
      onLoadOlder();
    }
  };

  // Empty conversation: show the onboarding intro from the top in a plain
  // scroll container. The MessageScroller anchors to the newest message, which
  // would otherwise scroll the tall intro off-screen on an empty chat. The
  // scroller below only mounts once there are messages, so it opens at the
  // latest message on both a first send and history hydration.
  if (messages.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <IntroCard />
        {loading && <LoadingHistory />}
      </div>
    );
  }

  return (
    // autoScroll keeps the latest output in view while streaming and stops
    // following as soon as the reader scrolls up; preserveScrollOnPrepend keeps
    // the scroll anchored when an older page is prepended on scroll-up.
    <MessageScrollerProvider
      autoScroll
      defaultScrollPosition="end"
      scrollEdgeThreshold={60}
      scrollPreviousItemPeek={64}
    >
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport
          preserveScrollOnPrepend
          className="px-4 py-4"
          onScroll={handleScroll}
        >
          <MessageScrollerContent>
            {/* The demo walkthrough stays at the top of the scrollback, above
                the oldest loaded message, so it remains reachable mid-chat. */}
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
                // Anchor on the user's own turns (shadcn's convention): sending
                // pins the new prompt to the top of the viewport while the reply
                // streams in below it.
                <MessageScrollerItem
                  key={codecMessageId}
                  messageId={codecMessageId}
                  scrollAnchor={message.role === 'user'}
                >
                  <MessageBubble
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
                </MessageScrollerItem>
              );
            })}
          </MessageScrollerContent>
        </MessageScrollerViewport>

        <MessageScrollerButton
          direction="end"
          data-testid="scroll-to-latest"
        />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
