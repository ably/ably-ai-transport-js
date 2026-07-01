'use client';

import type { UIMessage } from 'ai';
import { Loader2Icon } from 'lucide-react';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Message, MessageContent } from '@/components/ui/message';
import { Response } from '@/components/ui/response';
import { ToolInvocation } from './tool-invocation';
import type { BubbleStatus } from './message-list';

interface MessageBubbleProps {
  /** The message to render. */
  message: UIMessage;
  /**
   * Bubble status for assistant messages — the last assistant message reflects
   * the latest run's live state; `undefined` for user messages and un-tracked
   * assistant messages. Drives the streaming "Thinking…" placeholder.
   */
  status: BubbleStatus | undefined;
  /** Approve a pending tool call, addressed by its `toolCallId`. */
  onToolApprove?: (toolCallId: string) => void;
  /** Deny a pending tool call, addressed by its `toolCallId`. */
  onToolDeny?: (toolCallId: string) => void;
}

/**
 * A single chat bubble. Renders text and tool-invocation parts, the approval
 * card for approval-gated tools, and a quiet "Thinking…" loader while the last
 * assistant response is streaming with no content yet. This demo is linear (no
 * branch navigation, edit, or regenerate), so the bubble is a pure renderer.
 * @param props - The message, its run status, and the approval handlers.
 */
export function MessageBubble({ message, status, onToolApprove, onToolDeny }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  const messageText = message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
  const hasToolParts = message.parts.some((p) => p.type === 'dynamic-tool');
  // Assistant turn that is streaming but has produced no text or tool activity
  // yet — show a quiet loader instead of an empty row.
  const showThinking = !isUser && status === 'streaming' && messageText.trim() === '' && !hasToolParts;

  return (
    <Message
      align={isUser ? 'end' : 'start'}
      data-testid="message-bubble"
      data-role={message.role}
    >
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
                if (part.type === 'dynamic-tool') {
                  const toolPart = part;
                  return (
                    <ToolInvocation
                      key={i}
                      part={toolPart}
                      onApprove={onToolApprove ? () => onToolApprove(toolPart.toolCallId) : undefined}
                      onDeny={onToolDeny ? () => onToolDeny(toolPart.toolCallId) : undefined}
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
