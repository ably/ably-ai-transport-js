# OpenAI Responses `useClientSession` demo

A Next.js chat app built on the SDK's lower-level React hooks (`useClientSession`, `useView`, and friends from `@ably/ai-transport/react`) with the **OpenAI Responses codec** (`ResponsesCodec` from `@ably/ai-transport/openai`). It drives a session directly — the generic, codec-agnostic transport parameterized by the codec, with no OpenAI-specific transport layer. Like the Vercel `use-client-session` demo, branching, regenerate, edit, history, and multi-client sync all come free from the generic layer. It also showcases a **server-side function call**: ask for the weather and the agent runs a `getWeather` tool, streams the result back as a weather card, and the model replies — all within one run (no suspend). Client-side tools and approvals are not covered yet.

The session channel name is the `NEXT_PUBLIC_ABLY_CHANNEL_NAMESPACE` (default `ai:`) followed by a random slug, e.g. `ai:swift-otter-lantern`; `?channel=<name>` overrides it (the name must sit within the namespace).

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

Set `STATELESS=1` to demonstrate the no-store / zero-data-retention (ZDR) case: the request runs with `store: false` and `include: ['reasoning.encrypted_content']`, so OpenAI persists nothing server-side. A reasoning model's chain-of-thought must then travel between turns in-band, as the reasoning item's `encrypted_content` blob — which the codec preserves on the wire and reconstructs from Ably channel history, so a follow-up turn resends it and OpenAI accepts it. Combine with `SHOW_REASONING=1` and a reasoning-heavy prompt to produce a reasoning item to observe.

Set `LOGPROBS=1` to opt the request into per-token log probabilities (`include: ['message.output_text.logprobs']` with `top_logprobs`). The codec folds them onto the projected assistant turn's `output_text` part(s) — carried on the finalised `response.output_item.done` item — so they show up on the turn in the debug pane's Messages tab (and on the item-done message in the Ably tab). Only the reasoning-free models support logprobs, so pair it with a non-reasoning `OPENAI_MODEL` such as `gpt-4.1`.

## How it works

- **Backend** (`src/app/api/chat/route.ts`): the generic `createAgentSession({ client, channelName, codec: ResponsesCodec })`. Per request it drains `run.view` for the conversation's `OpenAIMessage[]`, `start()`s the run, flattens the messages with `toResponsesInput`, and runs the agentic loop (`runAgentLoop` in `src/app/api/chat/agent-stream.ts`). The loop opens an OpenAI `/responses` stream and pipes it raw through the codec (see above — every default-streamed event is modelled), and if the model calls a tool it runs the tool (`src/app/api/chat/tools.ts`), publishes the result as a `function_call_output` event, and continues `/responses` until the model produces a final reply. Each unit of work is published under its own `run.pipe`, so it gets a fresh `codec-message-id` and the reducer keys it as a distinct `OpenAIMessage`: a run that calls a tool produces three messages (the model turn that emitted the call, the tool outputs, the final text turn). The `function_call_output` lands in its own message, and the codec keys by `codec-message-id` alone, so the frontend pairs a call with its output across messages by `call_id`.
- **Frontend** (`src/app/providers.tsx`, `page.tsx`): the generic `createSessionHooks<OpenAIInput, OpenAIOutput, OpenAIProjection, OpenAIMessage>()`, with `<ClientSessionProvider codec={ResponsesCodec}>`. Components render `OpenAIMessage` items as text content parts plus tool calls (a `getWeather` call renders as a weather card via `toRenderItems`). The parts that don't touch the message format come from `@ably-ai-demos/frontend` (`demo/shared-frontend`): `ChatShell` (header, composer, suggestion chips, debug slot), the Ably and theme providers, the intro card, the shadcn UI primitives the components are built from, and the channel-name and client-colour helpers. The message-rendering components stay here, because they read the OpenAI item shapes directly — the transcript, bubbles, tool cards and debug pane are this demo's own, built on the shared primitives.

## Reflecting SDK changes

The demo loads the SDK's built output, so after editing SDK source:

1. Rebuild from the repo root: `pnpm run build`
2. Restart the dev server (`Ctrl-C`, then `pnpm dev`).

## Tests

```bash
pnpm test          # unit tests (vitest + jsdom)
pnpm run test:e2e  # Playwright e2e with the deterministic mock model + sandbox Ably
```

See `tests/e2e/README.md` for the e2e setup.
