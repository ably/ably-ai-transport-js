# `useChat` demo

A Next.js chat app that plugs Ably AI Transport into the Vercel AI SDK's [`useChat`](https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat) hook. `ChatTransportProvider` supplies a `chatTransport` that drops straight into `useChat({ transport })`: sends publish on an Ably channel and wake the agent route with a small pointer POST, and the streamed reply arrives back over the channel. The route rebuilds the conversation from channel history with the standalone agent transport, so it holds no state between requests. Each fresh visit opens a new channel (`?channel=<name>` pins a specific one).

What the demo shows:

- **Streaming over Ably** — `useChat` owns the message state; the transport turns its sends into channel publishes and its response stream into channel subscriptions.
- **Tools** — a server tool (`getWeather`), a browser tool (`getLocation`, run via `onToolCall` + `addToolOutput`), and an approval-gated tool (`getWeatherForecast`, resolved via `addToolApprovalResponse`). Tool continuations resume the suspended run automatically.
- **Cancel** — Stop publishes a cancel over the channel; the agent aborts the model call and ends the run.
- **Resume** — `resume: true` reconnects to a live run after a reload via the transport's `reconnectToStream`.
- **LiveObjects checklist** — see below.

## Prerequisites

- Node.js >= 22
- pnpm 11 (`corepack enable` once)
- An [Ably API key](https://ably.com/accounts)
- One AI provider key: Anthropic, OpenAI, or Vercel AI Gateway

## Setup

The demo links the SDK from the repo root (`link:../../../..`) and loads its built `dist/`, so build the SDK first.

```bash
# 1. Build the SDK (from the repository root)
pnpm install
pnpm run build

# 2. Configure env (from this directory)
cp .env.local.example .env.local
# then set ABLY_API_KEY + one AI provider key — see the comments in the file

# 3. Install and run (from this directory)
pnpm install
pnpm dev
```

Open <http://localhost:3000>.

## Agent task checklist (LiveObjects)

A widget at the bottom of the conversation shows the agent's **task checklist** — the live plan for a multi-step request, held in [Ably LiveObjects](https://ably.com/docs/liveobjects) on the **same channel** the conversation uses. The agent writes it through the `updateChecklist` tool: it lays out the steps up front, then flips each step from pending → in progress → done as it works. Each flip is a granular field update on the shared object, so clients see progress advance without the agent resending the whole list. Clients are read-only.

Ask the agent to tackle something multi-step ("plan a launch checklist and work through it", "outline and draft a short summary") and watch the steps tick over.

Things to watch for:

- **Live progress** — steps move from pending to in progress to done within a single agent turn, driven by one field update per step rather than a full rewrite.
- **Reload mid-task** — the checklist comes back instantly from object state synced on attach, and resumes at the same progress.
- **Two tabs, one checklist** — open the same channel in a second tab; both widgets render the same steps and advance together as the agent writes.

How it works:

| Concern              | Mechanism                                                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation         | `ChatTransportProvider` + `useChatTransport` feed the adapter into Vercel's `useChat`; the route drives the run with `createAgentTransport`                     |
| Checklist state      | LiveObjects on the same channel, via `channel.object`; the agent writes through `updateChecklist`, clients are read-only (`useChecklist`)                       |
| Enabling LiveObjects | `plugins: { LiveObjects }` on both Realtime clients, `channelModes: OBJECT_MODES` on the provider and the route's channel, object modes in the token capability |

## The agent route

`src/app/api/chat/route.ts` handles the adapter's POST (`{channelName, eventId, runId?}`):

1. Builds a fresh Ably client and channel, and a `createAgentTransport` over it.
2. `connect()`, then `locateInput(eventId)` finds the triggering input in channel history (404 if missing).
3. Pages `history()` to exhaustion and merges the events into `UIMessage[]` (`src/app/lib/merge-messages.ts`).
4. Opens the run — a resume when `runId` is present, a fresh run otherwise — and responds `{runId}` immediately.
5. Inside `after()`: `streamText` with the conversation and tools, pipes the UIMessage chunk stream into `run.pipe(...)`, then `run.suspend()` when a client tool or approval is pending, else `run.end(...)`.

## Reflecting SDK changes

The demo loads the SDK's built output, so after editing SDK source:

1. Rebuild from the repo root: `pnpm run build`
2. Restart the dev server (`Ctrl-C`, then `pnpm dev`).
