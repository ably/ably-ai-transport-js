# Day out planner demo

## Context

All work happens inside the **`ait-day-out-planner-demo` worktree group**, in
the `ably-ai-transport-js` repo on the `day-out-planner-demo` branch. Absolute
path:

```
/Users/lawrence/code/work/ably/sdk-workspace/worktree-groups/ait-day-out-planner-demo/ably-ai-transport-js/
```

All file paths below are relative to that repo root. No other repos in the
worktree group are touched, and no spec changes are needed (this is a demo,
not an SDK behaviour change).

A new demo app is added at `demo/vercel/react/day-out-planner/`, modelled on
the existing `demo/vercel/react/use-client-session/` Next.js app. Multiple users join a
shared channel and chat freely; when someone mentions `@bernard`, an AI agent
("Bernard") runs server-side, replies into the chat, and writes itinerary
items to a shared Ably LiveObjects map. The client renders the itinerary as
both a Leaflet map and a list. See `REQUIREMENTS.md` for the source brief.

This demo exercises three things together: the richer `useClientSession`
hooks, server-side tool calls from `createAgentSession`, and Ably LiveObjects
for shared state.

## Decisions and trade-offs locked in

- **Map renderer**: Leaflet via `react-leaflet`, OpenStreetMap tiles. No API
  key, no signup.
- **Item storage** (in the LiveObjects root LiveMap): one entry per item,
  keyed by id, value is a JSON-stringified `{ name, lat, lng, time?, notes? }`.
  Simpler than nested LiveMaps; whole-item updates only.
- **`@bernard` gating**: every user message goes through `view.send()` and
  reaches `/api/chat`. The server inspects the latest user message; if it
  doesn't mention `@bernard` (case-insensitive substring match), it calls
  `run.start()` then immediately `run.end('complete')` without invoking the
  LLM. Complications this carries:
  - Every chat message pays for a no-op POST to `/api/chat`.
  - Every chat message produces a `run-start`/`run-end` pair on the channel,
    so `useActiveRuns` will briefly flicker for the sender. We won't render
    activity for that.
  - This is arguably a gap in the SDK — a collaborative-chat-with-AI use
    case wants a "publish chat only" path that doesn't invoke the agent.
    Out of scope for this demo; noting it as follow-up.
- **Sender identity for Bernard**: each user picks a name on first load; the
  name is used directly as the Ably `clientId`. On the server, before passing
  history to `streamText`, prepend `<clientId>: ` to the text of each
  user-role message so Bernard can attribute the prose. Read clientId from
  `node.headers['x-ably-run-client-id']` on each `MessageNode`.
- **Name capture**: simple modal on first load, persisted to `localStorage`.
  Header has a "change name" link that clears it and reloads. Collisions are
  accepted (the requirement says we don't care).
- **Bernard's tools**: itinerary mutations only — `addItineraryItem`,
  `updateItineraryItem`, `removeItineraryItem`. No real web search; Bernard
  uses the LLM's own knowledge for places, showtimes, lat/lng.
- **Model**: `anthropic('claude-sonnet-4-6')`, matching the existing demo.

## Architecture

### Single Ably channel, two layers

- **AI Transport SDK** (chat messages, runs): every client has a
  `ClientSession` on channel `dop:<channel-name>`. All clients see all
  messages because `ClientSession` subscribes to the whole channel and the
  decoder upserts every `message.create` into the tree.
- **LiveObjects** (itinerary state): the same channel is used for the root
  `LiveMap`. Server tools write to it; clients subscribe and render.

The SDK creates the channel internally with default modes. Default channel
modes include all of `SUBSCRIBE`, `PUBLISH`, `PRESENCE`, `OBJECT_SUBSCRIBE`,
`OBJECT_PUBLISH`, so LiveObjects should work on the SDK's channel without
extra config. To be defensive, the client and server will both call
`client.channels.get(channelName, { modes: [...] })` before the SDK creates
its channel, with all modes including OBJECT modes — this is a no-op if the
defaults already cover it, but pins the contract.

### Server-side LiveObjects access from tools

The route handler creates the Ably client with the `LiveObjects` plugin
registered, gets the channel, awaits `channel.object.get()` for the root,
and closes over the root in each tool's `execute` function. The same client
is passed to `createAgentSession`.

## File layout

New directory: `demo/vercel/react/day-out-planner/`. Mirrors
`demo/vercel/react/use-client-session/` structurally. New/changed files:

```
demo/vercel/react/day-out-planner/
├── package.json                          (deps incl. ably, ai, @ai-sdk/anthropic,
│                                          jsonwebtoken, leaflet, react-leaflet)
├── next.config.ts
├── tsconfig.json
├── postcss.config.mjs
├── .env.local.example                    (ABLY_API_KEY, ANTHROPIC_API_KEY,
│                                          NEXT_PUBLIC_ABLY_CHANNEL)
└── src/app/
    ├── layout.tsx                        (Leaflet CSS import here)
    ├── page.tsx                          (channel/name resolution, providers,
                                            renders <Planner />)
    ├── providers.tsx                     (AblyProvider with LiveObjects plugin
                                            registered; ClientSessionProvider with
                                            UIMessageCodec, channelName, clientId)
    ├── globals.css
    ├── helpers.ts                        (userMessage(), mentionsBernard())
    ├── api/
    │   ├── auth/ably-token/route.ts      (JWT — copy from use-client-session)
    │   └── chat/
    │       ├── route.ts                  (agent session, @bernard gate,
                                              streamText with tools)
    │       └── tools.ts                  (addItineraryItem etc., close over
                                              LiveObjects root)
    ├── hooks/
    │   ├── use-name.ts                   (modal-style name prompt + localStorage)
    │   └── use-itinerary.ts              (subscribe to LiveObjects root, return
                                              ItineraryItem[])
    └── components/
        ├── planner.tsx                   (top-level layout: chat | map+list)
        ├── chat-pane.tsx                 (message list + input bar)
        ├── input-bar.tsx                 (text input; emits view.send)
        ├── message-list.tsx              (renders messages with sender labels)
        ├── message-bubble.tsx            (single message, badged by clientId/
                                              bernard)
        ├── map-pane.tsx                  (Leaflet MapContainer with markers)
        ├── itinerary-list.tsx            (list view alongside map)
        ├── name-modal.tsx                (first-load name prompt)
        └── header.tsx                    (title, change-name link, channel
                                              display)
```

Files outside the demo: none. Nothing else in the repo changes.

## Server route — sketch

`demo/vercel/react/day-out-planner/src/app/api/chat/route.ts`:

```ts
import { streamText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import Ably from 'ably';
import LiveObjects from 'ably/liveobjects';
import { after } from 'next/server';
import { createAgentSession } from '@ably/ai-transport/vercel';
import { buildTools } from './tools.js';

export async function POST(req: Request) {
  const { invocation } = await req.json(); // shape: { sessionName, ... }

  const ably = new Ably.Realtime({
    key: process.env.ABLY_API_KEY!,
    plugins: { LiveObjects },
  });
  const channel = ably.channels.get(invocation.sessionName, {
    modes: ['SUBSCRIBE', 'PUBLISH', 'OBJECT_SUBSCRIBE', 'OBJECT_PUBLISH'],
  });
  const itineraryRoot = await channel.object.get();

  const session = createAgentSession({ client: ably, channelName: invocation.sessionName });
  await session.connect();
  const run = session.createRun(invocation, { signal: req.signal });

  const history = run.view.messages.map((node) => annotateSender(node));
  const latestUser = lastUserText(history);

  if (!mentionsBernard(latestUser)) {
    // Non-bernard chat: no LLM, just close the run.
    run.start();
    after(async () => { await run.end('complete'); session.close(); });
    return new Response(null, { status: 204 });
  }

  run.start();
  const result = streamText({
    model: anthropic('claude-sonnet-4-6'),
    system: BERNARD_SYSTEM_PROMPT,
    messages: history,
    tools: buildTools(itineraryRoot),
    abortSignal: run.abortSignal,
  });

  after(async () => {
    await run.pipe(result.toUIMessageStream());
    await run.end('complete');
    session.close();
  });

  return new Response(/* run handle response per existing demo */);
}
```

`tools.ts` exports `buildTools(itineraryRoot)` which returns the three
itinerary mutation tools, each closing over `itineraryRoot` and writing via
`itineraryRoot.set(id, JSON.stringify(item))` / `itineraryRoot.remove(id)`.

The exact response shape and `streamResponseWithApprovalRedirect` usage are
copied from `demo/vercel/react/use-client-session/src/app/api/chat/route.ts`
— I won't reinvent it.

## Client side — sketch

- `providers.tsx`: creates `new Ably.Realtime({ authCallback, plugins: { LiveObjects } })`,
  pre-gets the channel with the four modes, then wraps with
  `ClientSessionProvider` (channelName, codec=UIMessageCodec, clientId=name,
  api=`/api/chat`, body=`() => ({ sessionName: channelName })`).
- `use-name.ts`: reads `localStorage`; if missing, blocks rendering with
  `<NameModal>`; on submit, persists and proceeds.
- `use-itinerary.ts`: uses the AblyProvider's client, gets the channel root
  via `channel.object.get()`, subscribes, derives `ItineraryItem[]` from
  `root.entries()` + `JSON.parse`.
- `chat-pane.tsx`: uses `useView({ limit: 50 })`, renders nodes via
  `<MessageBubble>` showing `node.headers['x-ably-run-client-id']` as the
  sender label, special-cases Bernard's assistant messages.
- `map-pane.tsx`: `react-leaflet` `<MapContainer>` centred on the mean of
  current item coords (or a sensible default if empty), markers per item.
- `itinerary-list.tsx`: bullet list with name, time, notes.

## Verification

End-to-end smoke test, driven manually in a browser:

1. From the worktree-group repo root
   (`worktree-groups/ait-day-out-planner-demo/ably-ai-transport-js`):
   `cd demo/vercel/react/day-out-planner && npm install`.
2. Create `.env.local` with `ABLY_API_KEY` (sandbox key or local) and
   `ANTHROPIC_API_KEY`.
3. `npm run dev`.
4. Open two windows: `http://localhost:3000?channel=test-1` and
   `http://localhost:3000?channel=test-1`.
5. Enter different names ("alice", "bob") in the modals.
6. Chat between the two without `@bernard` → messages appear on both,
   no Bernard response, map empty.
7. Have alice send `@bernard pizza near avenida paulista on saturday` →
   Bernard replies with a place suggestion, a marker appears on both maps,
   the list updates on both.
8. Have bob send `@bernard add a cinema before that` → another item is
   added; both clients see it.
9. Refresh one client → name persists, chat history hydrates, itinerary
   re-loads from LiveObjects state, map redraws.

Project validation per `CLAUDE.md` workflow rules: `npm run typecheck`,
`npm run lint`, `npm run format:check` at the repo root before presenting
changes. No new unit tests required (this is a demo app, not SDK code),
matching how `use-client-session/` is treated — but the repo root's lint
and typecheck pipelines will pick up the new code.

## Out of scope / explicit non-goals

- Real web search / showtime APIs.
- Persistence of chat history beyond Ably channel rewind.
- Authentication beyond the existing token endpoint copy.
- Mobile-responsive layout.
- A "publish chat without invoking the agent" SDK feature (the no-op POST
  is fine for a demo; revisit if the demo lands and the cost becomes felt).
- Specification updates: this is a demo, not an SDK behaviour change, so
  no `AIT-` spec points are needed.

## Open watchpoints (things I'd flag during implementation)

- Verify the default `channels.get(name)` modes truly include OBJECT_*. If
  not, the pre-create call in `providers.tsx` (and the server route)
  becomes load-bearing rather than defensive.
- `react-leaflet` needs the Leaflet CSS imported once at the app level
  (`layout.tsx`) and SSR-disabled wrapper for the `MapContainer` (use
  `next/dynamic` with `ssr: false`).
- The exact form of `run.view.messages` on the server — whether it's the
  fully-resolved `MessageNode[]` after history hydration or requires
  awaiting something — I'll confirm against `use-client-session`'s route
  before coding.
- `channel.object.get()` from the server may need the channel to be
  attached first; if so, an explicit `await channel.attach()` goes in
  before it.
