import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { DemoStep } from '../hooks/use-demo-progress';

interface SuggestionChipsProps {
  steps: DemoStep[];
  onSelectPrompt: (prompt: string) => void;
}

export function SuggestionChips({ steps, onSelectPrompt }: SuggestionChipsProps) {
  if (steps.length === 0) return null;

  return (
    <div
      data-testid="suggestion-chips"
      className="chip-scrollbar flex max-h-[7.5rem] flex-wrap items-start gap-1.5 overflow-y-auto px-4 py-3"
    >
      {steps.map((step) =>
        step.type === 'prompt' ? (
          <Button
            key={step.id}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onSelectPrompt(step.prompt)}
            className="rounded-full"
          >
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{step.tag}</span>
            {step.label}
          </Button>
        ) : (
          <Badge
            key={step.id}
            variant="outline"
            className="rounded-full border-dashed px-3 py-1 text-muted-foreground"
          >
            <span className="text-[10px] font-semibold uppercase tracking-wide">{step.tag}</span>
            {step.label}
          </Badge>
        ),
      )}
    </div>
  );
}
