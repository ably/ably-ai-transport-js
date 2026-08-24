'use client';

import { useState, type CSSProperties } from 'react';
import { isToolUIPart, type DynamicToolUIPart, type ToolUIPart, type UIMessage } from 'ai';
import { ChevronLeftIcon, ChevronRightIcon, Loader2Icon } from 'lucide-react';
import { Badge } from './ui/badge';
import { Bubble, BubbleContent } from './ui/bubble';
import { Button } from './ui/button';
import { Message, MessageContent, MessageFooter } from './ui/message';
import { Response } from './ui/response';
import { Textarea } from './ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { ToolInvocation } from './tool-invocation';
import { clientColor } from '../lib/client-color';
import { cn } from '../lib/utils';

/** The bubble's rendering vocabulary for a run's lifecycle. */
export type MessageStatus = 'streaming' | 'complete' | 'cancelled' | 'error' | 'suspended';

interface MessageBubbleProps {
  message: UIMessage;
  // Per-message metadata derived from the app's own fold at the list-glue layer
  // (see the message lists) and passed as primitives so the bubble stays a
  // pure renderer with no SDK type dependencies.
  clientId: string | undefined;
  runId: string | undefined;
  stepId: string | undefined;
  stepCount: number;
  status: MessageStatus | undefined;
  errorMessage?: string;
  hasSiblings?: boolean;
  siblingCount?: number;
  selectedIndex?: number;
  onSelectSibling?: (index: number) => void;
  onRegenerate?: () => void;
  onEdit?: (newText: string) => void;
  // Approve/deny receive the tool part itself, so each demo's container reads
  // whichever token its write path needs — the Vercel `approval.id` or the
  // `(codecMessageId, toolCallId)` pair — without the bubble taking a side.
  onToolApprove?: (toolPart: ToolUIPart | DynamicToolUIPart) => void;
  onToolDeny?: (toolPart: ToolUIPart | DynamicToolUIPart) => void;
}

function BranchNavigator({
  current,
  total,
  onSelect,
}: {
  current: number;
  total: number;
  onSelect: (index: number) => void;
}) {
  return (
    <div
      data-testid="branch-navigator"
      className="inline-flex items-center gap-0.5 rounded-md bg-muted px-0.5"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => onSelect(current - 1)}
            disabled={current === 0}
            aria-label="Previous branch"
          >
            <ChevronLeftIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Previous branch</TooltipContent>
      </Tooltip>
      <span
        data-testid="branch-counter"
        className="min-w-[2.5rem] text-center text-[10px] text-muted-foreground tabular-nums"
      >
        {current + 1} / {total}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => onSelect(current + 1)}
            disabled={current >= total - 1}
            aria-label="Next branch"
          >
            <ChevronRightIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Next branch</TooltipContent>
      </Tooltip>
    </div>
  );
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

// ---------------------------------------------------------------------------
// Inline edit form
// ---------------------------------------------------------------------------

function EditForm({
  initialText,
  onSubmit,
  onCancel,
}: {
  initialText: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initialText);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (trimmed && trimmed !== initialText) {
      onSubmit(trimmed);
    }
    onCancel();
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="w-full"
    >
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        data-testid="edit-input"
        rows={Math.min(6, text.split('\n').length + 1)}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit(e);
          }
        }}
      />
      <div className="mt-1.5 flex gap-2">
        <Button
          type="submit"
          size="xs"
          disabled={!text.trim() || text.trim() === initialText}
        >
          Save &amp; Submit
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </form>
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
  hasSiblings,
  siblingCount,
  selectedIndex,
  onSelectSibling,
  onRegenerate,
  onEdit,
  onToolApprove,
  onToolDeny,
}: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const [isEditing, setIsEditing] = useState(false);

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
        {isEditing && onEdit ? (
          <EditForm
            initialText={messageText}
            onSubmit={(text) => onEdit(text)}
            onCancel={() => setIsEditing(false)}
          />
        ) : (
          <>
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
              {/* Branch navigator (when the message has siblings) */}
              {hasSiblings && siblingCount !== undefined && selectedIndex !== undefined && onSelectSibling && (
                <BranchNavigator
                  current={selectedIndex}
                  total={siblingCount}
                  onSelect={onSelectSibling}
                />
              )}

              {/* Edit button (user messages) */}
              {onEdit && status !== 'streaming' && (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setIsEditing(true)}
                  title="Edit message"
                  data-testid="edit-message"
                >
                  edit
                </Button>
              )}

              {/* Regenerate button (assistant messages) */}
              {onRegenerate && status !== 'streaming' && (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={onRegenerate}
                  title="Regenerate response"
                  data-testid="regenerate-message"
                >
                  regenerate
                </Button>
              )}

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
          </>
        )}
      </MessageContent>
    </Message>
  );
}
