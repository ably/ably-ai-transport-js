# Day out planner

A collaborative chat-and-map demo where a small group of people plan a day out
together with help from an AI agent called **Bernard**. Everyone shares one
durable session: people chat freely, and when someone mentions `@bernard` he
joins in, suggests places, and builds a shared itinerary that everyone sees
update live on a map.

It exercises three pieces of `@ably/ai-transport` together:

- The richer `useClientSession` React hooks — shared chat messages and runs.
- A server-side `createAgentSession` route that calls Anthropic's Claude with
  three itinerary-mutation tools.
- **Ably LiveObjects** — Bernard's tools write to a `LiveMap` on the **same**
  channel the chat uses; every client subscribes and re-renders the map and
  list whenever it changes.

> Design notes and known rough edges live in [`DESIGN-NOTES.md`](./DESIGN-NOTES.md).

## Running it

This is a standalone pnpm project. From this directory:

```sh
pnpm install
cp .env.local.example .env.local
# Edit .env.local — fill in ABLY_API_KEY and ANTHROPIC_API_KEY.
pnpm dev
```

Then open <http://localhost:3000?channel=ai:test-1> in two or three browser
windows. The first visit asks you to pick a name; that name is used as your
Ably `clientId` and as the sender label everyone (including Bernard) sees. The
name is kept in memory for the current tab — open a new tab and you get
prompted again, which makes it easy to demo multiple identities at once. The
header has a "change name" link to drop back to the modal.

### URL parameters

| Param     | Purpose                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------- |
| `channel` | Channel name to join (default `ai:day-out-planner:demo`). Must be in the `ai:` namespace — see below. |
| `user`    | Skips the name modal by pre-filling the name. Useful for tab-per-identity demos.                      |

A quick three-tab demo:

- `http://localhost:3000?channel=ai:test-1&user=alice`
- `http://localhost:3000?channel=ai:test-1&user=bob`
- `http://localhost:3000?channel=ai:test-1&user=charlie`

**Channel names must live in the `ai:` namespace** (e.g. `ai:test-1`). The AI
Transport SDK uses Ably's mutable-message operations, which Ably only enables on
channels in that namespace.

### Environment variables

| Variable                   | Required | Purpose                                                               |
| -------------------------- | -------- | --------------------------------------------------------------------- |
| `ABLY_API_KEY`             | yes      | Server-side Ably key (used by both the agent session and JWT issuer). |
| `ANTHROPIC_API_KEY`        | yes      | Used by `@ai-sdk/anthropic` to call Claude.                           |
| `NEXT_PUBLIC_ABLY_CHANNEL` | no       | Default channel when `?channel=` is omitted.                          |

## Using it

The chat is the only input surface. Two cases:

- **Plain chat between people**: any message that doesn't mention `@bernard`.
  It shows up in every connected client's chat pane, but Bernard does nothing.
- **Asking Bernard for help**: include `@bernard` anywhere in a message
  (case-insensitive). Bernard reads the recent conversation, suggests concrete
  real-world places and adds them to the shared itinerary via tool calls. The
  map and the list under it update on every connected client.

A worked example:

1. Alice: `hey bob let's do something on saturday, maybe pizza near avenida paulista`
2. Bob: `yeah, and let's see a film first — cine belas artes?`
3. Alice: `cool, @bernard make us a plan`

Bernard replies with a short summary and writes one or two itinerary items
(cinema + pizza place). When Charlie joins later and says `@bernard add a
museum`, the map gains another marker on every client — Charlie sees the full
history and itinerary on opening the page, because the durable session keeps it
all on the channel.

## How it works

One Ably channel per group, one Ably connection per client. The channel carries
both the chat (via the AI Transport SDK) and the itinerary (via LiveObjects):

```
              ┌──────────────────────────────────────────────────┐
              │  `<channel>` (ai: namespace)                       │
              │                                                    │
              │  AI Transport: chat messages + run lifecycle       │
              │  LiveObjects:  root LiveMap of itinerary items     │
              └──────────────────────────────────────────────────┘
                ▲              ▲                 ▲            ▲
   ClientSession│              │AgentSession     │ root.set   │ root.subscribe
   (every client)              │(server, on      │ (Bernard's │ (useItinerary,
                               │ @bernard)       │  tools)    │  every client)
```

Key points:

- **Everyone shares the session.** Each client has its own `ClientSession` on
  the channel, so messages from other people arrive naturally and the SDK's
  tree places them in the view. New joiners hydrate the whole conversation —
  and the itinerary — from the channel's history.
- **The app chooses when Bernard works.** Sending a message publishes it into
  the session; it does **not** call the agent. The client only wakes Bernard —
  by POSTing the run's invocation to `/api/chat` — when the message mentions
  `@bernard`. Everything else stays a plain human conversation. This separation
  of "publish a message" from "invoke the agent" is what a durable session
  gives you; without one, every message would unconditionally hit the agent.
- **One shared channel.** The session is created with `channelModes:
OBJECT_MODES`, so the same channel carries LiveObjects. The agent and every
  client read/write the itinerary via `session.object`.
- **Itinerary as LiveObjects.** Items are stored as JSON strings keyed by id in
  the root `LiveMap`. Bernard's tools `set`/`remove` entries; clients subscribe
  and render the map and list.

## File map

| File                                                             | What it does                                                               |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `src/app/api/chat/route.ts`                                      | Bernard's agent endpoint: reconstructs the conversation, runs the LLM.     |
| `src/app/api/chat/tools.ts`                                      | `addItineraryItem` / `updateItineraryItem` / `removeItineraryItem` tools.  |
| `src/app/api/auth/ably-token/route.ts`                           | JWT issuer with `object-publish`/`object-subscribe` capabilities.          |
| `src/app/providers.tsx`                                          | Ably realtime client with the `LiveObjects` plugin; session hooks factory. |
| `src/app/page.tsx`                                               | Name gate, channel resolution, `ClientSessionProvider` wiring.             |
| `src/app/components/planner.tsx`                                 | Top-level layout (chat ⏐ map + list).                                      |
| `src/app/components/chat-pane.tsx`                               | Send path: publish always; wake Bernard only on `@bernard`.                |
| `src/app/components/{message-list,message-bubble,input-bar}.tsx` | Chat UI; sender label comes from each message's owning run.                |
| `src/app/components/{map-pane,map-impl,itinerary-list}.tsx`      | Leaflet map (SSR-disabled) + list.                                         |
| `src/app/hooks/use-itinerary.ts`                                 | Subscribes to the session channel's LiveObjects root; exposes the items.   |
| `src/app/hooks/use-name.ts`                                      | Per-tab name with a modal gate.                                            |
| `src/app/itinerary.ts`                                           | Shared `ItineraryItem` / `ItineraryRoot` types.                            |
