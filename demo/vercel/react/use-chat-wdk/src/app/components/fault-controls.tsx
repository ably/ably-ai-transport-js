'use client';

import type { FaultMode } from '../lib/fault';

interface FaultOption {
  value: FaultMode | undefined;
  label: string;
  /** One-line explanation shown when this mode is armed. */
  description: string;
}

const OPTIONS: FaultOption[] = [
  { value: undefined, label: 'No fault', description: 'Run the next turn normally.' },
  {
    value: 'fail-once',
    label: 'Fail once',
    description:
      'Graceful transient failure: the activity throws a WDK RetryableError (with a 1s backoff) on its first attempt. WDK waits, then re-runs it — it succeeds on attempt 2.',
  },
  {
    value: 'crash',
    label: 'Crash',
    description:
      'Unhandled failure: the activity throws a plain Error on its first attempt (a bug or worker crash — no backoff hint). WDK re-runs it as a fresh process on its default schedule.',
  },
];

/**
 * Arms a fault for the next turn's first activity. The armed mode rides the send
 * POST (via the transport's prepareSendMessagesRequest) into the workflow, which
 * makes the activity throw on its first attempt so WDK retries it — the retry
 * supersedes the dead attempt (AIT reconciles) with no duplicate output. Both
 * modes throw; they differ in how a real durable system would treat the throw
 * (a signalled retryable failure vs. an unhandled crash).
 */
export function FaultControls({
  fault,
  onChange,
}: {
  fault: FaultMode | undefined;
  onChange: (fault: FaultMode | undefined) => void;
}) {
  const armed = OPTIONS.find((option) => option.value === fault && option.value !== undefined);

  return (
    <div className="px-4 pt-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-zinc-500">Fault injection:</span>
        {OPTIONS.map((option) => {
          const active = fault === option.value;
          return (
            <button
              key={option.label}
              type="button"
              onClick={() => onChange(option.value)}
              title={option.description}
              className={`rounded-full border px-2.5 py-0.5 transition-colors ${
                active
                  ? 'border-amber-600 bg-amber-950 text-amber-300'
                  : 'border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {armed && <p className="mt-1.5 leading-snug text-amber-400/90">Armed — {armed.description}</p>}
    </div>
  );
}
