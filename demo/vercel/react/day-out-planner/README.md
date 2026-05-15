# Day out planner

A collaborative chat-and-map demo where a small group of users plans a day out
together with help from an AI agent called **Bernard**.

This demo exercises three pieces of `@ably/ai-transport` together:

- The "richer" `useClientSession` React hooks — chat messages and runs.
- A server-side `createAgentSession` route that calls Anthropic's Claude with
  three itinerary-mutation tools.
- **Ably LiveObjects** — Bernard's tool calls write to a shared `LiveMap` on
  the same Ably channel; every client subscribes and re-renders the map and
  list whenever it changes.

## Running it

From this directory:

```sh
npm install
cp .env.local.example .env.local
# Edit .env.local — fill in ABLY_API_KEY and ANTHROPIC_API_KEY.
npm run dev
```

Then open <http://localhost:3000?channel=ai:test-1> in two or three browser
windows. The first visit asks you to pick a name; that name is used as your
Ably `clientId` and as the sender label everyone (including Bernard) sees.
The name is persisted to `localStorage`; the header has a "change name" link
to reset it.

The `?channel=` query param scopes the chat — open the same value in
multiple windows to talk to each other, change it to start a fresh session.

**Channel names must live in the `ai:` namespace** (e.g. `ai:test-1`,
`ai:weekend-plan`). The AI Transport SDK uses Ably's mutable-message
operations, which Ably only enables on channels in that namespace. The
default channel (`ai:day-out-planner:demo`) and the auto-derived sibling
itinerary channel (`<channel>:itinerary`) are both inside `ai:` already.

### Environment variables

| Variable                   | Required | Purpose                                                                       |
| -------------------------- | -------- | ----------------------------------------------------------------------------- |
| `ABLY_API_KEY`             | yes      | Server-side Ably key (used by both the agent session and JWT issuer).         |
| `ANTHROPIC_API_KEY`        | yes      | Used by `@ai-sdk/anthropic` to call Claude.                                   |
| `NEXT_PUBLIC_ABLY_CHANNEL` | no       | Default channel when `?channel=` is omitted (default `day-out-planner:demo`). |

## Using it

The chat is the only input surface. Two cases:

- **Plain chat between users**: any message that doesn't mention
  `@bernard`. It shows up in every connected client's chat pane, but no LLM
  is invoked.
- **Asking Bernard for help**: include `@bernard` anywhere in a message
  (case-insensitive). Bernard reads the recent conversation, suggests
  concrete real-world places (cinemas, restaurants, museums, etc.) and adds
  them to the shared itinerary via tool calls. The map and the list under
  it update on every connected client.

A worked example (from the original requirements):

1. Alice: `hey bob let's do something on saturday, i was thinking maybe pizza near avenida paulista`
2. Bob: `yeah sure but i wanted to go see devil wears prada 2 as well, maybe let's do that then eat?`
3. Alice: `sure sounds good, we could go to cine belas artes?`
4. Bob: `yeah, i like it there`
5. Alice: `cool, @bernard make a plan for us`

Bernard then replies with a short summary and writes one or two itinerary
items (cinema + pizza place). When Charlie joins later and says
`@bernard help us add a museum`, the map gains another marker on every
client.

## How it works

Two sibling Ably channels, one Ably connection per client:

```
              ┌─────────────────────────────────────────────────┐
              │    `<channel>` — chat (AI Transport SDK)        │
              │                                                  │
              │  ◄── chat messages (user + assistant)           │
              │  ◄── run-start / run-end                        │
              └─────────────────────────────────────────────────┘
                   ▲                              ▲
                   │ ClientSession                │ AgentSession
                   │ (every client)               │ (server route,
                   │                              │  only on @bernard)

              ┌─────────────────────────────────────────────────┐
              │ `<channel>:itinerary` — LiveObjects root LiveMap│
              │                                                  │
              │    "cine-belas-artes" → JSON({ name, lat, ...}) │
              │    "pizza-bráz"       → JSON({ name, lat, ...}) │
              └─────────────────────────────────────────────────┘
                   ▲                              ▲
                   │ root.subscribe(...)          │ root.set / .remove
                   │                              │
                 useItinerary                 Bernard's tools
                 (every client)               (server-side)
```

Key points:

- Every client subscribes to the channel via its own `ClientSession`, so
  user messages from other clients arrive naturally and the SDK's tree puts
  them in `view.nodes`.
- The server route inspects the most recent user message and short-circuits
  the run (no LLM call) when `@bernard` isn't present. So non-Bernard chat
  still pays for a no-op POST + a brief `run-start`/`run-end` lifecycle on
  the channel — fine for a demo, would be worth a "publish chat only" SDK
  affordance for production.
- Each user message is rewritten on the server before being passed to
  `streamText` so its text starts with the sender's `clientId`
  (e.g. `alice: hey bob...`). That's how Bernard attributes prose.
- Itinerary items are stored as JSON strings keyed by id inside the root
  LiveMap. Whole-item updates only; granular field updates would mean
  nested LiveMaps.

### Itinerary lives on a sibling channel

LiveObjects requires the channel to be attached with the `OBJECT_SUBSCRIBE`
and `OBJECT_PUBLISH` modes; default modes don't include them. The AI
Transport SDK fetches its channel internally via
`client.channels.get(name, opts)` and there's no public way to pass
`modes` through `ClientSessionOptions` / `AgentSessionOptions`.

Worse, you can't set the modes "first" and then let the SDK piggy-back:
`ably-js`'s `channels.get(name, options)` calls `setOptions`, which
_replaces_ the channel's options wholesale
(`realtimechannel.ts:setOptions`). So when the SDK later calls
`channels.get(name, { params: ... })` it wipes any `modes` a caller had
set first.

To keep things simple without changing the SDK, the demo splits the work
across two sibling channels on the same connection:

- `<channelName>` — chat, owned by the AI Transport SDK. No OBJECT modes
  needed.
- `<channelName>:itinerary` — LiveObjects root LiveMap. The SDK never
  touches this channel, so its OBJECT modes are stable.

The mapping is centralised in `src/app/itinerary.ts` as
`itineraryChannelName(chatChannelName)`.

The right long-term fix is for `@ably/ai-transport` to expose a
`channelOptions` / `modes` field on `ClientSessionOptions` and
`AgentSessionOptions` and merge user modes with what the SDK needs
(agent-registration params, rewind window). With that, the chat and the
LiveObjects state could share a single channel.

## File map

| File                                                                       | What it does                                                                |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `src/app/api/chat/route.ts`                                                | Agent session, `@bernard` gate, sender annotation, `streamText` invocation. |
| `src/app/api/chat/tools.ts`                                                | `addItineraryItem` / `updateItineraryItem` / `removeItineraryItem` tools.   |
| `src/app/api/auth/ably-token/route.ts`                                     | JWT issuer with `object-publish`/`object-subscribe` capabilities.           |
| `src/app/providers.tsx`                                                    | Ably realtime client with the `LiveObjects` plugin registered.              |
| `src/app/page.tsx`                                                         | Name gate, channel resolution, provider wiring.                             |
| `src/app/components/planner.tsx`                                           | Top-level layout (chat ⏐ map + list).                                       |
| `src/app/components/{chat-pane,message-list,message-bubble,input-bar}.tsx` | Chat UI.                                                                    |
| `src/app/components/{map-pane,map-impl,itinerary-list}.tsx`                | Leaflet map (SSR-disabled) + list.                                          |
| `src/app/hooks/use-itinerary.ts`                                           | Subscribes to the LiveObjects root and exposes `ItineraryItem[]`.           |
| `src/app/hooks/use-name.ts`                                                | Local-storage backed name with a modal gate.                                |
| `src/app/itinerary.ts`                                                     | Shared `ItineraryItem` / `ItineraryRoot` types.                             |

## Known rough edges

- The Leaflet default marker icon is loaded from
  `unpkg.com/leaflet@1.9.4/dist/images/...` rather than bundled — keeps the
  code free of bundler-specific casts at the cost of a CDN dependency.
- Two users picking the same name collide on `clientId`. Not handled — fine
  for a demo, would need a uniqueness suffix in real use.
- Bernard's lat/lng accuracy is whatever the model recalls. For São Paulo
  examples it tends to be close enough to land the marker on the right
  block; YMMV elsewhere.
