# Trivia Night demo

A multiplayer trivia game where an AI agent is the quizmaster. The conversation runs over Ably AI Transport (Vercel AI SDK `useChat`); the game state — player roster, current question, scores — lives in [Ably LiveObjects](https://ably.com/docs/liveobjects) on the **same channel**, written by the agent (through tools) and by the players (joining from the game pane).

Things to watch for:

- **Two tabs, one game** — use the "open in new tab" button to add a player. Both tabs' rosters, question cards, and scoreboards update live, and every player sees every answer and verdict.
- **Concurrent answers** — two players answering at once produce two concurrent agent runs; both `awardPoints` calls land because scores are `LiveCounter`s (commutative increments), not values that overwrite each other.
- **Reload mid-game** — the roster, current question, and scores come back instantly from object state synced on attach, before any conversation history has loaded.
- **Visible state writes** — the quizmaster's tool calls (`askQuestion`, `awardPoints`, ...) render inline in the chat, so you can see exactly when the shared state changes.

Each fresh visit opens a new game (`?channel=<name>` joins a specific one — share the URL to invite players on other machines).

## Prerequisites

- Node.js >= 22
- pnpm 11 (`corepack enable` once)
- An [Ably API key](https://ably.com/accounts)
- One AI provider key: Anthropic, OpenAI, or Vercel AI Gateway. **Required** — the quizmaster generates questions and judges answers with a real model; there is no mock.

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

Open <http://localhost:3000>, pick a name, join, and say "start the quiz".

## How it works

| Concern                                   | Mechanism                                                                                                                                                               |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation (questions, answers, banter) | AI Transport over the session channel, `useChat` + `useChatTransport`                                                                                                   |
| Game state (roster, question, scores)     | LiveObjects on the same channel, via `session.object`                                                                                                                   |
| Enabling LiveObjects                      | `plugins: { LiveObjects }` on both Realtime clients, `channelModes: OBJECT_MODES` on both sessions, `object-subscribe`/`object-publish` in the token capability         |
| Who answered?                             | Every user message carries a `data-player` part; the agent endpoint converts it to a "Name (clientId xyz) says:" prefix via `convertToModelMessages`' `convertDataPart` |
| Score integrity                           | One `LiveCounter` per player — concurrent awards merge; only the agent increments                                                                                       |

The agent endpoint (`src/app/api/chat/route.ts`) is stateless: each run re-reads the game state from the channel's objects, embeds a snapshot in the system prompt, and mutates state through four guarded tools (`startQuiz`, `askQuestion`, `awardPoints`, `endQuiz`).

## Reflecting SDK changes

The demo loads the SDK's built output, so after editing SDK source:

1. Rebuild from the repo root: `pnpm run build`
2. Restart the dev server (`Ctrl-C`, then `pnpm dev`).
