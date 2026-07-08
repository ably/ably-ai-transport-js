# `use-chat-wdk` — AIT durable sessions on Vercel Workflows

A reference demo running the `@ably/ai-transport` **durable cross-process** flow on **Vercel's Workflow Development Kit (WDK)**. The chat client is the same as the [`use-chat`](../use-chat) demo (Vercel `useChat` + the AIT `ChatTransport` over an Ably channel); what differs is the **server execution model** — instead of running the agent inline in the API route, the route starts a **Vercel Workflow** whose retryable **activities** each run as a separate process and drive the AIT run over the channel via `createRun` / `adoptRun` / `run.createStep`.

It shows AIT and a durable execution framework working together: WDK gives the agent loop crash-safe retries and cross-process durability; AIT gives every client a resumable, multi-participant view of that run over Ably.

> **Terminology.** Two things are called "step". An **AIT step** (`run.createStep`) is a re-attemptable unit of agent output. A **WDK step** is a retryable durable unit — we call it an **activity** everywhere here to avoid the collision. A **workflow** orchestrates **activities**; inside an activity we open an AIT step.

## What this demonstrates

- **The durable pairing** — `session.adoptRun({ runId, invocationId, triggerEventId })` + `run.createStep({ stepId })`. Each activity is a fresh process: it rebuilds its own Ably client, reconstructs the run from the channel, and brackets its output in a step keyed on the WDK step id.
- **A driver-owned agent loop** — the workflow runs one activity per unit of work: `open` (open the run), an `inference` per model call (the first and each follow-up), and one `tool` per server tool call — looping until the turn settles. `stripToolExecutes` stops the model from running tools inline, so the workflow owns the loop.
- **Retry supersession** — a WDK retry re-runs the activity under the _same_ `stepId`, so the retried attempt's channel output cleanly supersedes the dead one: no duplicate reply, and `RunInfo.steps[].attemptCount` bumps.
- **Suspend / resume across processes** — a client tool or an approval leaves the run suspended (`run.suspend()`); the client's continuation POST starts a fresh workflow that resumes the same run (`ai-run-resume`).
- **Channel-delivered cancel** — the client's `run.cancel()` publishes `ai-cancel`; the in-flight activity's `run.abortSignal` fires and the run ends `cancelled`.
- **A live process view** — each activity reports its lifecycle to a sidecar Ably channel; the "WDK processes" panel correlates workflows and activities to their AIT run id, enriched with real per-run status from the WDK observability API.

## Prerequisites

- Node.js >= 22
- pnpm 11 (`corepack enable` once)
- An [Ably API key](https://ably.com/accounts)
- An AI provider key — Anthropic, Vercel AI Gateway, or OpenAI. There's **no WDK account or CLI to install**; WDK runs in-process. To run without a provider key, set `MOCK_LLM=1` to use the bundled deterministic mock model.

## Run it locally

The demo links the SDK from the repo root (`link:../../../..`) and loads its built `dist/`, so build the SDK first.

```bash
# 1. Build the linked SDK (from the repository root)
pnpm install
pnpm run build

# 2. Configure env (from this directory)
cp .env.local.example .env.local
# then set ABLY_API_KEY and an AI provider key

# 3. Install and run
pnpm install
pnpm dev

# 4. (optional, in a separate terminal) WDK's web UI — a dashboard of every run and workflow
pnpm exec workflow web
```

Open <http://localhost:3000>. There's no separate server or worker to run the app — `withWorkflow` compiles the workflow + activities into the app's own routes, and in dev WDK runs zero-config on a Local World that stores run state in `.workflow-data/`. For a dashboard of every run and workflow — each activity on a timeline — run `pnpm exec workflow web` in a second terminal (or `pnpm exec workflow inspect runs` for a CLI listing). Use `pnpm exec`, not `npx`: the demo pins pnpm via `devEngines`, which `npx` won't satisfy.

## Try this

The durable execution (WDK) and the transport (AIT) are most telling in combination. Each fresh visit gets its own channel; `?channel=<name>` pins one.

- **Server tool** — _"What's the weather in Tokyo?"_ — the model calls `getWeather`; the workflow runs it in its own `tool` activity, then a follow-up `inference` summarises the result.
- **Client tool** — _"What's the weather like?"_ — `getLocation` has no server `execute`; the run suspends, your browser resolves the location (geolocation prompt), and a fresh workflow resumes the run.
- **Approval** — _"What's the weather forecast for London?"_, then **Approve** — `getWeatherForecast` is approval-gated; the run suspends until you decide, then resumes and runs the tool.
- **Fault → durable retry** — arm **Fail once** or **Crash**, then send any prompt. The first activity throws; WDK re-runs it and the retry supersedes the dead attempt. Watch it in the WDK processes panel — the reply still settles once.
- **Reload mid-run** — send a prompt and refresh the page while it's streaming. The run keeps running on WDK (it isn't tied to your connection); the client rehydrates the conversation from the channel and resumes the in-flight stream.
- **Second tab** — click **open in new tab** in the header and send from either. Both tabs share the Ably channel and stay in sync, streaming the same durable run.
- **Cancel mid-stream** — send a long prompt, then click **Stop**. The cancel travels over the channel, the in-flight activity aborts, and the run ends cleanly.
- **Presence** — the header avatars show who's connected to the session (Ably Presence over the same channel).

## Notes

- **One workflow per POST; continuations resume.** `runId` / `invocationId` derive from the WDK workflow run id and are threaded to every activity. A continuation (tool result or approval) starts a fresh workflow that resumes the existing run.
- **`stopWhen: stepCountIs(1)`.** Each model call stops after a single LLM turn so the workflow controls the loop; server tools run in follow-up activities, never inline.
- **Terminals publish inline.** The activity that produces an outcome publishes `ai-run-suspend` / `ai-run-end` in its own session before returning, so no queued lifecycle activity can race the client's continuation.
- **Retries observe before they redo.** On a retry, an activity checks the run's state on the wire and only redoes genuinely unfinished work, so a continuation that already moved the run on is never clobbered.
- **Durability boundary.** An LLM stream isn't resumable mid-chunk; WDK's durability applies at the activity boundary — a failed activity is retried in full under the same `stepId`, and the retried publish supersedes.
- **Zero infra.** No separate server or worker: the workflow and activities compile into the Next app's routes (`withWorkflow`), backed by the Local World in dev and the Vercel platform in production. Each activity is a fresh process that reconstructs run state from the channel.
