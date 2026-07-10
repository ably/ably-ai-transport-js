import type { Scenario } from '@ably-ai-demos/frontend';

/** Heading + blurb for the intro card, describing the Temporal execution model. */
export const TEMPORAL_INTRO_TITLE = 'ClientSession + Temporal';

export const TEMPORAL_INTRO_DESCRIPTION =
  'The same Ably-backed ClientSession client as the use-client-session demo — but each turn runs the agent ' +
  'inside a Temporal workflow. The workflow drives a self-controlled agentic loop, one activity per SDK step: ' +
  'open the run, call the model, run a server tool, suspend for a client tool or approval, end the run. If an ' +
  'activity fails, Temporal retries it under the same step id and AIT reconciles — no duplicate output, and the ' +
  'reply still lands over Ably. Each item below exercises a specific piece; try them in order.';

/**
 * The Temporal walkthrough — one scenario feeds both the intro card and the
 * suggestion chip, so a prompt like the durable retry is authored once. Only
 * scenarios this demo's model can drive are listed (no LiveObjects checklist).
 */
export const TEMPORAL_SCENARIOS: readonly Scenario[] = [
  {
    id: 'server-weather',
    tag: 'Server tool',
    title: 'Server-side tool call',
    prompt: `what's the weather in Paris?`,
    blurb:
      'The model returns tool-calls; the workflow runs getWeather in its own runToolStep activity and publishes the result as an SDK step, then a follow-up inference activity summarises it.',
  },
  {
    id: 'retry-stock',
    tag: 'Durable retry',
    title: 'Durable retry',
    prompt: `what's the current stock price of AAPL?`,
    blurb:
      'getStockPrice is intentionally flaky (it throws on an odd price, ~50% of attempts). Temporal retries the activity under the same step id until it succeeds; the retried step supersedes the failed attempt — the reply still settles once, with no duplicate.',
  },
  {
    id: 'client-weather',
    tag: 'Client tool',
    title: 'Client-side tool call (suspend / resume)',
    prompt: `what's the weather?`,
    blurb:
      'getLocation has no server execute, so the workflow suspends and terminates. Your browser resolves the location (permission prompt) and POSTs a continuation; a fresh workflow resumes the same run.',
  },
  {
    id: 'approval-forecast',
    tag: 'Approval-gated tool',
    title: 'Approval-required tool call',
    prompt: `what's the weather forecast for tomorrow in London?`,
    action: (
      <>
        Ask:{' '}
        <span className="font-medium text-foreground">
          &ldquo;what&rsquo;s the weather forecast for tomorrow in London?&rdquo;
        </span>
        , then click <span className="font-medium text-foreground">Approve</span>.
      </>
    ),
    blurb:
      'getWeatherForecast is approval-gated. The workflow suspends until you decide; approving POSTs a continuation and a fresh workflow resumes the run and runs the tool.',
  },
  {
    id: 'edit',
    tag: 'Branching',
    title: 'Edit (branch)',
    gesture: 'hover a user message, click Edit',
    blurb: 'Re-sends as a forked branch rooted at the edited message; a fresh workflow drives the new turn.',
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
    blurb:
      'Stop publishes ai-cancel over Ably; the listenChannel activity turns it into a workflow signal, the in-flight activity aborts, and the run ends cancelled.',
  },
  {
    id: 'multi-tab',
    tag: 'Multi-client sync',
    title: 'Multi-client sync',
    gesture: 'open in new tab (header), then send from either',
    blurb: 'Both tabs share the same Ably channel; the durable run streams to both, in sync.',
  },
  {
    tag: 'Observability',
    title: 'Observability',
    action: (
      <>
        Open the{' '}
        <a
          href="http://localhost:8233"
          target="_blank"
          rel="noreferrer"
          className="font-medium text-foreground underline"
        >
          Temporal Web UI
        </a>{' '}
        (default <span className="font-medium text-foreground">http://localhost:8233</span>).
      </>
    ),
    blurb:
      'Each turn is a workflow run you can inspect end-to-end: one activity per SDK step, and getStockPrice retried under the same activity id until an even price lands — the durable execution history behind the reply.',
  },
];
