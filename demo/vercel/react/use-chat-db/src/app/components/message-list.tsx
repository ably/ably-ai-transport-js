'use client';

import { useRef, useEffect } from 'react';
import type { UIMessage } from 'ai';
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
      <ul
        data-testid="messages"
        className="space-y-4"
      >
        {messages.map((message, index) => {
          const state = stateOf(message, index);
          return (
            <li
              key={message.id}
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
            </li>
          );
        })}
      </ul>
      <div ref={endRef} />
    </div>
  );
}
