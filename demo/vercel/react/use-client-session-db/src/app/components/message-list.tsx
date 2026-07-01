'use client';

import type { UIMessage } from 'ai';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller';
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
  // Empty conversation: show the onboarding intro from the top in a plain
  // scroll container. The MessageScroller anchors to the newest message, which
  // would otherwise scroll the tall intro off-screen; the scroller below only
  // mounts once there are messages.
  if (messages.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <IntroCard />
      </div>
    );
  }

  return (
    // autoScroll keeps the latest output in view while streaming and stops
    // following as soon as the reader scrolls up. This demo is linear with no
    // history pagination — the seam walk in useMessagesWithSeed loads prior
    // history once at hydration, so there is no load-older control.
    <MessageScrollerProvider
      autoScroll
      defaultScrollPosition="end"
      scrollEdgeThreshold={60}
      scrollPreviousItemPeek={64}
    >
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport className="px-4 py-4">
          <MessageScrollerContent data-testid="messages">
            {messages.map((message, index) => (
              // Anchor on the user's own turns (shadcn's convention): sending
              // pins the new prompt to the top of the viewport while the reply
              // streams in below it.
              <MessageScrollerItem
                key={message.id}
                messageId={message.id}
                scrollAnchor={message.role === 'user'}
              >
                <MessageBubble
                  message={message}
                  status={statusOf(message, index)}
                  onToolApprove={onToolApprove}
                  onToolDeny={onToolDeny}
                />
              </MessageScrollerItem>
            ))}
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
