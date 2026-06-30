'use client';

import { useEffect } from 'react';
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
        {loading ? (
          <div className="animate-pulse text-center text-xs text-muted-foreground">Loading history...</div>
        ) : (
          <p className="mt-20 text-center text-sm text-muted-foreground">Send a message to start chatting.</p>
        )}
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
            {loading && (
              <div className="animate-pulse text-center text-xs text-muted-foreground">Loading history...</div>
            )}

            {messages.map(({ codecMessageId, message }, idx) => {
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
              const isLast = idx === messages.length - 1;
              return (
                <MessageScrollerItem
                  key={codecMessageId}
                  messageId={codecMessageId}
                  scrollAnchor={isLast}
                >
                  <MessageBubble
                    message={message}
                    codecMessageId={codecMessageId}
                    clientId={run?.clientId || undefined}
                    runId={run?.runId}
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
