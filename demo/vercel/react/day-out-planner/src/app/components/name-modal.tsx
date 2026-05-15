'use client';

import { useState } from 'react';

export function NameModal({ onSubmit }: { onSubmit: (name: string) => void }) {
  const [value, setValue] = useState('');

  return (
    <div className="flex h-dvh items-center justify-center bg-zinc-950 px-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(value);
        }}
        className="w-full max-w-sm rounded-lg border border-zinc-800 bg-zinc-900 p-6 shadow-xl"
      >
        <h1 className="text-base font-medium text-zinc-100">Day out planner</h1>
        <p className="mt-1 text-xs text-zinc-500">Pick a name so others (and Bernard) know who you are.</p>
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="e.g. alice"
          className="mt-4 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-500"
        />
        <button
          type="submit"
          disabled={!value.trim()}
          className="mt-3 w-full rounded-md bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 hover:bg-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Join chat
        </button>
      </form>
    </div>
  );
}
