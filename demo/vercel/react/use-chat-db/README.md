# `useChat` persistence demo

A Next.js chat app that shows how to **compose a database with the live Ably
channel** using Ably AI Transport's `ChatTransport` and the Vercel AI SDK's
[`useChat`](https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat) hook.
`useChat` is the only live message state: every send publishes to the channel
through the SDK's chat transport, and the streamed reply arrives back off the
channel subscription. The agent route runs on `createAgentTransport`.

The client persists each **completed** turn to a store (an in-memory stand-in
for a real database, keyed by channel name) from useChat's `onFinish`.
Hydration happens before the chat mounts, in two parts:

1. a REST endpoint (`/api/messages`) serves the stored conversation as the
   seed;
2. the client pages channel history back to the newest stored message and
   merges that gap — anything streamed since the last persisted turn — on top
   of the seed, using the provider's own reducer (`readUIMessageStream`).

The merge seeds `useChat({ messages })` in one shot, and the same gap events
seed the chat transport's wire indices (`chatTransport.seed`). A run suspended
at the time of a reload is never in the store, so it is reconstructed purely
from the history gap; the seed also recovers its run-id, which is what lets an
approval given _after_ the reload resume the suspended run — without ever
re-publishing a resolution an earlier session already published. `useChat`
mounts with `resume: true`, so a run still streaming reconnects where the
adapter can classify it from history.

The demo exercises the full tool set: a server tool (getWeather), a
client-executed tool that suspends and resumes the run (getLocation), and an
approval-gated tool (getWeatherForecast). Each fresh visit opens a new channel
(`?channel=<name>` pins a specific one).

## The approval-decision body

Most of what this demo publishes rides the wire in the AI SDK's own
vocabulary: a new turn is a `UIMessage` (`{ kind: 'message' }`), and a client
tool's result is the SDK's own `tool-output-available` chunk
(`{ kind: 'chunk' }`) — so one merge path (`readUIMessageStream`) covers inputs
and outputs alike.

The tool-approval decision is the exception, published as the codec-defined
`{ kind: 'approval' }` body (`{ toolCallId, approved, reason? }`). The AI SDK
has no chunk for a client-side approval decision — responding is
`chat.addToolApprovalResponse`, a state change, not a stream part — so there
is no provider type to reuse. The body deliberately captures the intermediate
"approved, not yet executed" state: that is what the useChat adapter reads
from the wire to know a resolution has already been published, so a hydrated
page never publishes the same decision twice, and it is what the agent's merge
flips onto the tool part so `streamText` executes the approved tool on the
continuation.

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

Open <http://localhost:3000>, send a few messages, then reload — the
conversation is restored from the REST seed plus the channel-history gap.

## Tests

```bash
pnpm test          # unit tests (hydration, message merging, store, chat wiring)
pnpm run test:e2e  # Playwright e2e against an Ably sandbox app (no keys needed)
```

## Reflecting SDK changes

The demo loads the SDK's built output, so after editing SDK source:

1. Rebuild from the repo root: `pnpm run build`
2. Restart the dev server (`Ctrl-C`, then `pnpm dev`).
