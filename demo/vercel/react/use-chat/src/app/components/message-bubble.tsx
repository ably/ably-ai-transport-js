'use client';

import { useState } from 'react';
import type { UIMessage, DynamicToolUIPart } from 'ai';
import { ToolInvocation } from './tool-invocation';
import { clientColor } from '../lib/client-color';

interface MessageBubbleProps {
  message: UIMessage;
  // Per-message metadata derived from the View at the list-glue layer
  // (see MessageList) and passed as primitives so the bubble stays a
  // pure renderer with no SDK type dependencies.
  clientId: string | undefined;
  runId: string | undefined;
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
    <div className="inline-flex items-center gap-1 rounded bg-zinc-800/60 px-1.5 py-0.5">
      <button
        onClick={() => onSelect(current - 1)}
        disabled={current === 0}
        className="text-[11px] text-zinc-400 hover:text-zinc-200 disabled:text-zinc-700 disabled:cursor-not-allowed transition-colors px-0.5"
        title="Previous branch"
      >
        &lt;
      </button>
      <span className="text-[10px] text-zinc-500 tabular-nums min-w-[2.5rem] text-center">
        {current + 1} / {total}
      </span>
      <button
        onClick={() => onSelect(current + 1)}
        disabled={current >= total - 1}
        className="text-[11px] text-zinc-400 hover:text-zinc-200 disabled:text-zinc-700 disabled:cursor-not-allowed transition-colors px-0.5"
        title="Next branch"
      >
        &gt;
      </button>
    </div>
  );
}

function Badge({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] leading-tight ${color}`}>
      <span className="text-zinc-600">{label}</span>
      <span>{value}</span>
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === 'complete'
      ? 'bg-emerald-950 text-emerald-400'
      : status === 'streaming'
        ? 'bg-amber-950 text-amber-400'
        : status === 'cancelled' || status === 'error'
          ? 'bg-red-950 text-red-400'
          : 'bg-zinc-900 text-zinc-500';
  return (
    <Badge
      label="status"
      value={status}
      color={color}
    />
  );
}

function bubbleClasses(isUser: boolean, status: string | undefined, userBgClass?: string): string {
  const base = 'rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap';

  if (isUser) {
    return `${base} ${userBgClass ?? 'bg-zinc-800'} text-zinc-100`;
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
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="w-full rounded-lg bg-zinc-800 border border-zinc-600 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-zinc-400 resize-none"
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
      <div className="flex gap-2 mt-1.5">
        <button
          type="submit"
          disabled={!text.trim() || text.trim() === initialText}
          className="rounded px-2.5 py-1 text-[11px] font-medium bg-zinc-700 text-zinc-200 hover:bg-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Save &amp; Submit
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-2.5 py-1 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export function MessageBubble({
  message,
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

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className="max-w-[75%]">
        {isEditing && onEdit ? (
          <EditForm
            initialText={messageText}
            onSubmit={(text) => onEdit(text)}
            onCancel={() => setIsEditing(false)}
          />
        ) : (
          <>
            <div className={bubbleClasses(isUser, status, colors?.userBg)}>
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
              {!isUser && status === 'streaming' && (
                <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-amber-500/60 animate-pulse rounded-sm align-text-bottom" />
              )}
            </div>
            <div className="mt-1 flex items-center gap-1.5 flex-wrap">
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
                <button
                  onClick={() => setIsEditing(true)}
                  className="text-[10px] text-zinc-500 hover:text-zinc-200 transition-colors rounded bg-zinc-800/60 px-1.5 py-0.5"
                  title="Edit message"
                >
                  edit
                </button>
              )}

              {/* Regenerate button (assistant messages) */}
              {onRegenerate && status !== 'streaming' && (
                <button
                  onClick={onRegenerate}
                  className="text-[10px] text-zinc-500 hover:text-zinc-200 transition-colors rounded bg-zinc-800/60 px-1.5 py-0.5"
                  title="Regenerate response"
                >
                  regenerate
                </button>
              )}

              {/* Debug badges (only when we know which Run the message belongs to). */}
              {runId && (
                <>
                  <Badge
                    label="role"
                    value={role}
                    color="bg-zinc-900 text-zinc-500"
                  />
                  {clientId && (
                    <Badge
                      label="client"
                      value={clientId}
                      color={`bg-zinc-900 ${colors?.text ?? 'text-zinc-500'}`}
                    />
                  )}
                  <Badge
                    label="run"
                    value={runId.slice(0, 8)}
                    color="bg-zinc-900 text-zinc-500"
                  />
                  {status && !isUser && <StatusBadge status={status} />}
                </>
              )}
            </div>
            {!isUser && status === 'error' && errorMessage && (
              <div className="mt-1 text-[11px] text-red-300 break-words">{errorMessage}</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
