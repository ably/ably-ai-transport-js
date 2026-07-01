'use client';

import type { UIMessage, DynamicToolUIPart } from 'ai';
import { ToolInvocation } from './tool-invocation';
import type { BubbleStatus } from './message-list';

interface MessageBubbleProps {
  /** The message to render. */
  message: UIMessage;
  /**
   * Bubble status for assistant messages — `'streaming'` renders the caret and
   * amber border, terminal statuses colour the border. `undefined` for user
   * messages and un-tracked assistant messages.
   */
  status: BubbleStatus | undefined;
  /** Approve a pending tool call, addressed by its `toolCallId`. */
  onToolApprove?: (toolCallId: string) => void;
  /** Deny a pending tool call, addressed by its `toolCallId`. */
  onToolDeny?: (toolCallId: string) => void;
}

function bubbleClasses(isUser: boolean, status: BubbleStatus | undefined): string {
  const base = 'rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap';

  if (isUser) {
    return `${base} bg-zinc-800 text-zinc-100`;
  }

  if (status === 'streaming') {
    return `${base} bg-zinc-900 text-zinc-300 border border-amber-900/40`;
  }
  if (status === 'complete') {
    return `${base} bg-zinc-900 text-zinc-300 border border-emerald-900/40`;
  }
  if (status === 'cancelled' || status === 'error') {
    return `${base} bg-zinc-900 text-zinc-300 border border-red-900/40`;
  }
  return `${base} bg-zinc-900 text-zinc-300 border border-zinc-800`;
}

export function MessageBubble({ message, status, onToolApprove, onToolDeny }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className="max-w-[75%]">
        <div className={bubbleClasses(isUser, status)}>
          {message.parts.map((part, i) => {
            if (part.type === 'text') return <span key={i}>{part.text}</span>;
            if (part.type === 'dynamic-tool') {
              const toolPart = part as DynamicToolUIPart;
              // eslint-disable-next-line @typescript-eslint/no-empty-function -- no-op fallback when no approval handler
              const noop = (): void => {};
              return (
                <ToolInvocation
                  key={i}
                  part={toolPart}
                  onApprove={onToolApprove ? () => onToolApprove(toolPart.toolCallId) : noop}
                  onDeny={onToolDeny ? () => onToolDeny(toolPart.toolCallId) : noop}
                />
              );
            }
            return null;
          })}
          {!isUser && status === 'streaming' && (
            <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-amber-500/60 animate-pulse rounded-sm align-text-bottom" />
          )}
        </div>
      </div>
    </div>
  );
}
