'use client';

import { useState } from 'react';
import { isToolUIPart, type UIMessage } from 'ai';
import { ChevronLeftIcon, ChevronRightIcon, Loader2Icon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Button } from '@/components/ui/button';
import { Message, MessageContent, MessageFooter } from '@/components/ui/message';
import { Response } from '@/components/ui/response';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ToolInvocation } from './tool-invocation';
import { clientColor } from '../lib/client-color';

interface MessageBubbleProps {
  message: UIMessage;
  // Per-message metadata derived from the View at the list-glue layer
  // (see MessageList) and passed as primitives so the bubble stays a
  // pure renderer with no SDK type dependencies.
  clientId: string | undefined;
  runId: string | undefined;
  stepId: string | undefined;
  stepCount: number;
  status: 'streaming' | 'complete' | 'cancelled' | 'error' | 'suspended' | undefined;
  errorMessage?: string;
  hasSiblings?: boolean;
  siblingCount?: number;
  selectedIndex?: number;
  onSelectSibling?: (index: number) => void;
  onRegenerate?: () => void;
  onEdit?: (newText: string) => void;
  onToolApprove?: (approvalId: string) => void;
  onToolDeny?: (approvalId: string) => void;
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
      className={className}
    >
      <span className={variant === 'destructive' ? 'opacity-70' : 'text-muted-foreground'}>{label}</span>
      <span>{value}</span>
    </Badge>
  );
}

function StatusBadge({ status }: { status: string }) {
  // Only a failed/cancelled run carries a colour (destructive); complete and
  // streaming deliberately stay neutral so the row doesn't read as an alert.
  return (
    <InfoBadge
      label="status"
      value={status}
      variant={status === 'cancelled' || status === 'error' ? 'destructive' : 'secondary'}
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
      <MessageContent>
        {isEditing && onEdit ? (
          <EditForm
            initialText={messageText}
            onSubmit={(text) => onEdit(text)}
            onCancel={() => setIsEditing(false)}
          />
        ) : (
          <>
            {/* shadcn chat convention: the user's own messages sit in a filled
                bubble; the assistant's reply is a ghost bubble that reads as
                plain prose. */}
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
            <MessageFooter className="mt-1 flex flex-wrap items-center gap-1.5">
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
