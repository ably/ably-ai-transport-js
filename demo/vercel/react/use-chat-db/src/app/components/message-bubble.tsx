'use client';

import { isToolUIPart, type UIMessage } from 'ai';
import { Loader2Icon } from 'lucide-react';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Message, MessageContent } from '@/components/ui/message';
import { Response } from '@/components/ui/response';
import { ToolInvocation } from './tool-invocation';

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

  return (
    <Message align={isUser ? 'end' : 'start'}>
      <MessageContent>
        {/* shadcn chat convention: the user's own messages sit in a filled
            bubble; the assistant's reply is a ghost bubble that reads as plain
            prose. */}
        <Bubble
          variant={isUser ? 'default' : 'ghost'}
          align={isUser ? 'end' : 'start'}
        >
          {isUser ? (
            <BubbleContent className="whitespace-pre-wrap">{messageText}</BubbleContent>
          ) : (
            <BubbleContent>
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
                  Thinking…
                </span>
              )}
            </BubbleContent>
          )}
        </Bubble>
      </MessageContent>
    </Message>
  );
}
