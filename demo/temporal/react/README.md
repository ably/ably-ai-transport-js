# Ably AI Transport — Temporal + React basic chat demo

A minimal chat UI that streams an Anthropic response over Ably using the AI
Transport SDK, with the agent invocation orchestrated by a [Temporal][1]
workflow.

This is a port of `demo/vercel/react`. The browser, Ably channel, and codec
behaviour are identical — the only difference is that the `/api/agent` HTTP
handler hands the invocation off to a Temporal workflow instead of running
the streaming exchange inline.

[1]: https://docs.temporal.io/

## Architecture

```
                                         ┌────────────────────────────┐
                                         │  Temporal worker process   │
                                         │  (`npm run worker`)        │
                                         │                            │
   browser ──── /api/agent ──► Next.js   │   chatTurn workflow        │
      │           (queue)     server ────┼──►  └─ runAgentTurn        │
      │                                  │        activity            │
      │                                  │        ├─ AgentSession     │
      │                                  │        ├─ streamText       │
      │                                  │        └─ step.pipe        │
      │                                  └────────────┬───────────────┘
      │                                               │
      └─────────── Ably channel  ◄────────────────────┘
                  (UIMessageCodec)
```

- The **Next.js process** serves the React UI, an Ably JWT endpoint, and the
  `/api/agent` route. The route validates the `Invocation`, starts a Temporal
  workflow, and returns `202 Accepted`. It does **not** open an Ably session.
- The **Temporal worker process** hosts the `chatTurn` workflow and the
  `runAgentTurn` activity. It owns the long-lived `AgentSession` that the
  agent uses to publish onto the Ably channel. The worker pre-warms the
  session at startup so the channel is attached before the first user
  message can land on it.
- The streaming response travels over **Ably**, not HTTP — the browser is
  already subscribed to the session channel and renders chunks as they land.

## Why Temporal?

The AI Transport SDK's `AgentSession` / `createRun` / `createStep` API is
already a clean async function. Wrapping it in a Temporal workflow gives:

- **Durability** — if the worker crashes mid-stream, Temporal records the
  workflow input. (Note: the demo doesn't checkpoint streamed chunks; a
  retried activity starts the model call from scratch. The forking semantics
  in the AI Transport SDK make a dropped run safe to redo.)
- **Idempotency** — `workflowId = chat-turn-${runId}-${stepId | uuid}` lets
  Temporal de-duplicate accidental double-submits.
- **Operational visibility** — every agent invocation is a row in Temporal's
  UI with input, output, retries, and stack traces.

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

# 2. Temporal worker (hosts the chatTurn workflow + runAgentTurn activity)
npm run worker

# 3. Next.js dev server
npm run dev
```

Open <http://localhost:3000>, type a message, and watch the response stream
back. The same conversation is visible in any other tab pointed at the same
session — open <http://localhost:3000?session=demo-session> in two browsers
to confirm.

You can inspect each agent invocation in the Temporal Web UI at
<http://localhost:8233>.

## Files of interest

| File                         | Purpose                                                                    |
| ---------------------------- | -------------------------------------------------------------------------- |
| `src/app/api/agent/route.ts` | Validates the invocation and starts the `chatTurn` workflow.               |
| `src/temporal/workflows.ts`  | Workflow definition. Calls `runAgentTurn` and waits for it to finish.      |
| `src/temporal/activities.ts` | Activity that drives the run/step/pipe lifecycle through `AgentSession`.   |
| `src/temporal/worker.ts`     | Worker entry point. Pre-warms the `AgentSession` and registers activities. |
| `src/lib/agent-session.ts`   | Cached `AgentSession` factory used inside the worker.                      |
| `src/lib/temporal-client.ts` | Cached Temporal `Client` used by the API route.                            |

## Differences from `demo/vercel/react`

- `instrumentation.ts` is gone — the agent lives in the worker, so Next.js
  doesn't pre-warm anything.
- The `/api/agent` handler does not open an `AgentSession`; it submits a
  workflow and returns 202.
- A new process (`npm run worker`) hosts the actual agent. The `AgentSession`
  cache lives in this process.
- A new dependency on `@temporalio/{client,worker,workflow,activity}`.

The browser code, the Ably JWT route, and the `UIMessageCodec` integration
are unchanged.

## Caveats

- The activity does not heartbeat, so workflow cancellation does **not**
  abort an in-flight stream. Client-initiated cancellation through the
  AI Transport SDK still works — `step.signal` is wired via the Ably
  channel, independent of Temporal.
- The worker holds a single `Ably.Realtime` connection shared across all
  sessions. Restart the worker if you change `ABLY_API_KEY`.
