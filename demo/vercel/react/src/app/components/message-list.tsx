'use client';

import { useEffect, useRef } from 'react';
import type * as AI from 'ai';

import type { RunStatus, StepStatus } from '@ably/ai-transport';

import { MessageBubble } from './message-bubble';

/**
 * Per-message metadata projected from the view (mirrored from chat.tsx
 * — defined here so the bubble can read its step's status, step index,
 * and canonical flag without prop-drilling individual fields).
 */
export interface MessageInfo {
  runId: string;
  runStatus: RunStatus;
  /**
   * Status of the step that produced this message, read from
   * `node.step?.status`. Drives the per-bubble status pill so each step
   * carries its own header rather than mirroring the run-level status
   * across every iteration. Undefined for messages without a stepId
   * (user messages and other client publishes outside any step).
   */
  stepStatus: StepStatus | undefined;
  stepIndex: number | undefined;
  /**
   * Whether this message contributes to the run's current state. `false`
   * for failed/aborted/abandoned predecessors of a retry — the SDK keeps
   * them in the projection so the UI can render them as history rather
   * than dropping them. Spec: AIT-CN2.
   */
  canonical: boolean;
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
            stepStatus={meta?.stepStatus}
            stepIndex={meta?.stepIndex}
            canonical={meta?.canonical ?? true}
            onRetry={message.id === retryableMessageId ? () => onRetry(message.id) : undefined}
          />
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
