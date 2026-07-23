'use client';

import { useState, type CSSProperties } from 'react';
import type { OpenAIMessage, OpenAIToolCallState } from '@ably/ai-transport/openai';
import { ChevronLeftIcon, ChevronRightIcon, Loader2Icon } from 'lucide-react';
import { Badge } from '@ably-ai-demos/frontend/components/ui/badge';
import { Bubble, BubbleContent } from '@ably-ai-demos/frontend/components/ui/bubble';
import { Button } from '@ably-ai-demos/frontend/components/ui/button';
import { Message, MessageContent, MessageFooter } from '@ably-ai-demos/frontend/components/ui/message';
import { Response } from '@ably-ai-demos/frontend/components/ui/response';
import { Textarea } from '@ably-ai-demos/frontend/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@ably-ai-demos/frontend/components/ui/tooltip';
import { clientColor } from '@ably-ai-demos/frontend/lib/client-color';
import { cn } from '@ably-ai-demos/frontend/lib/utils';
import { toDisplayParts } from '../display';
import { turnText } from '../helpers';
import { ToolInvocation } from './tool-invocation';

interface MessageBubbleProps {
  // The conversation turn to render — its message items' text content parts.
  message: OpenAIMessage;
  // Tool outputs collected across all visible messages, keyed by call_id, so a
  // function_call in this message pairs with its output even when the output was
  // published in a sibling message.
  toolOutputs: Map<string, string>;
  // Per-call tool state (approval decision, client-result status) collected
  // across all visible messages, keyed by call_id. A gated call's approval
  // state is published on its own message, so it must be paired cross-message
  // like toolOutputs.
  toolStates: Map<string, OpenAIToolCallState>;
  // Per-message metadata derived from the View at the list-glue layer
  // (see MessageList) and passed as primitives so the bubble stays a
  // pure renderer with no transport type dependencies.
  clientId: string | undefined;
  runId: string | undefined;
  status: 'streaming' | 'complete' | 'cancelled' | 'error' | 'suspended' | undefined;
  // The owning run's terminal error, present when this bubble should surface
  // it — the list places it on the run's assistant output when any is visible,
  // else on the triggering user bubble.
  errorMessage?: string;
  hasSiblings: boolean;
  siblingCount: number;
  selectedIndex: number;
  onSelectSibling: (index: number) => void;
  onRegenerate?: () => void;
  onEdit?: (newText: string) => void;
  // Approve / deny a gated tool call in this message, addressed by its call_id.
  onApproveTool: (callId: string) => void;
  onDenyTool: (callId: string) => void;
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

// A reasoning model's streamed summary ("thinking"), shown muted above the
// answer it precedes. The Responses API exposes this as its own item type, so it
// renders as its own block rather than as part of the reply text.
function ReasoningBlock({ text }: { text: string }) {
  return (
    <div className="mb-1.5 rounded-md border border-border bg-background/40 px-2.5 py-1.5 text-xs whitespace-pre-wrap text-muted-foreground italic">
      <span className="mr-1 !not-italic select-none">💭 thinking</span>
      {text}
    </div>
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
  toolOutputs,
  toolStates,
  clientId,
  runId,
  status,
  errorMessage,
  hasSiblings,
  siblingCount,
  selectedIndex,
  onSelectSibling,
  onRegenerate,
  onEdit,
  onApproveTool,
  onDenyTool,
}: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const [isEditing, setIsEditing] = useState(false);

  const role = message.role;
  const colors = clientId ? clientColor(clientId) : undefined;
  // CAST: CSS custom properties are valid style keys but missing from React's
  // CSSProperties type. The bubble sets --primary locally so shadcn's tinted
  // variant derives the client-tinted background from it.
  const bubbleTheme = colors ? ({ '--primary': colors.primary } as CSSProperties) : undefined;

  const messageText = turnText(message);
  const displayParts = toDisplayParts(message, toolOutputs, toolStates);
  // An assistant turn that is streaming but has rendered nothing yet — show a
  // quiet loader instead of an empty bubble.
  const showThinking = !isUser && status === 'streaming' && displayParts.length === 0;

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
                  {displayParts.map((part, i) =>
                    part.kind === 'text' ? (
                      // The assistant reply is markdown; render it through
                      // Response (Streamdown) so lists, code, and emphasis
                      // format correctly.
                      <Response key={i}>{part.text}</Response>
                    ) : part.kind === 'reasoning' ? (
                      <ReasoningBlock
                        key={i}
                        text={part.text}
                      />
                    ) : (
                      <ToolInvocation
                        key={i}
                        part={part}
                        onApprove={() => onApproveTool(part.callId)}
                        onDeny={() => onDenyTool(part.callId)}
                      />
                    ),
                  )}
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
              {hasSiblings && (
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
                  {status && !isUser && <StatusBadge status={status} />}
                </>
              )}
            </MessageFooter>
            {errorMessage && <div className="mt-1 text-[11px] break-words text-destructive">{errorMessage}</div>}
          </>
        )}
      </MessageContent>
    </Message>
  );
}
