'use client';

/**
 * A compact widget pinned at the bottom of the conversation, rendering the
 * agent's shared task checklist (LiveObjects state on the session channel).
 * The agent writes through the updateChecklist tool; this widget only
 * observes, re-rendering whenever the object changes.
 *
 * It hydrates from object sync on channel attach, so on a reload the current
 * progress reappears before any conversation history has loaded — the thing
 * this demo is here to show. Nothing renders until the agent starts a
 * checklist.
 */

import { useChecklist, type ObjectSession } from '../hooks/use-checklist';
import type { ChecklistItemRow } from '../lib/checklist';

function StatusIcon({ status }: { status: ChecklistItemRow['status'] }) {
  if (status === 'done') {
    return (
      <span
        className="flex-shrink-0 text-emerald-400"
        aria-label="done"
      >
        ✓
      </span>
    );
  }
  if (status === 'active') {
    return (
      <span
        className="h-2.5 w-2.5 flex-shrink-0 animate-pulse rounded-full bg-amber-400"
        aria-label="in progress"
      />
    );
  }
  return (
    <span
      className="h-2.5 w-2.5 flex-shrink-0 rounded-full border border-zinc-600"
      aria-label="pending"
    />
  );
}

function StepItem({ step }: { step: ChecklistItemRow }) {
  const textClass =
    step.status === 'done'
      ? 'text-xs text-zinc-500 line-through'
      : step.status === 'active'
        ? 'text-xs text-zinc-100'
        : 'text-xs text-zinc-400';
  return (
    <li className="flex items-center gap-2">
      <StatusIcon status={step.status} />
      <span className={`${textClass} break-words`}>{step.text}</span>
    </li>
  );
}

/** A segment per step, coloured by that step's status — no dynamic width. */
function ProgressBar({ steps }: { steps: ChecklistItemRow[] }) {
  return (
    <div className="flex h-1 flex-shrink-0 gap-px bg-zinc-900">
      {steps.map((step) => (
        <div
          key={step.index}
          className={
            step.status === 'done'
              ? 'flex-1 bg-emerald-500 transition-colors'
              : step.status === 'active'
                ? 'flex-1 bg-amber-400/60 transition-colors'
                : 'flex-1 bg-zinc-800 transition-colors'
          }
        />
      ))}
    </div>
  );
}

export function ChecklistWidget({ session }: { session: ObjectSession }) {
  const { steps, error } = useChecklist(session);
  const done = steps.filter((step) => step.status === 'done').length;

  // Only present once the agent has a checklist (or hit an error loading it),
  // so the widget stays out of the way for simple one-step conversations.
  if (!error && steps.length === 0) return null;

  return (
    <section
      aria-label="Agent tasks"
      className="mb-3 ml-4 w-fit min-w-[15rem] max-w-[26rem] self-start overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/60"
    >
      <div className="flex items-center justify-between gap-6 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-zinc-300">Agent tasks</span>
          <span className="text-[10px] text-zinc-600">LiveObjects</span>
        </div>
        {steps.length > 0 && (
          <span className="font-mono text-[10px] text-zinc-500">
            {done} / {steps.length}
          </span>
        )}
      </div>

      {steps.length > 0 && <ProgressBar steps={steps} />}

      <div className="max-h-40 overflow-y-auto px-3 py-2">
        {error ? (
          <p className="text-xs text-red-400 break-words">Couldn&apos;t load checklist: {error.message}</p>
        ) : (
          <ul className="space-y-1.5">
            {steps.map((step) => (
              <StepItem
                key={step.index}
                step={step}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
