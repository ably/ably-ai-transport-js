# Ably AI Transport — Temporal + React basic chat demo

A chat UI that publishes assistant responses over Ably using the AI
Transport SDK, with the agent loop driven by a [Temporal][1] workflow.
The workflow uses the Vercel AI SDK's `streamText` from inside an
activity — every iteration of the model loop becomes one Temporal
activity and one AIT step on the Ably channel.

[1]: https://docs.temporal.io/

## Architecture

```
                                         ┌─────────────────────────────────────┐
                                         │  Temporal worker process            │
                                         │  (`npm run worker`)                 │
                                         │                                     │
                                         │   runAgent workflow                 │
                                         │     ├─ openRun (activity)           │
   browser ──── /api/agent ──► Next.js   │     ├─ for each iteration:          │
      │           (queue)     server ────┤     │    └─ streamStep (activity)   │
      │                                  │     │         streamText + step.pipe│
      │                                  │     └─ endRun (activity)            │
      │                                  └─────────────────┬───────────────────┘
      │                                                    │
      └──────────────  Ably channel  ◄─────────────────────┘
                       (UIMessageCodec)
```

- The **Next.js process** serves the React UI, an Ably JWT endpoint, and
  the `/api/agent` route. The route validates the `Invocation`, starts a
  `runAgent` workflow, and returns `202 Accepted`. It does **not** open
  an Ably session.
- The **Temporal worker process** registers the demo's three activities
  (`openRun`, `streamStep`, `endRun`). The worker pre-warms the
  {@link AgentSession} for the default session at startup so the channel
  is attached before the first user message can land.
- The **streaming response** travels over Ably, not HTTP — the browser
  is already subscribed to the session channel and renders chunks as
  they arrive.

### What the workflow looks like

```ts
import { proxyActivities } from '@temporalio/workflow';

const { openRun, streamStep, endRun } = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
});

export async function runAgent(input: RunAgentInput) {
  await openRun(input);

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const { finishReason } = await streamStep({
        runId: input.runId,
        sessionName: input.sessionName,
      });
      if (finishReason !== 'tool-calls') break;
    }
    await endRun({ runId: input.runId });
  } catch (error) {
    await endRun({ runId: input.runId, errorMessage: String(error) });
    throw error;
  }
}
```

`streamStep` calls `streamText` from the Vercel AI SDK, pipes the
resulting `UIMessageChunk` stream through `step.pipe(...)`, and returns
the iteration's finish reason. Each iteration reads the canonical
conversation history from the run's view after `step.start()` lands —
that ordering is what excludes retried or aborted predecessors from the
model context (Spec: AIT-CN2/CN3). The workflow loop keeps going while
the model keeps calling tools.

## Why Temporal?

Wrapping the agent loop in a Temporal workflow gives:

- **Durability** — every iteration is a Temporal activity. If the
  worker crashes between iterations, the workflow resumes from the
  last successful step.
- **Idempotency** — `workflowId = run-agent-${runId}-${stepId | uuid}`
  lets Temporal de-duplicate accidental double-submits.
- **Operational visibility** — every iteration shows up in Temporal's
  UI as a row with input, output, retries, and stack traces.

## Prerequisites

1. **Node.js 20+** and **npm**.
2. **A Temporal dev server** running locally on `127.0.0.1:7233`. The
   easiest way:

   ```bash
   brew install temporal     # or: see https://docs.temporal.io/cli
   temporal server start-dev
   ```

   The Temporal Web UI is at <http://localhost:8233>.

   > **Note** — the worker connects via `127.0.0.1`, not `localhost`. The
   > Rust gRPC client inside `@temporalio/core-bridge` doesn't always
   > resolve `localhost` to `127.0.0.1`, and the dev server only binds
   > to IPv4. Override with `TEMPORAL_ADDRESS` if your server is elsewhere.

3. **An Ably API key** with publish/subscribe/history capabilities.
4. **An Anthropic API key**.

## Setup

```bash
cd demo/temporal/react
cp .env.local.example .env.local
# Edit .env.local — set ABLY_API_KEY and ANTHROPIC_API_KEY at minimum.
npm install
```

## Running

You need three processes: Temporal server, the Temporal worker, and Next.js.

In separate terminals:

```bash
# 1. Temporal dev server
temporal server start-dev

# 2. Temporal worker (registers the demo's activities)
npm run worker

# 3. Next.js dev server
npm run dev
```

Open <http://localhost:3000>, type a message, and watch the response
land. The same conversation is visible in any other tab pointed at the
same session — open <http://localhost:3000?session=demo-session> in two
browsers to confirm.

You can inspect each agent invocation in the Temporal Web UI at
<http://localhost:8233> — drill into a workflow to see the
`openRun`, `streamStep`, and `endRun` activities for each run.

## Files of interest

| File                         | Purpose                                                                 |
| ---------------------------- | ----------------------------------------------------------------------- |
| `src/temporal/workflows.ts`  | `runAgent` workflow that drives the iteration loop.                     |
| `src/temporal/activities.ts` | `openRun` / `streamStep` / `endRun` AIT activities.                     |
| `src/temporal/worker.ts`     | Worker entry point — registers the activities and polls the task queue. |
| `src/lib/agent-session.ts`   | Cached `AgentSession` factory used inside the worker.                   |
| `src/lib/bash-session.ts`    | Cached `BashToolkit` factory — the agent's only tool.                   |
| `src/lib/run-cache.ts`       | Process-local cache of `AgentRun` handles keyed by runId.               |
| `src/lib/temporal-client.ts` | Cached Temporal `Client` used by the API route.                         |
| `src/app/api/agent/route.ts` | Validates the invocation and starts the `runAgent` workflow.            |

## Differences from `demo/vercel/react`

- The agent loop runs inside a Temporal workflow. Each iteration is a
  Temporal activity (`streamStep`).
- The `/api/agent` handler does not open an `AgentSession`; it submits
  a workflow and returns 202.
- A new process (`npm run worker`) hosts the workflow + activities.
- New dependencies on `@temporalio/{client,worker,workflow,activity}`.
- The browser code, the Ably JWT route, the bash tool, and the
  `UIMessageCodec` integration are unchanged.

## Caveats

- The {@link AgentRun} for a run is cached in the worker process by
  runId. If the worker restarts mid-run, in-flight activities won't
  find the cached handle and will throw — the workflow's catch path
  publishes a failed run-end. The user's retry button replays the run
  cleanly.
- The worker holds a single `Ably.Realtime` connection shared across
  all sessions. Restart the worker if you change `ABLY_API_KEY`.
