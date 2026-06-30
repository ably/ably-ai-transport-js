# OpenAI Responses `useClientSession` demo

A Next.js chat app built on the SDK's lower-level React hooks (`useClientSession`, `useView`, and friends from `@ably/ai-transport/react`) with the **OpenAI Responses codec** (`ResponsesCodec` from `@ably/ai-transport/openai`). It drives a session directly — the generic, codec-agnostic transport parameterized by the codec, with no OpenAI-specific transport layer. This is the text-only counterpart of the Vercel `use-client-session` demo: branching, regenerate, edit, history, and multi-client sync all come free from the generic layer. Tools are not covered yet.

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

The default model is `gpt-4.1` — a non-reasoning model, so the Responses stream carries no reasoning events. The demo filters the stream to the codec's supported event types before piping regardless (see `src/app/api/chat/supported-events.ts`); dropped event types are logged once. Override the model with `OPENAI_MODEL`.

## How it works

- **Backend** (`src/app/api/chat/route.ts`): the generic `createAgentSession({ client, channelName, codec: ResponsesCodec })`. Per request it `start()`s a run, `loadConversation()`s the `OpenAITurn[]`, flattens it with `toResponsesInput`, opens an OpenAI `/responses` stream, filters it to the codec's supported events, and `pipe`s it to the channel.
- **Frontend** (`src/app/providers.tsx`, `page.tsx`): the generic `createSessionHooks<OpenAIInput, OpenAIOutput, OpenAIProjection, OpenAITurn>()`, with `<ClientSessionProvider codec={ResponsesCodec}>`. Components render `OpenAITurn` items' text content parts.

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
