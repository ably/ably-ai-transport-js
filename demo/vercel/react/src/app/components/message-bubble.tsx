'use client';

import type * as AI from 'ai';
import { getToolName, isToolUIPart } from 'ai';

import type { RunStatus } from '@ably/ai-transport';

interface MessageBubbleProps {
  message: AI.UIMessage;
  streaming: boolean;
  /**
   * Current status of the run this message belongs to. Driven by the
   * symmetric state machine — only lifecycle wires (run-start /
   * step-start / run-end) move it. Drives the run status pill on
   * assistant bubbles. Undefined for the rare transient case where the
   * run has not yet been observed in the view.
   */
  runStatus?: RunStatus;
  /**
   * 1-based index of the step within the run that produced this
   * message. Drives the `step N` badge so users can see retry produce
   * a fresh step alongside any prior failed/aborted output.
   */
  stepIndex?: number;
  /**
   * When set, render a Retry button on the bubble. Wired by
   * MessageList only on the latest assistant bubble whose run has
   * reached a terminal status.
   */
  onRetry?: () => void;
}

function bubbleClasses(isUser: boolean, streaming: boolean): string {
  const base = 'rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap';
  if (isUser) return `${base} bg-zinc-800 text-zinc-200`;
  return streaming
    ? `${base} bg-zinc-900 text-zinc-300 border border-amber-900/40`
    : `${base} bg-zinc-900 text-zinc-300 border border-zinc-800`;
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

const RUN_STATUS_PILL: Record<RunStatus, { label: string; classes: string }> = {
  active: { label: 'active', classes: 'border-amber-700/60 text-amber-300' },
  complete: { label: 'complete', classes: 'border-emerald-800/60 text-emerald-300' },
  failed: { label: 'failed', classes: 'border-rose-800/60 text-rose-300' },
  aborted: { label: 'aborted', classes: 'border-zinc-700 text-zinc-400' },
};

export function MessageBubble({ message, streaming, runStatus, stepIndex, onRetry }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const showHeader = !isUser && (runStatus !== undefined || stepIndex !== undefined);
  const pill = !isUser && runStatus !== undefined ? RUN_STATUS_PILL[runStatus] : undefined;

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className="max-w-[75%]">
        {showHeader && (
          <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wide">
            {stepIndex !== undefined && <span className="font-mono text-zinc-500">step {stepIndex}</span>}
            {pill !== undefined && (
              <span className={`rounded-sm border px-1.5 py-0.5 ${pill.classes}`}>{pill.label}</span>
            )}
          </div>
        )}
        <div className={bubbleClasses(isUser, streaming)}>
          {message.parts.map((part, i) => {
            if (part.type === 'text') return <span key={i}>{part.text}</span>;
            if (isToolUIPart(part))
              return (
                <ToolCallCard
                  key={i}
                  part={part}
                />
              );
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
