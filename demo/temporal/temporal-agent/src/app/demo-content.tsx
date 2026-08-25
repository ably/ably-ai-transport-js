import type { Scenario } from '@ably-ai-demos/frontend';

/** Heading + blurb for the intro card, describing the Temporal execution model. */
export const TEMPORAL_INTRO_TITLE = 'useChat + Temporal';

export const TEMPORAL_INTRO_DESCRIPTION =
  'A useChat client over the Ably chat transport — but each turn runs the agent inside a Temporal workflow. ' +
  'The workflow drives a self-controlled agentic loop, one activity per transport step: open the run, call the ' +
  'model, run a server tool, suspend for a client tool or approval, end the run. If an activity fails, Temporal ' +
  'retries it under the same step id and the retried output supersedes the failed attempt on the channel — no ' +
  'duplicate output, and the reply still lands over Ably. Each item below exercises a specific piece; try them in order.';

/**
 * The Temporal walkthrough — one scenario feeds both the intro card and the
 * suggestion chip, so a prompt like the durable retry is authored once. Only
 * scenarios this demo's model can drive are listed.
 */
export const TEMPORAL_SCENARIOS: readonly Scenario[] = [
  {
    id: 'server-weather',
    tag: 'Server tool',
    title: 'Server-side tool call',
    prompt: `what's the weather in Paris?`,
    blurb:
      'The model returns tool-calls; the workflow runs getWeather in its own runToolStep activity and publishes the result as a transport step, then a follow-up inference activity summarises it.',
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
      'getLocation has no server execute, so the workflow suspends the run and terminates. Your browser resolves the location (permission prompt), publishes the tool output on the channel, and POSTs a continuation; a fresh workflow resumes the same run.',
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
    id: 'cancel',
    tag: 'Cancel mid-stream',
    title: 'Cancel mid-stream',
    gesture: 'send a long prompt, click Stop while it streams',
    blurb:
      'Stop publishes ai-cancel over Ably; the SDK routes it to the in-flight activity, whose run aborts the model stream and publishes ai-run-end{cancelled} inline.',
  },
  {
    tag: 'Resume a live run',
    title: 'Resume a live run',
    gesture: 'send a long prompt, then reload (or open in a new tab) mid-stream',
    blurb:
      'The reply lives on the channel, not in the HTTP response. A page that loads while a run is streaming reconnects to it: the transport replays the run from channel history and goes live.',
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
      'Each turn is a workflow run you can inspect end-to-end: one activity per transport step, and getStockPrice retried under the same activity id until an even price lands — the durable execution history behind the reply.',
  },
];
