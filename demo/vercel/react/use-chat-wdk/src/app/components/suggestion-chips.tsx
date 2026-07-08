'use client';

/** A predefined prompt the user can drop into the composer with one click. */
interface PromptChip {
  /** Short uppercase category — what path this prompt exercises. */
  tag: string;
  /** The exact prompt text placed into the input. */
  prompt: string;
}

/**
 * Predefined prompts shown above the composer, each tagged with the path it
 * exercises. The mock LLM (used in tests) scripts a reply for each.
 */
const PROMPTS: PromptChip[] = [
  { tag: 'Durable text', prompt: 'Say "Hello from a durable Vercel Workflow!"' },
  { tag: 'Server tool', prompt: "What's the weather in Tokyo?" },
  { tag: 'Client tool', prompt: "What's the weather like?" },
  { tag: 'Approval-gated tool', prompt: "What's the weather forecast for London?" },
];

export function SuggestionChips({ onSelectPrompt }: { onSelectPrompt: (prompt: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5 px-4 pt-3">
      {PROMPTS.map((chip) => (
        <button
          key={chip.prompt}
          type="button"
          onClick={() => onSelectPrompt(chip.prompt)}
          className="rounded-full border border-zinc-700 bg-zinc-900/40 px-3 py-1 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100"
        >
          <span className="mr-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">{chip.tag}</span>
          {chip.prompt}
        </button>
      ))}
    </div>
  );
}
