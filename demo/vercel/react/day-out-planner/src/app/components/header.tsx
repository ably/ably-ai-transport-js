'use client';

interface HeaderProps {
  channelName: string;
  name: string;
  onChangeName: () => void;
}

export function Header({ channelName, name, onChangeName }: HeaderProps) {
  return (
    <header className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3">
      <div className="h-2 w-2 rounded-full bg-emerald-500" />
      <h1 className="text-sm font-medium text-zinc-300">Day out planner</h1>
      <span className="text-xs text-zinc-600 font-mono">#{channelName}</span>
      <div className="ml-auto flex items-center gap-3 text-xs text-zinc-500">
        <span>
          You are <span className="font-mono text-zinc-300">{name}</span>
        </span>
        <button
          type="button"
          onClick={onChangeName}
          className="rounded bg-zinc-800 px-2 py-1 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 transition-colors"
        >
          change name
        </button>
      </div>
    </header>
  );
}
