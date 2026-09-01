'use client';

import type { CSSProperties } from 'react';
import { isToolUIPart, type DynamicToolUIPart, type ToolUIPart, type UIMessage } from 'ai';
import { Loader2Icon } from 'lucide-react';
import { Badge } from './ui/badge';
import { Bubble, BubbleContent } from './ui/bubble';
import { Message, MessageContent, MessageFooter } from './ui/message';
import { Response } from './ui/response';
import { ToolInvocation } from './tool-invocation';
import { clientColor } from '../lib/client-color';
import { cn } from '../lib/utils';

/** The bubble's rendering vocabulary for a run's lifecycle. */
export type MessageStatus = 'streaming' | 'complete' | 'cancelled' | 'error' | 'suspended';

interface MessageBubbleProps {
  message: UIMessage;
  // Per-message metadata derived from the View at the list-glue layer
  // (see the message lists) and passed as primitives so the bubble stays a
  // pure renderer with no SDK type dependencies.
  clientId: string | undefined;
  runId: string | undefined;
  stepId: string | undefined;
  stepCount: number;
  status: MessageStatus | undefined;
  errorMessage?: string;
  // Approve/deny receive the tool part itself, so each demo's container reads
  // whichever token its write path needs — the Vercel `approval.id` or the
  // `(codecMessageId, toolCallId)` pair — without the bubble taking a side.
  onToolApprove?: (toolPart: ToolUIPart | DynamicToolUIPart) => void;
  onToolDeny?: (toolPart: ToolUIPart | DynamicToolUIPart) => void;
}

function InfoBadge({
  label,
  value,
  variant = 'secondary',
  className,
}: {
  label: string;
  value: string;
  variant?: 'secondary' | 'destructive';
  className?: string;
}) {
  return (
    <Badge
      variant={variant}
      className={cn('rounded-sm px-1.5 text-[10px]', className)}
    >
      <span className={variant === 'destructive' ? 'opacity-70' : 'text-muted-foreground'}>{label}</span>
      <span>{value}</span>
    </Badge>
  );
}

function StatusBadge({ status }: { status: string }) {
  // The status badge carries the run's lifecycle colour: the destructive
  // variant when cancelled or failed, green once complete, amber while
  // streaming.
  return (
    <InfoBadge
      label="status"
      value={status}
      variant={status === 'cancelled' || status === 'error' ? 'destructive' : 'secondary'}
      className={status === 'complete' ? 'text-emerald-500' : status === 'streaming' ? 'text-amber-500' : undefined}
    />
  );
}

export function MessageBubble({
  message,
  clientId,
  runId,
  stepId,
  stepCount,
  status,
  errorMessage,
  onToolApprove,
  onToolDeny,
}: MessageBubbleProps) {
  const isUser = message.role === 'user';

  const role = message.role;
  const colors = clientId ? clientColor(clientId) : undefined;
  // CAST: CSS custom properties are valid style keys but missing from React's
  // CSSProperties type. The bubble sets --primary locally so shadcn's tinted
  // variant derives the client-tinted background from it.
  const bubbleTheme = colors ? ({ '--primary': colors.primary } as CSSProperties) : undefined;

  const messageText = message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
  const hasToolParts = message.parts.some((p) => isToolUIPart(p));
  // Assistant turn that is streaming but has produced no text or tool activity
  // yet — show a quiet loader instead of an empty row (no blinking caret).
  const showThinking = !isUser && status === 'streaming' && messageText.trim() === '' && !hasToolParts;

  return (
    <Message
      align={isUser ? 'end' : 'start'}
      data-testid="message-bubble"
      data-role={role}
    >
      {/* Shrink-wrap the turn so the bubble stretches to the badge row's width
          (never narrower), while long content stays capped at 75%. */}
      <MessageContent className="w-fit max-w-[75%] gap-1.5">
        {/* The user's turn is a tinted bubble — the client's palette colour
                becomes the bubble's --primary, and shadcn's tinted variant
                derives the background from it. The assistant reply is a muted
                bubble; its status colour lives on the status badge. */}
        <Bubble
          variant={isUser ? 'tinted' : 'muted'}
          align={isUser ? 'end' : 'start'}
          className="w-full max-w-full"
          style={isUser ? bubbleTheme : undefined}
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
                  return (
                    <ToolInvocation
                      key={i}
                      part={toolPart}
                      onApprove={onToolApprove ? () => onToolApprove(toolPart) : undefined}
                      onDeny={onToolDeny ? () => onToolDeny(toolPart) : undefined}
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
        <MessageFooter className="flex flex-wrap items-center gap-1.5">
          {/* Debug badges (only when we know which Run the message belongs to). */}
          {runId && (
            <>
              <InfoBadge
                label="role"
                value={role}
              />
              {clientId && (
                <InfoBadge
                  label="client"
                  value={clientId}
                  className={colors?.text}
                />
              )}
              <InfoBadge
                label="run"
                value={runId.slice(0, 8)}
              />
              {stepId && (
                <InfoBadge
                  label="step"
                  value={stepId.slice(0, 8) + (stepCount > 1 ? ` +${stepCount - 1}` : '')}
                />
              )}
              {status && !isUser && <StatusBadge status={status} />}
            </>
          )}
        </MessageFooter>
        {!isUser && status === 'error' && errorMessage && (
          <div className="mt-1 text-[11px] break-words text-destructive">{errorMessage}</div>
        )}
      </MessageContent>
    </Message>
  );
}
