'use client';

import { useState } from 'react';
import type { UIMessage } from 'ai';
import { ToolApprovalCard } from './tool-approval';

// ---------------------------------------------------------------------------
// Tool part type helpers
// ---------------------------------------------------------------------------

interface DynamicToolPart {
  type: 'dynamic-tool';
  toolCallId: string;
  toolName: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: { id: string };
}

// CAST: UIMessagePart is a union — runtime check on `type` discriminant narrows to DynamicToolUIPart.
// We use a local interface instead of importing AI.DynamicToolUIPart because the SDK's type is
// heavily generic (parameterized by UITools) and we only need the fields we render.
function isDynamicTool(part: unknown): part is DynamicToolPart {
  return typeof part === 'object' && part !== null && (part as Record<string, unknown>).type === 'dynamic-tool';
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface MessageBubbleProps {
  message: UIMessage;
  headers: Record<string, string> | undefined;
  hasSiblings: boolean;
  siblings: UIMessage[];
  selectedIndex: number;
  onSelectSibling: (index: number) => void;
  onRegenerate?: () => void;
  onEdit?: (newText: string) => void;
  onToolApprove?: (toolCallId: string, toolName: string, input: Record<string, unknown>) => void;
  onToolDeny?: (toolCallId: string, toolName: string, input: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// Small presentational components
// ---------------------------------------------------------------------------

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
    status === 'finished'
      ? 'bg-emerald-950 text-emerald-400'
      : status === 'streaming'
        ? 'bg-amber-950 text-amber-400'
        : status === 'aborted'
          ? 'bg-red-950 text-red-400'
          : 'bg-zinc-900 text-zinc-500';
  return <Badge label="status" value={status} color={color} />;
}

function bubbleClasses(isUser: boolean, status: string | undefined): string {
  const base = 'rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap';

  if (isUser) return `${base} bg-zinc-800 text-zinc-200`;
  if (status === 'streaming') return `${base} bg-zinc-900 text-zinc-300 border border-amber-900/40`;
  if (status === 'finished') return `${base} bg-zinc-900 text-zinc-300 border border-emerald-900/40`;
  if (status === 'aborted') return `${base} bg-zinc-900 text-zinc-300 border border-red-900/40`;
  return `${base} bg-zinc-900 text-zinc-300 border border-zinc-800`;
}

// ---------------------------------------------------------------------------
// Inline tool result rendering
// ---------------------------------------------------------------------------

function ToolCallInProgress({ toolName, input }: { toolName: string; input?: unknown }) {
  const inputStr = input ? JSON.stringify(input) : null;
  return (
    <div className="my-1 rounded border border-zinc-700 bg-zinc-800/50 px-2 py-1.5 text-xs">
      <span className="text-zinc-500">Calling </span>
      <span className="font-mono text-blue-400">{toolName}</span>
      {inputStr && <span className="text-zinc-600"> ({inputStr})</span>}
      <span className="ml-1 inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500/60" />
    </div>
  );
}

function ToolResultInline({ toolName, output }: { toolName: string; output: unknown }) {
  if (toolName === 'searchWikipedia' && Array.isArray(output)) {
    // CAST: searchWikipedia tool returns this shape — validated by Array.isArray guard above
    const items = output as Array<{ title: string; snippet: string }>;
    return (
      <div className="my-1 rounded border border-zinc-700 bg-zinc-800/50 px-2 py-1.5">
        <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-500">Search results</p>
        <ul className="space-y-1">
          {items.map((item, i) => (
            <li key={i} className="text-xs">
              <span className="font-medium text-zinc-300">{item.title}</span>
              <span className="text-zinc-500"> &mdash; {item.snippet}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (toolName === 'getArticle' && typeof output === 'object' && output !== null) {
    // CAST: getArticle tool returns this shape — validated by typeof guard above
    const article = output as { title: string; extract: string };
    return (
      <div className="my-1 rounded border border-zinc-700 bg-zinc-800/50 px-2 py-1.5">
        <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-500">
          Article: {article.title}
        </p>
        <p className="text-xs text-zinc-400 line-clamp-4">{article.extract}</p>
      </div>
    );
  }

  return (
    <div className="my-1 rounded border border-zinc-700 bg-zinc-800/50 px-2 py-1.5 text-xs">
      <span className="text-zinc-500">Result from </span>
      <span className="font-mono text-blue-400">{toolName}</span>
      <pre className="mt-1 max-h-24 overflow-auto text-[10px] text-zinc-500">
        {JSON.stringify(output, null, 2)}
      </pre>
    </div>
  );
}

function ToolPartRenderer({ part }: { part: DynamicToolPart }) {
  switch (part.state) {
    case 'input-streaming':
    case 'input-available':
      return <ToolCallInProgress toolName={part.toolName} input={part.input} />;
    case 'output-available':
      return <ToolResultInline toolName={part.toolName} output={part.output} />;
    case 'output-error':
      return (
        <div className="my-1 rounded border border-red-800/50 bg-red-950/30 px-2 py-1.5 text-xs text-red-400">
          Tool error ({part.toolName}): {part.errorText ?? 'unknown error'}
        </div>
      );
    case 'output-denied':
      return (
        <div className="my-1 rounded border border-zinc-700 bg-zinc-800/50 px-2 py-1.5 text-xs text-zinc-500">
          Tool call denied: {part.toolName}
        </div>
      );
    default:
      // approval-requested and other states are handled separately
      return null;
  }
}

// ---------------------------------------------------------------------------
// Branch navigator: < 1/3 >
// ---------------------------------------------------------------------------

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
        className="px-0.5 text-[11px] text-zinc-400 transition-colors hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700"
        title="Previous version"
      >
        &lt;
      </button>
      <span className="min-w-[2.5rem] text-center text-[10px] tabular-nums text-zinc-500">
        {current + 1} / {total}
      </span>
      <button
        onClick={() => onSelect(current + 1)}
        disabled={current >= total - 1}
        className="px-0.5 text-[11px] text-zinc-400 transition-colors hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700"
        title="Next version"
      >
        &gt;
      </button>
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
    <form onSubmit={handleSubmit} className="w-full">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="w-full resize-none rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-zinc-400"
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
        <button
          type="submit"
          disabled={!text.trim() || text.trim() === initialText}
          className="rounded bg-zinc-700 px-2.5 py-1 text-[11px] font-medium text-zinc-200 transition-colors hover:bg-zinc-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Save &amp; Submit
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-2.5 py-1 text-[11px] text-zinc-500 transition-colors hover:text-zinc-300"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Message bubble
// ---------------------------------------------------------------------------

export function MessageBubble({
  message,
  headers,
  hasSiblings,
  siblings,
  selectedIndex,
  onSelectSibling,
  onRegenerate,
  onEdit,
  onToolApprove,
  onToolDeny,
}: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const [isEditing, setIsEditing] = useState(false);

  const role = headers?.['x-ably-role'] ?? message.role;
  const clientId = headers?.['x-ably-turn-client-id'];
  const turnId = headers?.['x-ably-turn-id'];
  const status = headers?.['x-ably-status'];

  const messageText = message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');

  // Extract dynamic tool parts via explicit cast after type guard
  const dynamicTools: DynamicToolPart[] = [];
  for (const p of message.parts) {
    if (isDynamicTool(p)) dynamicTools.push(p);
  }

  const approvalStates = new Set(['approval-requested', 'output-denied', 'approval-responded']);
  const approvalParts = dynamicTools.filter((p) => approvalStates.has(p.state));
  const approvalToolCallIds = new Set(approvalParts.map((p) => p.toolCallId));

  const hasTextContent = message.parts.some(
    (p) => p.type === 'text' && (p as { text: string }).text.trim().length > 0,
  );
  const hasInlineContent = hasTextContent || dynamicTools.some((p) => !approvalToolCallIds.has(p.toolCallId));

  return (
    <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
      <div className="max-w-[75%]">
        {isEditing && onEdit ? (
          <EditForm
            initialText={messageText}
            onSubmit={(text) => onEdit(text)}
            onCancel={() => setIsEditing(false)}
          />
        ) : (
          <>
            {/* Main bubble: text + inline tool parts */}
            {hasInlineContent && (
              <div className={bubbleClasses(isUser, status)}>
                {message.parts.map((part, i) => {
                  if (part.type === 'text') {
                    return <span key={i}>{(part as { type: 'text'; text: string }).text}</span>;
                  }
                  // Render non-approval dynamic tool parts inline
                  if (isDynamicTool(part) && !approvalToolCallIds.has(part.toolCallId)) {
                    return <ToolPartRenderer key={i} part={part} />;
                  }
                  return null;
                })}
                {!isUser && status === 'streaming' && (
                  <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-amber-500/60 align-text-bottom" />
                )}
              </div>
            )}

            {/* Tool approval cards — standalone blocks */}
            {approvalParts.map((part) => (
              <ToolApprovalCard
                key={part.toolCallId}
                toolName={part.toolName}
                toolCallId={part.toolCallId}
                input={part.input}
                state={part.state}
                onApprove={() =>
                  onToolApprove?.(part.toolCallId, part.toolName, (part.input ?? {}) as Record<string, unknown>)
                }
                onDeny={() =>
                  onToolDeny?.(part.toolCallId, part.toolName, (part.input ?? {}) as Record<string, unknown>)
                }
              />
            ))}

            {/* Action bar */}
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {hasSiblings && (
                <BranchNavigator
                  current={selectedIndex}
                  total={siblings.length}
                  onSelect={onSelectSibling}
                />
              )}
              {onEdit && status !== 'streaming' && (
                <button
                  onClick={() => setIsEditing(true)}
                  className="rounded bg-zinc-800/60 px-1.5 py-0.5 text-[10px] text-zinc-500 transition-colors hover:text-zinc-200"
                  title="Edit message"
                >
                  edit
                </button>
              )}
              {onRegenerate && status !== 'streaming' && (
                <button
                  onClick={onRegenerate}
                  className="rounded bg-zinc-800/60 px-1.5 py-0.5 text-[10px] text-zinc-500 transition-colors hover:text-zinc-200"
                  title="Regenerate response"
                >
                  regenerate
                </button>
              )}
              {headers && (
                <>
                  <Badge label="role" value={role} color="bg-zinc-900 text-zinc-500" />
                  {clientId && <Badge label="client" value={clientId} color="bg-zinc-900 text-zinc-500" />}
                  {turnId && <Badge label="turn" value={turnId.slice(0, 8)} color="bg-zinc-900 text-zinc-500" />}
                  {status && <StatusBadge status={status} />}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
