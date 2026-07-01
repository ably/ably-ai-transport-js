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
import { MessageBubble, type MessageState } from './message-bubble';
import { IntroCard } from './intro-card';

interface MessageListProps {
  /** The linear conversation to render (useChat's `messages`). */
  messages: UIMessage[];
  /**
   * The live state for a message at a given index — `streaming` / `error` /
   * `completed` for the last assistant message, `undefined` otherwise. Derived
   * from useChat's status by the Chat component.
   */
  stateOf: (message: UIMessage, index: number) => MessageState;
  /** Approve a pending tool call by its approval id. */
  onToolApprove?: (approvalId: string) => void;
  /** Deny a pending tool call by its approval id. */
  onToolDeny?: (approvalId: string) => void;
}

export function MessageList({ messages, stateOf, onToolApprove, onToolDeny }: MessageListProps) {
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
    // history pagination — the seam walk in useMessageSync loads prior history
    // once at hydration, so there is no load-older control.
    <MessageScrollerProvider
      autoScroll
      defaultScrollPosition="end"
      scrollEdgeThreshold={60}
      scrollPreviousItemPeek={64}
    >
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport className="px-4 py-4">
          <MessageScrollerContent data-testid="messages">
            {messages.map((message, index) => {
              const state = stateOf(message, index);
              return (
                // Anchor on the user's own turns (shadcn's convention): sending
                // pins the new prompt to the top of the viewport while the reply
                // streams in below it.
                <MessageScrollerItem
                  key={message.id}
                  messageId={message.id}
                  scrollAnchor={message.role === 'user'}
                >
                  <div
                    data-testid="message"
                    data-role={message.role}
                    data-id={message.id}
                    data-state={state}
                  >
                    <MessageBubble
                      message={message}
                      state={state}
                      onToolApprove={onToolApprove}
                      onToolDeny={onToolDeny}
                    />
                  </div>
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
