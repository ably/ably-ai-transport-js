'use client';

import type { ReactNode } from 'react';

interface DemoStep {
  title: string;
  action: ReactNode;
  demonstrates: string;
}

const STEPS: DemoStep[] = [
  {
    title: 'Durable turn on a Workflow',
    action: (
      <>
        Ask:{' '}
        <span className="font-medium text-zinc-100">
          &ldquo;Say &lsquo;Hello from a durable Vercel Workflow!&rsquo;&rdquo;
        </span>
      </>
    ),
    demonstrates:
      'Each turn runs as a Vercel Workflow. An open activity opens the AIT run, then a separate inference activity — a fresh process — runs the model and streams the reply. The badges under it show its run, step, and how many attempts the step took.',
  },
  {
    title: 'Fault injection → durable retry',
    action: (
      <>
        Arm <span className="font-medium text-zinc-100">Fail once</span> or{' '}
        <span className="font-medium text-zinc-100">Crash</span> below, then send any prompt.
      </>
    ),
    demonstrates:
      'The activity throws on its first attempt; WDK re-runs it as a fresh process, and AIT’s stable step id makes the retry supersede the dead attempt — the conversation settles once, with no duplicate. Watch it happen in the WDK processes panel.',
  },
  {
    title: 'Server-side tool call',
    action: (
      <>
        Ask: <span className="font-medium text-zinc-100">&ldquo;what&rsquo;s the weather in Tokyo?&rdquo;</span>
      </>
    ),
    demonstrates:
      'The workflow runs getWeather in its own retryable tool activity and publishes the result as an AIT step; a follow-up inference activity summarises it.',
  },
  {
    title: 'Client-side tool call',
    action: (
      <>
        Ask: <span className="font-medium text-zinc-100">&ldquo;what&rsquo;s the weather like?&rdquo;</span>
      </>
    ),
    demonstrates:
      'The model calls getLocation; the run suspends, your browser resolves it (you’ll see a permission prompt), and a fresh workflow resumes the run with the coordinates.',
  },
  {
    title: 'Approval-gated tool call',
    action: (
      <>
        Ask:{' '}
        <span className="font-medium text-zinc-100">&ldquo;what&rsquo;s the weather forecast for London?&rdquo;</span>,
        then click <span className="font-medium text-zinc-100">Approve</span>.
      </>
    ),
    demonstrates:
      'getWeatherForecast is gated on your approval. The run suspends with an Approve / Deny card; only after you approve does a fresh workflow resume it and run the tool.',
  },
  {
    title: 'WDK processes',
    action: (
      <>
        Watch the <span className="font-medium text-zinc-100">WDK processes</span> panel on the right.
      </>
    ),
    demonstrates:
      'Every workflow and its activities appear as they run, correlated to the AIT run id, with WDK-side status polled from the real Workflow observability API.',
  },
  {
    title: 'Cancel mid-stream',
    action: (
      <>
        Send a long prompt, then click <span className="font-medium text-zinc-100">Stop</span> while it streams.
      </>
    ),
    demonstrates: 'Cancel is published over Ably; the running activity aborts and the run closes cleanly.',
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
        Open the <span className="font-medium text-zinc-100">Debug pane</span> on the right.
      </>
    ),
    demonstrates:
      'Three tabs: raw Ably messages on the wire, resolved UIMessage state, and transport lifecycle events.',
  },
];

/**
 * The intro shown at the top of the message list: what the demo is, and a
 * numbered walkthrough of the durable-execution features to try, in order.
 */
export function IntroCard() {
  return (
    <div className="mx-auto max-w-2xl space-y-6 py-8">
      <header className="space-y-2">
        <h2 className="text-lg font-semibold text-zinc-100">Durable sessions on Vercel Workflows</h2>
        <p className="text-sm text-zinc-300">
          The same Ably-backed <span className="font-medium text-zinc-100">useChat</span> client as the use-chat demo —
          but each turn runs on Vercel&rsquo;s Workflow Development Kit. A durable workflow drives the agent loop across
          separate, retryable activity processes, each rebuilding the AIT run from the Ably channel. If an activity
          fails or its process dies, WDK re-runs it and AIT reconciles — no duplicate output, and the reply still lands
          over Ably. Each item below exercises a specific piece; try them in order.
        </p>
      </header>

      <ol className="space-y-4">
        {STEPS.map((step, i) => (
          <li
            key={step.title}
            className="flex gap-3"
          >
            <span className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-zinc-700 text-xs font-medium text-zinc-300">
              {i + 1}
            </span>
            <div className="flex-1 space-y-1">
              <div className="text-sm font-medium text-zinc-100">{step.title}</div>
              <div className="text-sm text-zinc-300">{step.action}</div>
              <div className="text-xs text-zinc-400">{step.demonstrates}</div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
