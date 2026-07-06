'use client';

import { isToolUIPart, type UIMessage } from 'ai';
import { Loader2Icon } from 'lucide-react';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Message, MessageContent } from '@/components/ui/message';
import { Response } from '@/components/ui/response';
import { ToolInvocation } from './tool-invocation';
import { cn } from '@/lib/utils';

/** The live state of an assistant response, derived from useChat's status. */
export type MessageState = 'streaming' | 'completed' | 'error' | undefined;

interface MessageBubbleProps {
  /** The message to render. */
  message: UIMessage;
  /**
   * The response state for the last assistant message (streaming / error /
   * completed), or `undefined` for user messages and earlier assistant
   * messages. Drives the streaming "Thinking…" placeholder.
   */
  state: MessageState;
  /** Approve a pending tool call by its approval id. */
  onToolApprove?: (approvalId: string) => void;
  /** Deny a pending tool call by its approval id. */
  onToolDeny?: (approvalId: string) => void;
}

/**
 * A single chat bubble. Renders text and tool-invocation parts, the approval
 * card for approval-gated tools, and a quiet "Thinking…" loader while the last
 * assistant response is streaming with no content yet. This demo is linear (no
 * branch navigation, edit, or regenerate), so the bubble is a pure renderer.
 * @param props - The message, its live state, and the approval handlers.
 */
export function MessageBubble({ message, state, onToolApprove, onToolDeny }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  const messageText = message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
  const hasToolParts = message.parts.some((p) => isToolUIPart(p));
  // Assistant turn that is streaming but has produced no text or tool activity
  // yet — show a quiet loader instead of an empty row.
  const showThinking = !isUser && state === 'streaming' && messageText.trim() === '' && !hasToolParts;

  // The assistant's boxed bubble carries a state-tinted border: amber while
  // streaming, green once completed, red on error. The classes target the
  // Bubble's content slot (the element its variants paint), so they must carry
  // the same `*:data-[slot=…]` prefix to override.
  const assistantBorder =
    state === 'streaming'
      ? '*:data-[slot=bubble-content]:border-amber-900/40'
      : state === 'completed'
        ? '*:data-[slot=bubble-content]:border-emerald-900/40'
        : state === 'error'
          ? '*:data-[slot=bubble-content]:border-red-900/40'
          : '*:data-[slot=bubble-content]:border-zinc-800';

  return (
    <Message align={isUser ? 'end' : 'start'}>
      {/* Shrink-wrap the turn so the bubble hugs its content, capped at 75%. */}
      <MessageContent className="w-fit max-w-[75%] gap-1.5">
        {/* The user's turn is a filled bubble; the assistant reply is a boxed
            bubble whose border reflects the response state. */}
        <Bubble
          variant={isUser ? 'default' : 'outline'}
          align={isUser ? 'end' : 'start'}
          className={cn(
            'w-full max-w-full',
            isUser
              ? ['*:data-[slot=bubble-content]:bg-zinc-800', '*:data-[slot=bubble-content]:text-zinc-100']
              : [
                  '*:data-[slot=bubble-content]:bg-zinc-900',
                  '*:data-[slot=bubble-content]:text-zinc-300',
                  assistantBorder,
                ],
          )}
        >
          {isUser ? (
            <BubbleContent className="w-full whitespace-pre-wrap">{messageText}</BubbleContent>
          ) : (
            <BubbleContent className="w-full">
              {message.parts.map((part, i) => {
                // The assistant reply is markdown; render it through Response
                // (Streamdown) so lists, code, and emphasis format correctly.
                if (part.type === 'text') return <Response key={i}>{part.text}</Response>;
                if (isToolUIPart(part)) {
                  const toolPart = part;
                  const approvalId = toolPart.approval?.id;
                  return (
                    <ToolInvocation
                      key={i}
                      part={toolPart}
                      onApprove={onToolApprove && approvalId ? () => onToolApprove(approvalId) : undefined}
                      onDeny={onToolDeny && approvalId ? () => onToolDeny(approvalId) : undefined}
                    />
                  );
                }
                return null;
              })}
              {showThinking && (
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <Loader2Icon className="size-3.5 animate-spin" />
                  <span className="shimmer">Thinking…</span>
                </span>
              )}
            </BubbleContent>
          )}
        </Bubble>
      </MessageContent>
    </Message>
  );
}
