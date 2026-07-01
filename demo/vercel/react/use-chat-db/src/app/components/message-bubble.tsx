'use client';

import type { UIMessage, DynamicToolUIPart } from 'ai';
import { ToolInvocation } from './tool-invocation';

/** The live state of an assistant response, derived from useChat's status. */
export type MessageState = 'streaming' | 'completed' | 'error' | undefined;

interface MessageBubbleProps {
  /** The message to render. */
  message: UIMessage;
  /**
   * The response state for the last assistant message (streaming / error /
   * completed), or `undefined` for user messages and earlier assistant
   * messages. Drives the bubble border and the streaming caret.
   */
  state: MessageState;
  /** Approve a pending tool call by its approval id. */
  onToolApprove?: (approvalId: string) => void;
  /** Deny a pending tool call by its approval id. */
  onToolDeny?: (approvalId: string) => void;
}

function bubbleClasses(isUser: boolean, state: MessageState): string {
  const base = 'rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap';

  if (isUser) {
    return `${base} bg-zinc-800 text-zinc-100`;
  }

  if (state === 'streaming') {
    return `${base} bg-zinc-900 text-zinc-300 border border-amber-900/40`;
  }
  if (state === 'completed') {
    return `${base} bg-zinc-900 text-zinc-300 border border-emerald-900/40`;
  }
  if (state === 'error') {
    return `${base} bg-zinc-900 text-zinc-300 border border-red-900/40`;
  }
  return `${base} bg-zinc-900 text-zinc-300 border border-zinc-800`;
}

/**
 * A single chat bubble. Renders text and tool-invocation parts, the approval
 * card for approval-gated tools, and a streaming caret while the last assistant
 * response is in flight. This demo is linear (no branch navigation, edit, or
 * regenerate), so the bubble is a pure renderer with no per-message Run/branch
 * metadata.
 * @param props - The message, its live state, and the approval handlers.
 */
export function MessageBubble({ message, state, onToolApprove, onToolDeny }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className="max-w-[75%]">
        <div className={bubbleClasses(isUser, state)}>
          {message.parts.map((part, i) => {
            if (part.type === 'text') return <span key={i}>{part.text}</span>;
            if (part.type === 'dynamic-tool') {
              const toolPart = part as DynamicToolUIPart;
              // eslint-disable-next-line @typescript-eslint/no-empty-function -- no-op fallback when no approval handler
              const noop = (): void => {};
              const approvalId = toolPart.approval?.id;
              return (
                <ToolInvocation
                  key={i}
                  part={toolPart}
                  onApprove={onToolApprove && approvalId ? () => onToolApprove(approvalId) : noop}
                  onDeny={onToolDeny && approvalId ? () => onToolDeny(approvalId) : noop}
                />
              );
            }
            return null;
          })}
          {!isUser && state === 'streaming' && (
            <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-amber-500/60 animate-pulse rounded-sm align-text-bottom" />
          )}
        </div>
      </div>
    </div>
  );
}
