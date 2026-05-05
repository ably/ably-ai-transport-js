'use client';

interface HeaderProps {
  clientId?: string;
  split?: boolean;
  onToggleSplit?: () => void;
}

export function Header({ clientId, split, onToggleSplit }: HeaderProps) {
  return (
    <header className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
      <div className="h-2 w-2 rounded-full bg-emerald-500" />
      <h1 className="text-sm font-medium text-zinc-300">Ably AI — Client Session Demo</h1>
      {onToggleSplit && (
        <button
          type="button"
          onClick={onToggleSplit}
          className={`ml-4 rounded px-2 py-1 text-xs font-medium transition-colors ${
            split ? 'bg-zinc-600 text-zinc-100' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-300'
          }`}
        >
          {split ? 'Single Pane' : 'Split Pane'}
        </button>
      )}
      {clientId && <span className="ml-auto text-xs text-zinc-600 font-mono">{clientId}</span>}
    </header>
  );
}
