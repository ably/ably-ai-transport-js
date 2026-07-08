import type { DemoStep, PromptDemoStep } from '@ably-ai-demos/frontend';

/** Heading + blurb for the intro card, describing the Temporal execution model. */
export const TEMPORAL_INTRO_TITLE = 'ClientSession + Temporal';

export const TEMPORAL_INTRO_DESCRIPTION =
  'The same Ably-backed ClientSession client as the use-client-session demo — but each turn runs the agent ' +
  'inside a Temporal workflow. The workflow drives a self-controlled agentic loop, one activity per SDK step: ' +
  'open the run, call the model, run a server tool, suspend for a client tool or approval, end the run. If an ' +
  'activity fails, Temporal retries it under the same step id and AIT reconciles — no duplicate output, and the ' +
  'reply still lands over Ably. Each item below exercises a specific piece; try them in order.';

/** Temporal-specific walkthrough shown at the top of an empty conversation. */
export const TEMPORAL_DEMO_STEPS: readonly DemoStep[] = [
  {
    title: 'Server-side tool call',
    action: (
      <>
        Ask: <span className="font-medium text-zinc-100">&ldquo;what&rsquo;s the weather in Paris?&rdquo;</span>
      </>
    ),
    demonstrates:
      'The model returns tool-calls; the workflow runs getWeather in its own runToolStep activity and publishes the result as an SDK step, then a follow-up inference activity summarises it.',
  },
  {
    title: 'Durable retry',
    action: (
      <>
        Ask:{' '}
        <span className="font-medium text-zinc-100">&ldquo;what&rsquo;s the current stock price of AAPL?&rdquo;</span>
      </>
    ),
    demonstrates:
      'getStockPrice is intentionally flaky (it throws on an odd price, ~50% of attempts). Temporal retries the activity under the same step id until it succeeds; the retried step supersedes the failed attempt — the reply still settles once, with no duplicate.',
  },
  {
    title: 'Client-side tool call (suspend / resume)',
    action: (
      <>
        Ask: <span className="font-medium text-zinc-100">&ldquo;what&rsquo;s the weather?&rdquo;</span>
      </>
    ),
    demonstrates:
      'getLocation has no server execute, so the workflow suspends and terminates. Your browser resolves the location (permission prompt) and POSTs a continuation; a fresh workflow resumes the same run.',
  },
  {
    title: 'Approval-required tool call',
    action: (
      <>
        Ask:{' '}
        <span className="font-medium text-zinc-100">
          &ldquo;what&rsquo;s the weather forecast for tomorrow in London?&rdquo;
        </span>
        , then click <span className="font-medium text-zinc-100">Approve</span>.
      </>
    ),
    demonstrates:
      'getWeatherForecast is approval-gated. The workflow suspends until you decide; approving POSTs a continuation and a fresh workflow resumes the run and runs the tool.',
  },
  {
    title: 'Cancel mid-stream',
    action: (
      <>
        Send a long prompt, then click <span className="font-medium text-zinc-100">Stop</span> while it streams.
      </>
    ),
    demonstrates:
      'Stop publishes ai-cancel over Ably; the listenChannel activity turns it into a workflow signal, the in-flight activity aborts, and the run ends cancelled.',
  },
  {
    title: 'Multi-client sync',
    action: (
      <>
        Click <span className="font-medium text-zinc-100">open in new tab</span> in the header, then send from either.
      </>
    ),
    demonstrates: 'Both tabs share the same Ably channel; the durable run streams to both, in sync.',
  },
  {
    title: 'Observability',
    action: (
      <>
        Open the{' '}
        <a
          href="http://localhost:8233"
          target="_blank"
          rel="noreferrer"
          className="font-medium text-zinc-100 underline"
        >
          Temporal Web UI
        </a>{' '}
        (default <span className="font-medium text-zinc-100">http://localhost:8233</span>).
      </>
    ),
    demonstrates:
      'Each turn is a workflow run you can inspect end-to-end: one activity per SDK step, and getStockPrice retried under the same activity id until an even price lands — the durable execution history behind the reply.',
  },
];

/**
 * Suggestion chip for the durable-retry scenario. Appended to the shared
 * baseline via Chat's `extraProgressSteps` so it only appears in this demo,
 * whose model drives getStockPrice (a generic weather model can't).
 */
export const STOCK_RETRY_STEP: PromptDemoStep = {
  id: 'retry-stock',
  type: 'prompt',
  tag: 'Durable retry',
  label: `"what's the current stock price of AAPL?"`,
  prompt: `what's the current stock price of AAPL?`,
};
