'use client';

import { useEffect, useRef } from 'react';
import type * as AI from 'ai';

import type { RunStatus } from '@ably/ai-transport';

import { MessageBubble } from './message-bubble';

/**
 * Per-message metadata projected from the view (mirrored from chat.tsx
 * — defined here so the bubble can read its run's status and step index
 * without prop-drilling individual fields).
 */
export interface MessageInfo {
  runId: string;
  runStatus: RunStatus;
  stepIndex: number | undefined;
}

interface MessageListProps {
  messages: readonly AI.UIMessage[];
  streamingId: string | undefined;
  info: ReadonlyMap<string, MessageInfo>;
  /**
   * The id of the assistant message that should render a Retry action.
   * Only set when no run is currently active and at least one terminated
   * assistant message exists.
   */
  retryableMessageId: string | undefined;
  /** Invoked when the Retry button is clicked. */
  onRetry: (messageId: string) => void;
}

export function MessageList({ messages, streamingId, info, retryableMessageId, onRetry }: MessageListProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const prevLastIdRef = useRef<string | undefined>(undefined);

  // Auto-scroll to bottom when the last message id changes.
  useEffect(() => {
    const lastId = messages.at(-1)?.id;
    if (lastId !== undefined && lastId !== prevLastIdRef.current) {
      prevLastIdRef.current = lastId;
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  return (
    <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
      {messages.length === 0 && (
        <p className="mt-20 text-center text-sm text-zinc-600">Send a message to start chatting.</p>
      )}
      {messages.map((message) => {
        const meta = info.get(message.id);
        return (
          <MessageBubble
            key={message.id}
            message={message}
            streaming={message.id === streamingId}
            runStatus={meta?.runStatus}
            stepIndex={meta?.stepIndex}
            onRetry={message.id === retryableMessageId ? () => onRetry(message.id) : undefined}
          />
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
