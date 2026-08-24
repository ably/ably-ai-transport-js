# OpenAI Responses transport demo

A Next.js chat app built on the SDK's standalone transports (`createClientTransport` / `createAgentTransport` from `@ably/ai-transport`, plus the `ClientTransportProvider` / `useTransportEvents` React glue from `@ably/ai-transport/react`) with the **OpenAI Responses codec** (`ResponsesCodec` from `@ably/ai-transport/openai`). It is the one non-`useChat` demo, and it proves two things:

1. **The transport is codec-agnostic.** The client and agent both run the generic transport parameterized by `ResponsesCodec` — a wire-only codec (encode/decode). There is no OpenAI-specific transport layer, and the transport holds no conversation state: it hands out classified events (`message` / `run-lifecycle`), and the app owns everything above that.
2. **OpenAI's own accumulator merges our wire.** The demo rebuilds each assistant message by feeding the decoded Responses stream events through `accumulateResponse` (from `openai/lib/responses/ResponseAccumulator`) — the provider's own reducer, not a bespoke one. The merge helper (`src/app/lib/merge-thread.ts`) owns the two obligations that make that work, documented below.

The demo renders a **linear thread**: transport events are demultiplexed by transport-message-id, merged per message, and listed in first-seen order. There is no branch navigation.

The channel name is the `NEXT_PUBLIC_ABLY_CHANNEL_NAMESPACE` (default `ai:`) followed by a random slug, e.g. `ai:swift-otter-lantern`; `?channel=<name>` overrides it (the name must sit within the namespace). `?limit=<n>` sets the transport's `historyPageSize`, so a small value forces the backend reads and the client's gap walk to page history in several batches.

## The merge's obligations

The wire is deliberately lean, and `accumulateResponse` is strict, so the demo's merge owns:

- **Seeding.** With no snapshot the accumulator accepts only a `response.created` event, which the codec keeps off the wire. Each per-message merge seeds a minimal synthetic `Response` snapshot (`{ object: 'response', output: [], ... }`); the accumulator's mutations only ever touch `output` and `output_text`.
- **Reduced done items.** The wire's `response.output_item.done` carries a REDUCED item — the terminal `status` plus the residue the streamed deltas cannot rebuild (a message part's `logprobs`, a reasoning item's `encrypted_content`). The accumulator's own `done` case replaces the accumulated item wholesale, which would erase the streamed content — so the merge merges those fields onto the accumulated item instead of replaying the event.
- **Index bookkeeping and duplicate openers** (corollaries of the two above): the wire drops `output_index` from the item envelopes and rebuilt deltas, so the merge keeps its own item-id → index map; and the decoder synthesises `response.output_item.added` (and rebuilds part openers) on mid-stream joins, so the merge collapses duplicate adds by item id — find-or-create. That collapse is what makes a mid-run page reload work: hydrated partial history plus the live continuation merge to ONE message.

The codec's two non-OpenAI output events (`function_call_output`, `tool-approval-request`) and the demo's own input bodies (`message` / `item` / `approval` / `regenerate`) apply as small steps onto each message's items and `toolCallStates`. The codec carries inputs as opaque passthrough JSON (`WireCodec<unknown, OpenAIOutput>`), so the input vocabulary, the stored message model, the `/responses` flatten, and the agent loop's correlation readers are all this demo's own (`src/app/lib/openai-thread.ts`), with `asOpenAIInput` narrowing decoded bodies at the merge boundary.

## Prerequisites

- Node.js >= 22
- pnpm 11 (`corepack enable` once)
- An [Ably API key](https://ably.com/accounts)
- An [OpenAI API key](https://platform.openai.com)

## Setup

The demo links the SDK from the repo root (`link:../../../..`) and loads its built `dist/`, so build the SDK first.

```bash
# 1. Build the SDK (from the repository root)
pnpm install
pnpm run build

# 2. Configure env (from this directory)
cp .env.local.example .env.local
# then set ABLY_API_KEY + OPENAI_API_KEY — see the comments in the file

# 3. Install and run (from this directory)
pnpm install
pnpm dev
```

Open the URL the dev server prints.

The default model is `gpt-5.5` (OpenAI's recommended default as of early July 2026); override it with `OPENAI_MODEL`. By default the request does not ask for reasoning summaries, so the demo behaves like an ordinary chat. Set `SHOW_REASONING=1` to opt the request into `reasoning: { summary: 'auto' }`: the model then streams its summarised "thinking", which the codec carries to the client and the demo renders as a muted "💭 thinking" block above the reply. It is opt-in so casual users don't spend reasoning tokens on every turn; even with it on, a trivial prompt yields an empty summary, so a reasoning-heavy prompt is needed to see it. (The flag gates only the real model — the deterministic mock behind `MOCK_LLM` always streams a summary for a "think"/"reason" prompt, since it costs nothing.) Any event the codec neither models nor expects — one that appears only once you opt into a hosted tool or modality it doesn't support yet (hosted tools, audio, …) — makes the encoder throw rather than silently drop content.

Set `STATELESS=1` to demonstrate the no-store / zero-data-retention (ZDR) case: the request runs with `store: false` and `include: ['reasoning.encrypted_content']`, so OpenAI persists nothing server-side. A reasoning model's chain-of-thought must then travel between turns in-band, as the reasoning item's `encrypted_content` blob — which the codec preserves on the wire, the merge merges from the reduced item-done, and a follow-up turn resends so OpenAI accepts it. Combine with `SHOW_REASONING=1` and a reasoning-heavy prompt to produce a reasoning item to observe.

Set `LOGPROBS=1` to opt the request into per-token log probabilities (`include: ['message.output_text.logprobs']` with `top_logprobs`). They travel on the finalised `response.output_item.done` item, and the merge merges them onto the accumulated message's `output_text` part(s) — so they show up on the turn in the debug pane's Messages tab (and on the item-done message in the Ably tab). Only the reasoning-free models support logprobs, so pair it with a non-reasoning `OPENAI_MODEL` such as `gpt-4.1`.

## How it works

- **Backend** (`src/app/api/chat/route.ts`): `createAgentTransport({ channel, codec: ResponsesCodec })`. The wake POST carries `{ channelName, eventId, runId? }`; the route connects, locates the triggering input via `locateInput(eventId)`, reads the existing conversation through `getExistingMessages` (`src/app/lib/get-existing-messages.ts` — the demo's one swappable history source, which pages `transport.history()` to exhaustion and merges it through the SAME merge helper the frontend uses), and flattens the messages with `toResponsesInput`. A companion endpoint (`src/app/api/messages/route.ts`) serves the same read to the client as JSON — the decoded events plus the newest event's serial — so swapping the channel for a database later means reimplementing `getExistingMessages` only. It opens the run (fresh, or `publish: 'resume'` when the body names a `runId`), returns `{ runId }` immediately, and streams in `after()`: the agentic loop (`runAgentLoop` in `src/app/api/chat/agent-stream.ts`) opens an OpenAI `/responses` stream and pipes it as-is (`run.pipe` accepts the SDK's async-iterable stream directly), runs any tools the model calls (`src/app/api/chat/tools.ts`), publishes each unit of work under its own pipe (so each gets a fresh `transport-message-id`), emits the codec's `function_call_output` / `tool-approval-request` events between calls, then suspends on pending client work or ends the run otherwise.
- **Frontend** (`src/app/page.tsx`, `src/app/components/`, `src/app/hooks/`): `<ClientTransportProvider codec={ResponsesCodec}>`, `useClientTransport`, and the demo's own `useResponsesThread` — hydrate from the messages endpoint (`GET /api/messages` returns the decoded events plus the seam serial), page `transport.history()` backwards only for the gap newer than that seam, then merge live `useTransportEvents` events through `merge-thread.ts` into the ordered thread (per-message items, tool-call states, and run status; `isRunning` derives from the run-lifecycle events). Sending publishes `{ kind: 'message', payload }` and POSTs the wake; a tool resolution or approval publishes against the assistant message's transport-message-id under the run's id and wakes with that `runId`; Stop publishes `transport.cancel(runId)`. The parts that don't touch the message format come from `@ably-ai-demos/frontend` (`demo/shared-frontend`): `ChatShell`, the Ably and theme providers, the intro card, and the shadcn UI primitives. The message-rendering components stay here, because they read the OpenAI item shapes directly — the transcript, bubbles, tool cards and debug pane are this demo's own, built on the shared primitives.

## Reflecting SDK changes

The demo loads the SDK's built output, so after editing SDK source:

1. Rebuild from the repo root: `pnpm run build`
2. Restart the dev server (`Ctrl-C`, then `pnpm dev`).

## Tests

```bash
pnpm test          # unit tests (vitest + jsdom), including the merge's stress cases
pnpm run test:e2e  # Playwright e2e with the deterministic mock model + sandbox Ably
```

The merge's unit tests (`src/app/lib/__tests__/merge-thread.test.ts`) pin the two stress cases with decoded-event fixtures: a mid-run reload (partial history plus the live continuation, with the decoder's synthesised duplicate openers) merges to one message without the accumulator throwing, and multi-batch history merges identically to a single batch.

See `tests/e2e/README.md` for the e2e setup.
