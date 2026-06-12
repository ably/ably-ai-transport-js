'use client';

interface SuggestionChipsProps {
  prompts: string[];
  onSelectPrompt: (prompt: string) => void;
}

export function SuggestionChips({ prompts, onSelectPrompt }: SuggestionChipsProps) {
  if (prompts.length === 0) return null;

  return (
    <div className="flex flex-wrap items-start gap-1.5 px-4 py-3">
      {prompts.map((prompt) => (
        <button
          key={prompt}
          type="button"
          onClick={() => onSelectPrompt(prompt)}
          className="rounded-full border border-zinc-700 bg-zinc-900/40 px-3 py-1 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100"
        >
          {prompt}
        </button>
      ))}
    </div>
  );
}
