'use client';

export function Header({ clientId }: { clientId?: string }) {
  return (
    <header className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
      <div className="h-2 w-2 rounded-full bg-emerald-500" />
      <h1 className="text-sm font-medium text-zinc-300">Ably AI — Client Transport Demo</h1>
      {clientId && <span className="ml-auto text-xs text-zinc-600 font-mono">{clientId}</span>}
    </header>
  );
}
