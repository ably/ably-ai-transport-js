'use client';

import { useState } from 'react';
import type { UIMessage, DynamicToolUIPart } from 'ai';
import { Loader2Icon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Button } from '@/components/ui/button';
import { Message, MessageContent, MessageFooter } from '@/components/ui/message';
import { Textarea } from '@/components/ui/textarea';
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
      className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5"
    >
      <button
        onClick={() => onSelect(current - 1)}
        disabled={current === 0}
        className="px-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        title="Previous branch"
      >
        &lt;
      </button>
      <span
        data-testid="branch-counter"
        className="min-w-[2.5rem] text-center text-[10px] text-muted-foreground tabular-nums"
      >
        {current + 1} / {total}
      </span>
      <button
        onClick={() => onSelect(current + 1)}
        disabled={current >= total - 1}
        className="px-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        title="Next branch"
      >
        &gt;
      </button>
    </div>
  );
}

function InfoBadge({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <Badge
      variant="secondary"
      className={className}
    >
      <span className="text-muted-foreground">{label}</span>
      <span>{value}</span>
    </Badge>
  );
}

function StatusBadge({ status }: { status: string }) {
  const className =
    status === 'complete'
      ? 'bg-emerald-950 text-emerald-400'
      : status === 'streaming'
        ? 'bg-amber-950 text-amber-400'
        : status === 'cancelled' || status === 'error'
          ? 'bg-red-950 text-red-400'
          : undefined;
  return (
    <InfoBadge
      label="status"
      value={status}
      className={className}
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
  const hasToolParts = message.parts.some((p) => p.type === 'dynamic-tool');
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
              <BubbleContent className="whitespace-pre-wrap">
                {isUser
                  ? messageText
                  : message.parts.map((part, i) => {
                      if (part.type === 'text') return <span key={i}>{part.text}</span>;
                      if (part.type === 'dynamic-tool') {
                        const toolPart = part as DynamicToolUIPart;
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
                    <Badge
                      label="step"
                      value={stepId.slice(0, 8) + (stepCount > 1 ? ` +${stepCount - 1}` : '')}
                      color="bg-zinc-900 text-zinc-500"
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
