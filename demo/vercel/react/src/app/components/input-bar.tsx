'use client';

import { useCallback, useState } from 'react';

interface InputBarProps {
  onSubmit: (text: string) => void;
  /** Invoked when the user clicks Stop while a run is in flight. */
  onStop?: () => void;
  disabled: boolean;
}

export function InputBar({ onSubmit, onStop, disabled }: InputBarProps) {
  const [input, setInput] = useState('');

  const submit = useCallback(() => {
    const text = input.trim();
    if (text.length === 0 || disabled) return;
    onSubmit(text);
    setInput('');
  }, [input, disabled, onSubmit]);

  const showStop = disabled && onStop !== undefined;

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
          placeholder={disabled ? 'Waiting for response…' : 'Type a message…'}
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-500"
          autoFocus
        />
        {showStop ? (
          <button
            type="button"
            onClick={onStop}
            className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-zinc-100 transition-colors hover:bg-red-600"
            aria-label="Stop the running response"
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={disabled || input.trim().length === 0}
            className="rounded-md bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
