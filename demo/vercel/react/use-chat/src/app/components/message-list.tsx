'use client';

import { useEffect } from 'react';
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
  useMessageScrollerVisibility,
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

// Reaching the top of the conversation triggers history pagination. The
// MessageScroller has no onReachStart hook, so watch its visibility state:
// once the oldest visible message scrolls into view, ask for an older page.
// `loading` gates re-entrancy, and the oldest id changes after a prepend, so
// the same page is never requested twice.
function AutoLoadOlder({
  oldestId,
  hasOlder,
  loading,
  onLoadOlder,
}: {
  oldestId: string | undefined;
  hasOlder: boolean;
  loading: boolean;
  onLoadOlder: () => void;
}) {
  const { visibleMessageIds } = useMessageScrollerVisibility();
  useEffect(() => {
    if (hasOlder && !loading && oldestId && visibleMessageIds.includes(oldestId)) {
      onLoadOlder();
    }
  }, [visibleMessageIds, oldestId, hasOlder, loading, onLoadOlder]);
  return null;
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
  const oldestId = messages[0]?.codecMessageId;

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
        >
          <MessageScrollerContent>
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
        <AutoLoadOlder
          oldestId={oldestId}
          hasOlder={hasOlder}
          loading={loading}
          onLoadOlder={onLoadOlder}
        />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
