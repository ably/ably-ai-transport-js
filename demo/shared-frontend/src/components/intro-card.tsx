import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import type { Scenario } from '../lib/progress-steps';

/**
 * The baseline scenarios common to every weather-model demo built on Ably. A
 * demo composes its own list from these (selecting, reordering, or inserting its
 * own, e.g. the LiveObjects checklist) and passes it to {@link Chat}, which
 * feeds both this card and the suggestion chips — so each scenario is authored
 * once.
 */
export const COMMON_SCENARIOS: readonly Scenario[] = [
  {
    id: 'server-weather',
    tag: 'Server tool',
    title: 'Server-side tool call',
    prompt: `what's the weather in Tokyo?`,
    blurb: 'The assistant calls getWeather, which runs on the server and streams the result back over Ably.',
  },
  {
    id: 'client-weather',
    tag: 'Client tool',
    title: 'Client-side tool call',
    prompt: `what's the weather like?`,
    blurb:
      'The assistant calls getLocation in your browser (you will see a permission prompt), then feeds the coords into getWeather.',
  },
  {
    id: 'approval-forecast',
    tag: 'Approval-gated tool',
    title: 'Approval-required tool call',
    prompt: `what's the weather forecast for London?`,
    action: (
      <>
        Ask:{' '}
        <span className="font-medium text-foreground">&ldquo;what&rsquo;s the weather forecast for London?&rdquo;</span>
        , then click <span className="font-medium text-foreground">Approve</span> on the card.
      </>
    ),
    blurb:
      'getWeatherForecast pauses at approval-requested. Approve publishes a tool-approval-response event on the channel; the agent resumes and the result lands on the original message.',
  },
  {
    id: 'multi-tab',
    tag: 'Multi-client sync',
    title: 'Multi-client sync',
    gesture: 'open in new tab (header), then send from either',
    blurb: 'Both tabs share the same Ably channel. Messages, streams, and run state stay in sync.',
  },
  {
    id: 'edit',
    tag: 'Branching',
    title: 'Edit (branch)',
    gesture: 'hover a user message, click Edit',
    blurb: 'Re-sends as a forked branch rooted at the edited message.',
  },
  {
    id: 'regenerate',
    tag: 'Branching',
    title: 'Regenerate (branch)',
    gesture: 'hover an assistant reply, click Regenerate',
    blurb: 'Forks a new branch from that point. The previous branch is kept — the tree remembers both.',
  },
  {
    id: 'cancel',
    tag: 'Cancel mid-stream',
    title: 'Cancel mid-stream',
    gesture: 'send a long prompt, click Stop while it streams',
    blurb: 'Cancel is published over Ably; the server cancels the stream and the client closes cleanly.',
  },
  {
    tag: 'Observability',
    title: 'Observability',
    gesture: 'open the Debug pane on the right',
    blurb: 'Three tabs: raw Ably messages on the wire, resolved UIMessage state, and transport lifecycle events.',
  },
];

const DEFAULT_TITLE = 'ClientSession over Ably';
const DEFAULT_DESCRIPTION =
  'A chat wired directly to the Ably AI Transport ClientSession API. The session subscribes to a single Ably ' +
  'channel and exposes a branching conversation tree, a paginated view, and write operations (send, regenerate, ' +
  "edit, cancel). Sessions stay in sync across a user's devices and across multiple participants, with a " +
  'bidirectional channel between user and agent for cancellation and steering. Each item below exercises a ' +
  'specific feature — try them in order to see what it does.';

/** The intro-line body for a scenario: its rich `action`, else its prompt, else its gesture. */
function ScenarioAction({ scenario }: { scenario: Scenario }) {
  if (scenario.action) return <>{scenario.action}</>;
  if (scenario.prompt) {
    return (
      <>
        Ask: <span className="font-medium text-foreground">&ldquo;{scenario.prompt}&rdquo;</span>
      </>
    );
  }
  return <>{scenario.gesture}</>;
}

/**
 * The intro shown at the top of an empty conversation: a heading, a blurb, and a
 * numbered walkthrough of the scenarios to try.
 * @param scenarios - The walkthrough scenarios. Defaults to the shared baseline.
 * @param title - Heading for the card. Defaults to the generic ClientSession heading.
 * @param description - Intro blurb under the heading. Defaults to the generic ClientSession blurb.
 */
export function IntroCard({
  scenarios = COMMON_SCENARIOS,
  title = DEFAULT_TITLE,
  description = DEFAULT_DESCRIPTION,
}: {
  scenarios?: readonly Scenario[];
  title?: string;
  description?: string;
} = {}) {
  return (
    <Card className="mx-auto max-w-2xl">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col gap-4">
          {scenarios.map((scenario, i) => (
            <li
              key={scenario.title}
              className="flex gap-3"
            >
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-border text-xs font-medium text-muted-foreground">
                {i + 1}
              </span>
              <div className="flex flex-1 flex-col gap-1">
                <div className="text-sm font-medium text-foreground">{scenario.title}</div>
                <div className="text-sm text-muted-foreground">
                  <ScenarioAction scenario={scenario} />
                </div>
                <div className="text-xs text-muted-foreground/70">{scenario.blurb}</div>
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
