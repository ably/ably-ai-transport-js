'use client';

import type { SlashCommand } from '../hooks/use-slash-commands';

interface SlashAutocompleteProps {
  suggestions: SlashCommand[];
  selectedIndex: number;
  onSelect: (command: SlashCommand) => void;
}

export function SlashAutocomplete({ suggestions, selectedIndex, onSelect }: SlashAutocompleteProps) {
  if (suggestions.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 rounded-md border border-zinc-700 bg-zinc-900 shadow-lg overflow-hidden max-h-[200px] overflow-y-auto">
      {suggestions.map((cmd, i) => (
        <button
          key={cmd.name}
          onClick={() => onSelect(cmd)}
          className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between transition-colors ${
            i === selectedIndex ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-400 hover:bg-zinc-800/50'
          }`}
        >
          <span className="font-mono text-xs">{cmd.name}</span>
          <span className="text-[10px] text-zinc-600 ml-2">{cmd.description}</span>
        </button>
      ))}
    </div>
  );
}
