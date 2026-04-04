'use client';

/**
 * AgentProgressCard — renders a live task list from data-agent-progress parts.
 *
 * Shows each task with a status icon:
 *   ✓  done (coloured checkmark)
 *   ⟳  working (coloured spinner)
 *   ○  pending (gray circle)
 *
 * Colours are per-agent, sourced from agent-colors.ts.
 */

import type { UIMessage } from 'ai';
import { type AgentStyle, getAgentStyle } from './agent-colors';

type TaskStatus = 'pending' | 'working' | 'done' | 'cancelled';

interface TaskItem {
  label: string;
  status: TaskStatus;
}

interface AgentProgressData {
  agentLabel: string;
  tasks: TaskItem[];
}

/** Extract the latest agent-progress data from message parts. */
export function getLatestProgress(message: UIMessage): AgentProgressData | null {
  let latest: AgentProgressData | null = null;
  for (const part of message.parts) {
    if (part.type === 'data-agent-progress') {
      // CAST: data-agent-progress parts carry AgentProgressData
      latest = (part as { type: string; data: AgentProgressData }).data;
    }
  }
  return latest;
}

/** Check if a message contains agent progress parts. */
export function hasAgentProgress(message: UIMessage): boolean {
  return message.parts.some((p) => p.type === 'data-agent-progress');
}

function StatusIcon({ status, style }: { status: TaskStatus; style: AgentStyle }) {
  if (status === 'done') {
    return (
      <span className={`flex items-center justify-center w-4 h-4 rounded-full ${style.doneBg}`}>
        <svg className={`w-2.5 h-2.5 ${style.doneIcon}`} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M2 6l3 3 5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  if (status === 'working') {
    return (
      <span className="flex items-center justify-center w-4 h-4">
        <span className={`w-3 h-3 rounded-full border-2 ${style.spinnerBorder} ${style.spinnerTick} animate-spin`} />
      </span>
    );
  }
  if (status === 'cancelled') {
    return (
      <span className="flex items-center justify-center w-4 h-4 rounded-full bg-red-500/20">
        <svg className="w-2.5 h-2.5 text-red-400" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 3l6 6M9 3l-6 6" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  // pending
  return (
    <span className="flex items-center justify-center w-4 h-4">
      <span className="w-2 h-2 rounded-full bg-zinc-700" />
    </span>
  );
}

function statusTextClass(status: TaskStatus): string {
  if (status === 'done') return 'text-zinc-400';
  if (status === 'working') return 'text-zinc-200';
  if (status === 'cancelled') return 'text-red-400/60 line-through';
  return 'text-zinc-600';
}

export function AgentProgressCard({
  progress,
  agentId,
  aborted,
  onCancel,
}: {
  progress: AgentProgressData;
  /** The agent's clientId, used to look up colours. */
  agentId: string;
  /** Whether this turn was aborted/cancelled. Overrides working/pending → cancelled. */
  aborted?: boolean;
  /** Cancel this specific agent's turn. Only provided while tasks are incomplete. */
  onCancel?: () => void;
}) {
  const style = getAgentStyle(agentId);

  // When aborted, override any non-done tasks to show as cancelled
  const tasks: TaskItem[] = aborted
    ? progress.tasks.map((t) => t.status === 'done' ? t : { ...t, status: 'cancelled' as const })
    : progress.tasks;

  const doneCount = tasks.filter((t) => t.status === 'done').length;
  const totalCount = tasks.length;

  return (
    <div className={`rounded-lg bg-zinc-900/80 border ${style.border} p-3 my-1.5 max-w-[360px]`}>
      {/* Header with coloured label and progress count */}
      <div className="flex items-center justify-between mb-2.5">
        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${style.pill}`}>
          {style.label}
        </span>
        <span className="text-[10px] text-zinc-600 tabular-nums">{doneCount}/{totalCount}</span>
      </div>

      {/* Progress bar */}
      <div className="h-1 rounded-full bg-zinc-800 mb-3 overflow-hidden">
        <div
          className={`h-full rounded-full ${style.progressBar} transition-all duration-500 ease-out`}
          style={{ width: `${totalCount > 0 ? (doneCount / totalCount) * 100 : 0}%` }}
        />
      </div>

      {/* Task list */}
      <div className="space-y-1.5">
        {tasks.map((task, i) => (
          <div key={i} className="flex items-center gap-2">
            <StatusIcon status={task.status} style={style} />
            <span className={`text-xs ${statusTextClass(task.status)}`}>{task.label}</span>
          </div>
        ))}
      </div>

      {/* Cancelled label */}
      {aborted && (
        <div className="mt-3 text-center text-[11px] font-medium text-red-400/60">
          Cancelled
        </div>
      )}

      {/* Cancel button — visible while there's still work to do and not already aborted */}
      {!aborted && onCancel && doneCount < totalCount && (
        <button
          onClick={onCancel}
          className="mt-3 w-full rounded-md bg-red-950/30 border border-red-900/30 py-1.5 text-xs font-medium text-red-400 hover:bg-red-950/50 hover:text-red-300 transition-colors"
        >
          Cancel this task
        </button>
      )}
    </div>
  );
}
