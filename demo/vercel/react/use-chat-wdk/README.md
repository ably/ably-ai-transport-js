# `use-chat-wdk` — AIT durable agents on Vercel Workflows

A reference demo running the `@ably/ai-transport` **durable cross-process** flow on **Vercel's Workflow Development Kit (WDK)**. The chat client is the same as the [`use-chat`](../use-chat) demo (Vercel `useChat` + the AIT `ChatTransport` over an Ably channel); what differs is the **server execution model** — instead of running the agent inline in the API route, the route starts a **Vercel Workflow** whose retryable **activities** each run as a separate process and drive the AIT run over the channel via `createAgentTransport` / `openRun` / `run.createStep`.

It shows AIT and a durable execution framework working together: WDK gives the agent loop crash-safe retries and cross-process durability; AIT gives every client a resumable view of that run over Ably.

> **Terminology.** Two things are called "step". An **AIT step** (`run.createStep`) is a re-attemptable unit of agent output. A **WDK step** is a retryable durable unit — we call it an **activity** everywhere here to avoid the collision. A **workflow** orchestrates **activities**; inside an activity we open an AIT step.

## What this demonstrates

- **The durable pairing** — `openRun({ runId, publish })` + `run.createStep({ stepId })`. Each activity is a fresh process: it builds its own Ably client and agent transport, reconstructs what it needs from channel history, and brackets its output in an AIT step keyed on the WDK step id. The run id is pinned to the stable workflow run id, so a fresh-process retry re-enters the SAME run instead of opening a parallel one; the stable step id makes a retry's output supersede the dead attempt's in the durable record.
- **A driver-owned agent loop** — the workflow runs one activity per unit of work: `open` (locate the trigger, publish the run's opening event), an `inference` per model call, one `tool` per server tool call, and a `terminal` that publishes the run's suspend/end — looping until the turn settles. `stripToolExecutes` stops the model from running tools inline, so the workflow owns the loop.
- **Message assembly from the channel** — each activity merges channel history into `UIMessage[]` with the AI SDK's own reducer (`readUIMessageStream`) via the demo's `lib/merge-messages.ts`: outputs and tool-resolution inputs merge as chunks, whole-message inputs merge per codec-message-id, approvals apply as synthesized approval-response chunks, and only the canonical attempt per AIT step merges.
- **Gate before publishing** — every re-entering activity merges the run's lifecycle events from history first (latest event per run) and publishes only while the run is still this workflow's to drive. A run that ended, suspended, or was resumed by another invocation (a client continuation) is left alone.
- **Suspend / resume across processes** — a client tool or an approval leaves the run suspended (`run.suspend()` from the terminal activity); the client's continuation POST starts a fresh workflow that resumes the same run (`ai-run-resume`).
- **Channel-delivered cancel** — the client's Stop publishes `ai-cancel`; the in-flight inference's run `abortSignal` fires and the run ends `cancelled`.
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
- **Fault → durable retry** — arm **Fail once** or **Crash**, then send any prompt. The inference activity throws on its first attempt; WDK re-runs it as a fresh process, and the retry re-enters the same run — the reply lands once. Watch it in the WDK processes panel.
- **Reload mid-run** — send a prompt and refresh the page while it's streaming. The run keeps running on WDK (it isn't tied to your connection); `useChat({ resume: true })` classifies the in-flight run from channel history and rejoins its stream.
- **Cancel mid-stream** — send a long prompt, then click **Stop**. The cancel travels over the channel, the in-flight activity aborts, and the run ends cleanly.
- **Presence** — the header avatars show who's connected to the conversation (Ably Presence over the same channel).

## Notes

- **One workflow per POST; continuations resume.** The chat route responds `{ runId }` immediately: a fresh send pins `run:<workflowRunId>` (the same derivation the open activity uses), a continuation echoes the run it resumes. Streaming then happens over Ably.
- **`stopWhen: stepCountIs(1)`.** Each model call stops after a single LLM turn so the workflow controls the loop; server tools run in follow-up activities, never inline.
- **The terminal is its own activity, gated.** The inference classifies its outcome and publishes output only; a separate `terminal` activity merges the run's lifecycle from history and publishes `ai-run-suspend` / `ai-run-end` only while the run is still this workflow's to drive. A process that dies between outcome and terminal is retried at the terminal alone.
- **Retries observe before they redo.** On a retry, an activity merges the run's state and prior tool calls from the channel and only redoes genuinely unfinished work, so a continuation that already moved the run on is never clobbered.
- **Durability boundary.** An LLM stream isn't resumable mid-chunk; WDK's durability applies at the activity boundary — a failed activity is retried in full under the same WDK step id, and the retried attempt's output supersedes the dead attempt's in the durable record. The response-message id is pinned per AIT step (`toUIMessageStream({ generateMessageId })`) so a merging consumer keys both attempts to one message. A client that already rendered a dead attempt's partial chunks live keeps them until reload — the useChat stream is append-only.
- **Demo controls travel out-of-band.** The AIT chat transport owns the POST body, so the armed fault rides a one-shot cookie the chat route consumes into the workflow input.
- **Zero infra.** No separate server or worker: the workflow and activities compile into the Next app's routes (`withWorkflow`), backed by the Local World in dev and the Vercel platform in production. Each activity is a fresh process that reconstructs run state from the channel.
