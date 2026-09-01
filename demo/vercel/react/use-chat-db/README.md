# `useChat` persistence demo

A Next.js chat app that shows how to **compose a database with the live Ably
channel** using Ably AI Transport's `ChatTransport` and the Vercel AI SDK's
[`useChat`](https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat) hook.
`useChat` is the only live message state: every send publishes to the channel
through the SDK's chat transport, and the streamed reply arrives back off the
channel subscription. The agent route runs on `createAgentTransport`.

The client persists each **completed** turn to a store (an in-memory stand-in
for a real database, keyed by channel name) from useChat's `onFinish`, along
with the **channel serial** the turn is complete up to. Hydration happens
before the chat mounts, in two parts:

1. a REST endpoint (`/api/messages`) serves the stored conversation and that
   serial;
2. `chatTransport.readSince(latestSerial)` walks the channel back only as far
   as the serial and returns the messages published since, merged with the
   provider's own reducer (`readUIMessageStream`).

The two lists concatenate into `useChat({ messages })` in one shot. The serial
is what keeps the walk short: without it every page load would re-page the
whole channel.

`readSince` withholds any message whose run has not ended and retains its
events for `reconnectToStream`. `useChat` mounts with `resume: true`, so a run
that was still streaming at page load is delivered by the resume path instead
— exactly one producer builds each message, so nothing is rendered twice.

The demo exercises the full tool set: a server tool (getWeather), a
client-executed tool (getLocation), and an approval-gated tool
(getWeatherForecast). A turn that stops on tool calls still ends; the client's
resolution wakes a new run. Each fresh visit opens a new channel
(`?channel=<name>` pins a specific one).

## The approval-decision body

Most of what this demo publishes rides the wire in the AI SDK's own
vocabulary: a new turn is a `UIMessage` (`{ kind: 'message' }`), and a client
tool's result is the SDK's own `tool-output-available` chunk
(`{ kind: 'chunk' }`) — so one merge path (`readUIMessageStream`) covers inputs
and outputs alike.

The tool-approval decision is the exception, published as the codec-defined
`{ kind: 'approval' }` body (`{ messageId, toolCallId, approved, reason? }`).
The AI SDK has no chunk for a client-side approval decision — responding is
`chat.addToolApprovalResponse`, a state change, not a stream part — so there
is no provider type to reuse. The body captures the intermediate "approved,
not yet executed" state, which is what the agent's merge
(`src/app/lib/merge-messages.ts`) flips onto the tool part so `streamText`
executes the approved tool on the continuation.

The adapter's own `readSince` walk does not apply it. That walk merges message
inputs and agent outputs; an approval, and a client tool resolution addressed
to the assistant message rather than the wire's own transport-message-id, both
contribute nothing there. A turn inside the walk window that ended on a client
tool or an unanswered approval therefore hydrates with the tool part still
open, and the client answers it again. That is why the store holds the whole
conversation useChat has: it keeps the walk window short enough that the case
is rare, and the store's copy is already resolved.

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
conversation is restored from the REST store plus the channel walk since its
serial.

## Tests

```bash
pnpm test          # unit tests (hydration, message merging, store, chat wiring)
pnpm run test:e2e  # Playwright e2e against an Ably sandbox app (no keys needed)
```

## Reflecting SDK changes

The demo loads the SDK's built output, so after editing SDK source:

1. Rebuild from the repo root: `pnpm run build`
2. Restart the dev server (`Ctrl-C`, then `pnpm dev`).
