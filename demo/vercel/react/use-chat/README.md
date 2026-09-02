# `useChat` demo

A Next.js chat app that plugs Ably AI Transport into the Vercel AI SDK's [`useChat`](https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat) hook. `ChatTransportProvider` supplies a `chatTransport` that drops straight into `useChat({ transport })`: sends publish on an Ably channel and wake the agent route with a small pointer POST, and the streamed reply arrives back over the channel. The conversation itself lives in a server-side store, which the route writes as each run opens and again when it ends — so hydration is one REST read and nothing pages channel history. Each fresh visit opens a new channel (`?channel=<name>` pins a specific one).

What the demo shows:

- **Streaming over Ably** — `useChat` owns the message state; the transport turns its sends into channel publishes and its response stream into channel subscriptions.
- **Tools** — a server tool (`getWeather`), a browser tool (`getLocation`, run via `onToolCall` + `addToolOutput`), and an approval-gated tool (`getWeatherForecast`, resolved via `addToolApprovalResponse`). A turn that stops on a tool call ends; the resolution carries no run id, so its continuation wakes a fresh run that answers.
- **Cancel** — Stop publishes a cancel over the channel; the agent aborts the model call and ends the run.
- **Hydrate from your own store** — the chat hydrates from `GET /api/messages` before it mounts (`useStoredHydration`), which reads the server's conversation store. The channel carries the live conversation; the store is the record of it, and the client reads no history.
- **Resume a run in flight** — the store also names the run streaming right now, so a page that loads mid-run hands that id to `resumeStream` as a `ReconnectHint` and the adapter joins the run off the channel. The decoder's first contact with a stream in progress carries the text so far, so nothing published before the page loaded is lost.
- **Server-owned persistence** — every write happens in the agent route. A client never writes to the store, so it cannot put anything there the agent did not produce.
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

`src/app/api/chat/route.ts` handles the adapter's POST (`{channelName, eventId}`):

1. Builds a fresh Ably client and channel, and a `createAgentTransport` over it.
2. `connect()`, then `locateInput(eventId)` finds the triggering input in channel history (404 if missing).
3. Builds the model context with `getExistingMessages` (`src/app/lib/get-existing-messages.ts`): the conversation the store holds, with the located input applied to it (`src/app/lib/apply-input.ts`). No channel history is paged.
4. Opens a run anchored to the located input, writes the turn and the open run id to the store, and answers 202. Nothing is read from the response body: the client resolves the run id off the channel, from the `ai-run-start` that names the input it published.
5. Inside `after()`: `streamText` with the conversation and tools, pipes the UIMessage chunk stream into `run.pipe(...)`, then `run.end(...)` — including when a client tool or approval is pending, because the client's resolution wakes a new run rather than resuming this one.
6. `toUIMessageStream({ originalMessages, onEnd })` puts the AI SDK in its own persistence mode: `onEnd` hands back the whole updated conversation, so the store write needs no merge of the demo's own. The open run is cleared once the run is over.

## The conversation store

`src/app/lib/message-store.ts` is an in-memory stand-in for the database an app would keep conversations in, keyed by channel name and lost on restart. `GET /api/messages` (`src/app/api/messages/route.ts`) serves it and touches no Ably connection, because it stands in for a query against the app's own database. There is no write side on that route — the agent route owns every write.

`src/app/lib/apply-input.ts` is the one thing the store cannot supply: the input that woke the agent, which is still only on the channel. A user turn replaces or appends a message; a tool resolution replays through the AI SDK's own reducer (`readUIMessageStream`) onto the message holding that call; an approval decision flips its tool part. Nothing bigger is needed, because the store already holds every earlier turn.

## Reflecting SDK changes

The demo loads the SDK's built output, so after editing SDK source:

1. Rebuild from the repo root: `pnpm run build`
2. Restart the dev server (`Ctrl-C`, then `pnpm dev`).
