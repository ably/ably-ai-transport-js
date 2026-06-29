# `useChat` database-hydration demo

A Next.js chat app that shows how to **compose a database with the live Ably
channel** using Ably AI Transport and the Vercel AI SDK's
[`useChat`](https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat) hook.

The agent persists each completed turn to a store (an in-memory stand-in for a
real database, keyed by channel name). On load, the client seeds
`useChat({ messages })` from that store and the SDK's `useMessageSync` reconciles
the seed with the live channel: it takes the newest stored message as the
**seam**, pages the channel back to it, and renders `stored history ⧺ live tail`
with no duplicate. Reload the page and the conversation comes back from the
store, stitched onto whatever the channel has streamed since.

This is a deliberately minimal, linear chat (text turns only, no branch
navigation or tools) so the seam reconciliation is the sole pager of the view —
the precondition the single-overlap compose relies on. For the full feature set
(branching, tools, multi-tab) see the `use-chat` demo. Each fresh visit opens a
new channel (`?channel=<name>` pins a specific one).

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

# 2. Configure env (from this directory)
cp .env.local.example .env.local
# then set ABLY_API_KEY + one AI provider key — see the comments in the file

# 3. Install and run (from this directory)
pnpm install
pnpm dev
```

Open <http://localhost:3000>, send a few messages, then reload — the
conversation is restored from the store and reconciled with the live channel.

## Reflecting SDK changes

The demo loads the SDK's built output, so after editing SDK source:

1. Rebuild from the repo root: `pnpm run build`
2. Restart the dev server (`Ctrl-C`, then `pnpm dev`).
