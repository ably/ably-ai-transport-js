'use client';

import { useState } from 'react';
import type * as AI from 'ai';
import { getToolName, isToolUIPart } from 'ai';

import type { StepStatus } from '@ably/ai-transport';

import { SPAWN_SUBAGENT_TOOL_NAME } from '../../lib/spawn-subagent-tool';
import { useSubagentRendering } from './subagent-context';

interface MessageBubbleProps {
  message: AI.UIMessage;
  streaming: boolean;
  /**
   * Status of the step that produced this message, read from
   * `node.step?.status`. Drives the per-bubble status pill so the
   * header reflects the individual step's lifecycle (active /
   * complete / failed / aborted / abandoned / pending) rather than the
   * coarser run-level status. Undefined for user messages and other
   * client publishes that have no owning step.
   */
  stepStatus?: StepStatus;
  /**
   * 1-based index of the step within the run that produced this
   * message. Drives the `step N` badge so users can see retry produce
   * a fresh step alongside any prior failed/aborted output.
   */
  stepIndex?: number;
  /**
   * Whether this message contributes to the run's current state.
   * `false` for failed/aborted/abandoned predecessors of a retry —
   * the bubble dims and gains a "retried" label so users can tell
   * historical attempts apart from canonical output. Spec: AIT-CN2.
   */
  canonical: boolean;
  /**
   * When set, render a Retry button on the bubble. Wired by
   * MessageList only on the latest assistant bubble whose run has
   * reached a terminal status.
   */
  onRetry?: () => void;
}

function bubbleClasses(isUser: boolean, streaming: boolean, canonical: boolean): string {
  const base = 'rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap';
  // Non-canonical bubbles are historical attempts replaced by a retry.
  // Dim and de-saturate so they read as "this was tried before" without
  // disappearing from the conversation. Spec: AIT-CN2.
  const dim = canonical ? '' : ' opacity-50 grayscale';
  if (isUser) return `${base}${dim} bg-zinc-800 text-zinc-200`;
  return streaming
    ? `${base}${dim} bg-zinc-900 text-zinc-300 border border-amber-900/40`
    : `${base}${dim} bg-zinc-900 text-zinc-300 border border-zinc-800`;
}

function ToolCallCard({ part }: { part: AI.ToolUIPart | AI.DynamicToolUIPart }) {
  const name = getToolName(part);
  const stateColor =
    part.state === 'output-error'
      ? 'border-rose-900/60 text-rose-300'
      : part.state === 'output-available'
        ? 'border-emerald-900/60 text-emerald-300'
        : 'border-amber-900/60 text-amber-300';

  return (
    <div className={`mt-2 rounded-md border ${stateColor} bg-zinc-950/60 px-2 py-1.5 text-xs`}>
      <div className="flex items-center gap-2 font-mono">
        <span className="text-zinc-400">tool</span>
        <span className="text-zinc-200">{name}</span>
        <span className="ml-auto text-[10px] uppercase tracking-wide opacity-75">{part.state}</span>
      </div>
      {part.state !== 'input-streaming' && part.input !== undefined && (
        <pre className="mt-1 overflow-x-auto text-[11px] text-zinc-400">{JSON.stringify(part.input, null, 2)}</pre>
      )}
      {part.state === 'output-available' && (
        <pre className="mt-1 overflow-x-auto text-[11px] text-emerald-300/90">
          {JSON.stringify(part.output, null, 2)}
        </pre>
      )}
      {part.state === 'output-error' && <p className="mt-1 text-[11px] text-rose-300/90">{part.errorText}</p>}
    </div>
  );
}

/**
 * Inline rendering of a subagent spawn. Replaces the generic tool-call
 * card for `spawn_subagent` parts and shows the linked subagent run's
 * messages indented underneath, recursively (a subagent that spawned its
 * own children renders them via the same nested MessageBubble calls).
 *
 * While the link sidecar hasn't arrived yet (the subagent has been
 * announced by the parent's tool-call but the worker hasn't published
 * the link message yet) we fall back to a placeholder driven off the
 * tool-call input alone, so the UI never has a frame where the spawn is
 * invisible.
 */
function SubagentBlock({ part }: { part: AI.ToolUIPart | AI.DynamicToolUIPart }) {
  const ctx = useSubagentRendering();
  const inputDescription =
    part.input !== undefined && typeof part.input === 'object' && part.input !== null
      ? // CAST: tool input is validated by the spawn_subagent inputSchema
        // at the model layer, so the part's input is { description, prompt }.
        // Read the description for the header label.
        ((part.input as { description?: unknown }).description ?? '')
      : '';
  const description = typeof inputDescription === 'string' ? inputDescription : '';

  const link = ctx?.links.byToolCallId.get(part.toolCallId);
  const subagentMessages = link === undefined ? undefined : ctx?.messagesByRun.get(link.runId);
  const messageCount = subagentMessages?.length ?? 0;
  const status = link === undefined ? 'spawning…' : part.state === 'output-available' ? 'returned' : 'running';
  const hasContent = messageCount > 0 && ctx !== undefined;

  // Default expanded so the user can watch the subagent's work as it
  // streams in; they can collapse a finished run to keep the main thread
  // tidy. Per-block local state — each subagent in a fan-out toggles
  // independently.
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="mt-2 rounded-md border border-violet-900/60 bg-violet-950/30 px-2 py-1.5 text-xs">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        disabled={!hasContent}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 font-mono text-left disabled:cursor-default"
      >
        <span
          aria-hidden="true"
          className={`inline-block w-2 text-violet-300/70 transition-transform ${expanded ? 'rotate-90' : ''} ${hasContent ? '' : 'opacity-30'}`}
        >
          ▶
        </span>
        <span className="text-zinc-400">subagent</span>
        <span className="text-zinc-200">{description}</span>
        {messageCount > 0 && <span className="text-[10px] text-violet-300/60">({messageCount})</span>}
        <span className="ml-auto text-[10px] uppercase tracking-wide text-violet-300/80">{status}</span>
      </button>
      {expanded && hasContent && (
        <div className="mt-2 space-y-2 pl-3">
          {subagentMessages?.map((m) => {
            const meta = ctx.info.get(m.id);
            return (
              <MessageBubble
                key={m.id}
                message={m}
                streaming={m.id === ctx.streamingId}
                stepStatus={meta?.stepStatus}
                stepIndex={meta?.stepIndex}
                canonical={meta?.canonical ?? true}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

const STEP_STATUS_PILL: Record<StepStatus, { label: string; classes: string }> = {
  pending: { label: 'pending', classes: 'border-zinc-700 text-zinc-400' },
  active: { label: 'active', classes: 'border-amber-700/60 text-amber-300' },
  complete: { label: 'complete', classes: 'border-emerald-800/60 text-emerald-300' },
  failed: { label: 'failed', classes: 'border-rose-800/60 text-rose-300' },
  aborted: { label: 'aborted', classes: 'border-sky-800/60 text-sky-300' },
  abandoned: { label: 'abandoned', classes: 'border-zinc-700 text-zinc-500' },
};

export function MessageBubble({ message, streaming, stepStatus, stepIndex, canonical, onRetry }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const showHeader = !isUser && (stepStatus !== undefined || stepIndex !== undefined || !canonical);
  const pill = !isUser && stepStatus !== undefined ? STEP_STATUS_PILL[stepStatus] : undefined;

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className="max-w-[75%]">
        {showHeader && (
          <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wide">
            {stepIndex !== undefined && <span className="font-mono text-zinc-500">step {stepIndex}</span>}
            {pill !== undefined && (
              <span className={`rounded-sm border px-1.5 py-0.5 ${pill.classes}`}>{pill.label}</span>
            )}
            {!canonical && (
              <span className="rounded-sm border border-zinc-700 px-1.5 py-0.5 text-zinc-500">retried</span>
            )}
          </div>
        )}
        <div className={bubbleClasses(isUser, streaming, canonical)}>
          {message.parts.map((part, i) => {
            if (part.type === 'text') return <span key={i}>{part.text}</span>;
            if (isToolUIPart(part)) {
              if (getToolName(part) === SPAWN_SUBAGENT_TOOL_NAME) {
                return (
                  <SubagentBlock
                    key={i}
                    part={part}
                  />
                );
              }
              return (
                <ToolCallCard
                  key={i}
                  part={part}
                />
              );
            }
            return null;
          })}
          {!isUser && streaming && (
            <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-amber-500/60 align-text-bottom" />
          )}
        </div>
        {onRetry !== undefined && (
          <div className="mt-1.5 flex justify-start">
            <button
              type="button"
              onClick={onRetry}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-zinc-800"
              aria-label="Retry this run"
            >
              ↻ Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
