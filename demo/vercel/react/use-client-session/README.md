# `useClientSession` demo

A Next.js chat app built on the SDK's lower-level React hooks (`useClientSession`, `useView`, and friends from `@ably/ai-transport/react`) rather than the Vercel AI SDK's `useChat` — it drives a session directly. The channel defaults to `ai:demo` (`NEXT_PUBLIC_ABLY_CHANNEL`); `?channel=<name>` overrides it.

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

Open <http://localhost:3000>.

## Agent task checklist (LiveObjects)

A widget at the bottom of the conversation shows the agent's **task checklist** — the live plan for a multi-step request, held in [Ably LiveObjects](https://ably.com/docs/liveobjects) on the **same channel** the session uses. The agent writes it through the `updateChecklist` tool: it lays out the steps up front, then flips each step from pending → in progress → done as it works. Each flip is a granular field update on the shared object, so clients see progress advance without the agent resending the whole list. Clients are read-only.

Ask the agent to tackle something multi-step ("plan a launch checklist and work through it", "outline and draft a short summary") and watch the steps tick over.

Things to watch for:

- **Live progress** — steps move from pending to in progress to done within a single agent turn, driven by one field update per step rather than a full rewrite.
- **Reload mid-task** — the checklist comes back instantly from object state synced on attach, before any conversation history has loaded, and resumes at the same progress.
- **Two tabs, one checklist** — use the "open in new tab" button; both widgets render the same steps and advance together as the agent writes.

How it works:

| Concern              | Mechanism                                                                                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation         | AI Transport over the session channel (`useClientSession` + `useView`)                                                                                                 |
| Checklist state      | LiveObjects on the same channel, via `session.object`; the agent writes through `updateChecklist`, clients are read-only (`useChecklist`)                              |
| Enabling LiveObjects | `plugins: { LiveObjects }` on both Realtime clients, `channelModes: OBJECT_MODES` on the session/provider, `object-subscribe`/`object-publish` in the token capability |

## Reflecting SDK changes

The demo loads the SDK's built output, so after editing SDK source:

1. Rebuild from the repo root: `pnpm run build`
2. Restart the dev server (`Ctrl-C`, then `pnpm dev`).
