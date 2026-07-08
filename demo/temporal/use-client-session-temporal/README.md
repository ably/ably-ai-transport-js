# `useClientSession` + Temporal demo

A Next.js chat app where the agent side runs inside a **[Temporal](https://temporal.io/)** workflow. The client is identical to `use-client-session` — the SDK's lower-level React hooks drive an `AgentSession` on the Ably channel. What differs is the server: instead of a single `streamText` call in an API route, the API route starts a Temporal workflow that drives a self-controlled agentic loop, one activity per SDK step.

The channel defaults to `ai:demo` (`NEXT_PUBLIC_ABLY_CHANNEL`); `?channel=<name>` overrides it.

## What this demonstrates

- `session.adoptRun(...)` + `run.createStep({ stepId: stepIdFor(invocationId) })` — the SDK's purpose-built pairing for durable execution. `stepIdFor` (from `@ably/ai-transport/temporal`) composes the run's invocation id with the current Temporal `activityId`.
- One Temporal activity per SDK step: `openRun`, one `runInferenceStep` per LLM call, one `runToolStep` per server tool, `suspendRun` / `endRun`.
- **Retry supersession**: Temporal re-runs a failed activity under the same `activityId`, so its `stepIdFor`-derived `stepId` is identical on the retry and the retried step's channel output cleanly supersedes the failed attempt.
- A long-running `listenChannel` activity translates channel-level cancel events into a workflow signal.

## Prerequisites

- Node.js >= 22
- pnpm 11 (`corepack enable` once)
- **Temporal CLI**: `brew install temporal` (macOS) — [other platforms](https://learn.temporal.io/getting_started/typescript/dev_environment/)
- An [Ably API key](https://ably.com/accounts)
- An AI provider key (Anthropic, OpenAI, or Vercel AI Gateway) for interactive use. The e2e tests use a bundled deterministic mock model, selected with `MOCK_LLM=1`; interactive use needs a real provider key (without either, `createModel()` throws).

## Setup

The demo links the SDK from the repo root (`link:../../..`) and loads its built `dist/`, so build the SDK first.

```bash
# 1. Build the SDK (from the repository root)
pnpm install
pnpm run build

# 2. Configure env (from this directory)
cp .env.local.example .env.local
# then set ABLY_API_KEY and an AI provider key

# 3. Install
pnpm install
```

Then, **in three terminals**:

```bash
# Terminal 1 — Temporal dev server (persists across restarts via --db-filename)
temporal server start-dev --db-filename ai-transport-demo.db

# Terminal 2 — Temporal worker (workflows + activities)
pnpm dev:worker

# Terminal 3 — Next.js
pnpm dev
```

Open the app at <http://localhost:3000>. Open the Temporal Web UI at <http://localhost:8233>.

The debug pane in the app has a **"View latest run in Temporal"** link that opens the current run's workflow in the Temporal Web UI.

## Try this

Each prompt exercises a different path through the workflow.

- **Server tool** — _"What's the weather in Paris?"_ — `runInferenceStep` returns tool-calls → `runToolStep(getWeather)` → next `runInferenceStep` → done.
- **Retry** — _"What's the current stock price of AAPL?"_ — `getStockPrice` is intentionally flaky: it rolls a whole-dollar price and throws on an odd one (~50% of attempts). Temporal retries the activity until an even price succeeds, and each retried step supersedes the failed attempt's channel output under the same `stepId`.
- **Client tool suspend** — _"What's the weather?"_ (no location) — `getLocation` has no `execute` on the server; the workflow calls `suspendRun` and terminates. The browser executes `navigator.geolocation`, publishes the result on the channel, POSTs a continuation. A fresh workflow resumes the same run.
- **Approval suspend** — _"What's the weather forecast for tomorrow in London?"_ — the model calls `getWeatherForecast`, which requires approval. Workflow suspends. Approve in the UI, the continuation POST starts a fresh workflow that resumes.
- **Cancel** — click Stop mid-run. The client publishes `ai-cancel` on the channel; `listenChannel` translates that into a `cancel` signal; the workflow cancels the in-flight activity and calls `endRun('cancelled')`.

## Reflecting SDK changes

The demo loads the SDK's built output, so after editing SDK source:

1. Rebuild from the repo root: `pnpm run build`
2. Restart both the worker (`Ctrl-C` in terminal 2, then `pnpm dev:worker`) and the Next dev server.

## Notes

- **Workflow id = invocation id**. One workflow per HTTP POST. Continuations create a new workflow that resumes the existing run.
- **Concurrency**. Two POSTs on the same channel run as two independent workflows. Each has its own listener activity; both attach to the channel with no coordination.
- **`stopWhen: stepCountIs(1)`**. The inference activity calls `streamText` but forces it to stop after a single LLM call so the workflow controls the loop. Server tools are executed in follow-up activities, not inline.
- **Durability boundary**. An LLM stream is not itself resumable mid-chunk; Temporal's durability applies at the step boundary — a failed activity is retried in full under the same `stepId`, and the retried publish supersedes.
