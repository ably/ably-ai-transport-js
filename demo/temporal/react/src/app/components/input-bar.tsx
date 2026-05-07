'use client';

import { useCallback, useState } from 'react';

interface InputBarProps {
  /**
   * Submit a user message. The second argument is the current state of
   * the simulate-failure toggle — when true, the agent endpoint throws
   * mid-stream on the activity's first attempt and Temporal's retry
   * succeeds, so the run completes after a visible transient failure.
   */
  onSubmit: (text: string, simulateFail: boolean) => void;
  /** Invoked when the user clicks Stop while a run is in flight. */
  onStop?: () => void;
  /**
   * Invoked when the user clicks Pause. Visible only while a run is
   * `'active'` — pause is a no-op on suspended/terminal runs.
   */
  onPause?: () => void;
  /**
   * Invoked when the user clicks Resume. Visible only when a run is
   * `'suspended'` — resume publishes `x-ably-resume` and sends the
   * Temporal Update that wakes the paused workflow.
   */
  onResume?: () => void;
  /**
   * `'idle'` while no run is in flight (input + Send),
   * `'active'` while a run is streaming (Stop + Pause + disabled input),
   * `'suspended'` while a run is paused (Resume + disabled input).
   */
  state: 'idle' | 'active' | 'suspended';
}

export function InputBar({ onSubmit, onStop, onPause, onResume, state }: InputBarProps) {
  const [input, setInput] = useState('');
  const [simulateFail, setSimulateFail] = useState(false);

  const disabled = state !== 'idle';
  const submit = useCallback(() => {
    const text = input.trim();
    if (text.length === 0 || disabled) return;
    onSubmit(text, simulateFail);
    setInput('');
  }, [input, disabled, simulateFail, onSubmit]);

  const placeholder =
    state === 'idle'
      ? 'Type a message…'
      : state === 'suspended'
        ? 'Run paused — click Resume'
        : 'Waiting for response…';

  return (
    <div className="border-t border-zinc-800 px-4 py-3">
      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          disabled={disabled}
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60"
          autoFocus
        />
        {state === 'active' && onPause !== undefined ? (
          <button
            type="button"
            onClick={onPause}
            className="rounded-md bg-amber-700 px-4 py-2 text-sm font-medium text-zinc-100 transition-colors hover:bg-amber-600"
            aria-label="Pause the running response"
          >
            Pause
          </button>
        ) : null}
        {state === 'active' && onStop !== undefined ? (
          <button
            type="button"
            onClick={onStop}
            className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-zinc-100 transition-colors hover:bg-red-600"
            aria-label="Stop the running response"
          >
            Stop
          </button>
        ) : null}
        {state === 'suspended' && onResume !== undefined ? (
          <button
            type="button"
            onClick={onResume}
            className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-zinc-100 transition-colors hover:bg-emerald-600"
            aria-label="Resume the paused run"
          >
            Resume
          </button>
        ) : null}
        {state === 'idle' ? (
          <button
            type="button"
            onClick={submit}
            disabled={input.trim().length === 0}
            className="rounded-md bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Send
          </button>
        ) : null}
      </div>
      <label className="mt-2 flex items-center gap-2 text-xs text-zinc-500">
        <input
          type="checkbox"
          checked={simulateFail}
          onChange={(e) => setSimulateFail(e.target.checked)}
          disabled={disabled}
          className="h-3.5 w-3.5 cursor-pointer accent-rose-700 disabled:cursor-not-allowed"
        />
        <span>Simulate agent failure (next message)</span>
      </label>
    </div>
  );
}
