import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import type { Scenario } from '../hooks/use-demo-progress';

interface SuggestionChipsProps {
  /** The still-unfinished scenarios to offer, from {@link useDemoProgress}. */
  scenarios: Scenario[];
  /** Called with a scenario's prompt when its chip is clicked (prefills the composer). */
  onSelectPrompt: (prompt: string) => void;
}

/**
 * A wrapping row of chips for the unfinished demo scenarios: prompt scenarios
 * are clickable buttons that prefill the composer; gesture scenarios are
 * dashed, non-clickable reminders.
 */
export function SuggestionChips({ scenarios, onSelectPrompt }: SuggestionChipsProps) {
  if (scenarios.length === 0) return null;

  return (
    <ScrollArea
      data-testid="suggestion-chips"
      className="max-h-[7.5rem]"
    >
      <div className="flex flex-wrap items-start gap-1.5 px-4 py-3">
        {scenarios.map((scenario) =>
          scenario.prompt ? (
            <Button
              key={scenario.id}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => scenario.prompt && onSelectPrompt(scenario.prompt)}
              className="rounded-full"
            >
              <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                {scenario.tag}
              </span>
              &ldquo;{scenario.prompt}&rdquo;
            </Button>
          ) : (
            <Badge
              key={scenario.id}
              variant="outline"
              className="rounded-full border-dashed px-3 py-1 text-muted-foreground"
            >
              <span className="text-[10px] font-semibold tracking-wide uppercase">{scenario.tag}</span>
              {scenario.gesture}
            </Badge>
          ),
        )}
      </div>
    </ScrollArea>
  );
}
