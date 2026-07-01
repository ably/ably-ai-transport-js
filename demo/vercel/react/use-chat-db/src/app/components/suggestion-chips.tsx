import type { DemoStep } from '../hooks/use-demo-progress';

interface SuggestionChipsProps {
  steps: DemoStep[];
  onSelectPrompt: (prompt: string) => void;
}

export function SuggestionChips({ steps, onSelectPrompt }: SuggestionChipsProps) {
  if (steps.length === 0) return null;

  return (
    <div className="chip-scrollbar flex max-h-[7.5rem] flex-wrap items-start gap-1.5 overflow-y-auto px-4 py-3">
      {steps.map((step) =>
        step.type === 'prompt' ? (
          <button
            key={step.id}
            type="button"
            onClick={() => onSelectPrompt(step.prompt)}
            className="rounded-full border border-zinc-700 bg-zinc-900/40 px-3 py-1 text-xs text-zinc-300 hover:border-zinc-500 hover:text-zinc-100 transition-colors"
          >
            <span className="mr-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">{step.tag}</span>
            {step.label}
          </button>
        ) : (
          <span
            key={step.id}
            className="rounded-full border border-dashed border-zinc-700/70 px-3 py-1 text-xs text-zinc-500"
          >
            <span className="mr-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">{step.tag}</span>
            {step.label}
          </span>
        ),
      )}
    </div>
  );
}
