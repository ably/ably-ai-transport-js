# Plan: de-hack the day-out-planner demo onto the mature SDK + LiveObjects

## Context

The `day-out-planner` demo (a multi-human + AI-agent group chat for planning a
day out, with a shared itinerary on a map) was built to support a draft blog
post about durable sessions being a shared medium for human↔human and
human↔agent collaboration. Fiona's review of the blog
([thread](https://ably-real-time.slack.com/archives/C09SY1AQGK0/p1780314948256159))
asks — among other things — to "explain in more detail how a durable session
lets the developer choose when the agent does work … illustrate with a code
snippet if it's neat." We can't currently show that snippet honestly, because
the demo relies on two hacks:

1. **Server-side `@bernard` gate.** Every chat message is POSTed to `/api/chat`,
   which starts a run and immediately ends it without invoking the LLM unless
   the message mentions `@bernard`. So every plain chat message pays for a no-op
   POST + a `run-start`/`run-end` pair on the channel.
2. **Sibling itinerary channel.** LiveObjects needs `OBJECT_*` channel modes,
   but the old SDK gave no way to request modes on the session's channel (and
   `channels.get(name, opts)` wiped them), so the itinerary lives on a separate
   `<channel>:itinerary` channel.

**Investigation result: both hacks are removable with no SDK changes.** The
mature SDK on `main` plus PR #182 (`origin/liveobjects` = `main` + 2 LiveObjects
commits) already provide everything:

- The generic React layer **no longer auto-POSTs** — `ClientSessionProviderProps
  = Omit<ClientSessionOptions, 'client'>`; the old `api`/`body` props are gone.
  `view.send()` publishes the message into the durable session and returns an
  `ActiveRun`; **the app decides whether to wake the agent** by POSTing
  `run.toInvocation().toJSON()`. This is exactly "the developer chooses when the
  agent does work", and it's a genuinely neat snippet.
- PR #182 adds a `channelModes` option to `ClientSessionOptions` /
  `AgentSessionOptions`, exports `OBJECT_MODES`, exposes `session.object`, and
  fixes the mode-wipe via a shared resolver. Chat + itinerary can share **one
  channel**.

**Scope of this plan: the demo, its README, and a new design-notes doc.** Get
the demo into good shape (no hacks, mature API). The blog rewrite is a mapped
follow-up (see end), deliberately not executed here.

## Guiding principle: implement as if from scratch

The end state must read as a clean, first-time implementation. **No vestiges of
previous attempts** in the demo code or README: no comments or prose that frame
anything as a migration or reference the old hacks (e.g. "no longer gate on
@bernard here", "itinerary used to be on a sibling channel", "this is now handled
by the frontend"). Every comment and doc describes the current design on its own
terms. The honest caveats live in a dedicated design-notes doc (below), framed as
forward-looking design notes, not as "we used to do X".

This branch (`day-out-planner-demo-updated-2026-06-15`) is intentionally an
internal scaffolding branch — the `planning/` directory stays as the work record.
A separate branch with tidied commit history will be cut later for actually
publishing the demo, so commit-message hygiene here is secondary, but the demo
code + README must already be publish-clean. The merge commit may reference
bringing in the mature SDK + #182; the demo edits read as fresh implementation.

## Merge is clean

This branch's 14 unique commits touch only `demo/…` and `…/planning`; `main`
never touched this demo dir; the two sides changed disjoint paths. So
`git merge origin/liveobjects` produces **no conflicts**. The demo code will not
*compile* against the new API afterwards, but that's the rewrite below, not
conflict resolution.

## Step 1 — Merge the SDK changes (preserve history, per your preference)

```sh
git merge origin/liveobjects   # = main + #182 in one clean merge
```

`origin/liveobjects` already contains all of `main` plus `627f96d6 feat:
liveobjects passthrough` and `bd154cd4 docs`. One merge brings both the mature
Invocation API and the LiveObjects passthrough. (Two-step `main` then the
LiveObjects branch is possible but adds nothing here.)

After merging, the root lockfile / `package.json` / submodule pointers come from
`main` as-is. Run a top-level `pnpm install` (the repo moved to pnpm on `main`)
and the demo's own install before testing.

## Step 2 — Rewrite the demo to the mature API (removes both hacks)

Reference implementation to mirror throughout: the mature
`demo/vercel/react/use-client-session/` demo at `origin/liveobjects` (its
`providers.tsx`, `helpers.ts` (`wakeAgent`), `chat.tsx`, `api/chat/route.ts`).

All paths below are under `demo/vercel/react/day-out-planner/`.

### Client

- **`src/app/providers.tsx`** — `createSessionHooks` now takes 4 type params:
  ```ts
  import type { VercelInput, VercelOutput, VercelProjection } from '@ably/ai-transport/vercel';
  export const SessionHooks = createSessionHooks<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>();
  ```
  Keep the `LiveObjects` plugin registered on the Realtime client (already done).

- **`src/app/page.tsx`** — `<ClientSessionProvider>` drops `api` / `body`; add
  `channelModes={OBJECT_MODES}` (import `OBJECT_MODES` from `@ably/ai-transport`).
  The agent endpoint (`/api/chat`) is now passed down to the send site instead.

- **`src/app/helpers.ts`** — add a `wakeAgent(api, run)` helper (copy from the
  reference demo): `fetch(api, { method:'POST', body: JSON.stringify(run.toInvocation().toJSON()) })`.

- **`src/app/components/input-bar.tsx`** (+ `chat-pane.tsx`/`planner.tsx` wiring)
  — the send site. Every message is published into the session; mentioning
  `@bernard` additionally wakes the agent:
  ```ts
  const run = await view.send(UIMessageCodec.createUserMessage(userMessage(text)));
  // Plain messages stay in the shared session for everyone (and Bernard's
  // future context); mentioning @bernard wakes the agent for this message.
  if (mentionsBernard(text)) {
    await wakeAgent(api, run);
  }
  ```
  `mentionsBernard` lives client-side. The InputBar needs `view` (or a bound
  send-fn) and the agent endpoint passed in. Comment describes the design, not a
  "moved the gate to the frontend" migration.

- **`src/app/hooks/use-itinerary.ts`** — stop opening a sibling channel. Take the
  session (from `useClientSession`) and read the shared root via
  `session.object.get<ItineraryRoot>()`; subscribe as before. Removes the
  `ITINERARY_CHANNEL_MODES` / `itineraryChannelName` usage.

### Server

- **`src/app/api/chat/route.ts`** — adopt the mature agent pattern and delete the
  gate:
  - `const data = (await req.json()) as InvocationData; const invocation = Invocation.fromJSON(data);`
    (`InvocationData` is now non-generic — `{ inputEventId, sessionName }`.)
  - `createAgentSession({ client: ably, channelName: invocation.sessionName, channelModes: OBJECT_MODES })`.
  - `await run.start(); await run.loadConversation();`
  - LiveObjects root from the **same** channel: `const root = await session.object.get<ItineraryRoot>();`
    (delete `getItineraryRoot` / `rootCache` / sibling channel).
  - The route is the agent endpoint: it's reached when a client wakes the agent,
    so it always runs the model (no gating logic). Comment it as "the agent
    endpoint", not "we no longer gate here".
  - Pipe + outcome via the reference pattern: `const pipeResult = await run.pipe(result.toUIMessageStream()); const outcome = await vercelRunOutcome(pipeResult, result.finishReason);` then `suspend`/`end`; return `Response.json({ runId: run.runId, invocationId: run.invocationId })`.
  - **Sender attribution** (Bernard needs to know who said what): `run.messages`
    is LLM-ready but carries no `clientId`. Recover the sender from node headers
    instead — `MessageNode.headers` (see `src/core/transport/types/tree.ts`)
    carries the identity headers, and `run.view.messages` / `run.tree` expose the
    `MessageNode`s. Build the attributed `UIMessage[]` by prepending the sender's
    clientId to each user message's text (the mature analogue of the current
    `annotateSender`), then `convertToModelMessages(...)`. Confirm the exact
    header key and the tree-walk for full history during implementation.

- **`src/app/api/chat/tools.ts`** — unchanged except it now receives the root
  obtained from `session.object.get()` (same `LiveMapPathObject<ItineraryRoot>`
  type). No logic change.

- **`src/app/itinerary.ts`** — drop `itineraryChannelName()`. Keep
  `ItineraryItem` / `ItineraryRoot`; rewrite the doc comment to simply describe
  the data shape (JSON-string-keyed items in the session's root LiveMap), with no
  sibling-channel rationale.

- **`src/app/api/auth/ably-token/route.ts`** — already grants
  `object-publish` / `object-subscribe` on `*`, so it covers the (now single)
  chat channel. No change needed; verify during testing.

### Docs

- **`README.md`** — rewrite so it reads as a fresh, from-scratch demo write-up.
  Describe one shared channel (chat + itinerary LiveObjects via
  `channelModes: OBJECT_MODES` + `session.object`) and the input model (plain
  chat = `view.send`; `@bernard` = `view.send` + `wakeAgent`) as *the* design.
  Remove the "Itinerary lives on a sibling channel" section, the "@bernard gate"
  explanation, and any "known rough edges" that reference the old hacks. Diagram
  shows a single channel. Link to the design-notes doc for caveats.

- **`DESIGN-NOTES.md`** (new, in the demo dir) — the honest companion to the
  clean README: rough edges and decisions that aren't canonical. Framed as
  forward-looking design notes (what we chose and why, where the SDK might grow a
  first-class affordance later), never as "we used to…". Contents:
  1. **Representing non-invocation user input.** Plain chat is published with
     `view.send(UIMessageCodec.createUserMessage(...))` — the *same* `ai-input`
     wire format as a message that wakes the agent; the only difference is whether
     the app POSTs an invocation. Upside: every human message lands in the message
     tree and so in Bernard's LLM context next time he runs. Caveat: there is no
     wire-level marker distinguishing "chat-only" from "agent-invoking" input, and
     the SDK has no first-class "publish without invocation" concept — this is a
     deliberate interim representation (per `planning/follow-up/REQUIREMENTS.md`),
     not a blessed pattern.
  2. **Sender identity / client-id extraction.** Attribution is done by reading
     the publisher's clientId from transport node headers (`MessageNode.headers`)
     and prefixing it onto the user message text before the model sees it. There
     is no canonical "sender" field on a `UIMessage`; prefixing into the text is a
     pragmatic way to get attribution into the LLM context. Records the specific
     header key relied on.
  3. **Itinerary state shape.** Flat root `LiveMap` of JSON-string values keyed by
     item id; whole-item replacement only (no nested LiveMaps / granular field
     updates) — a deliberate simplification.
  4. **No real research / tool-augmented grounding.** Bernard has only the three
     itinerary-mutation tools — no web search, geocoding, or showtime lookup.
     Venues, timings, and lat/lng all come from the model's own
     (training-cutoff, possibly-inaccurate) knowledge, per the system prompt's
     "you do not have web access" instruction.
  5. **No user-location awareness.** There is no geolocation, presence, or other
     location signal. Bernard infers the relevant area *solely* from places the
     users name in the conversation (e.g. "near Avenida Paulista"); with no place
     mentioned he has nothing to anchor on.
  6. Minor demo rough edges worth noting: same-name users collide on `clientId`;
     the Leaflet marker icon is loaded from a CDN.

## Verification

Manual end-to-end (the demo has no unit tests, matching `use-client-session`):

1. `pnpm install` at repo root; then in the demo dir install + `npm run dev`.
2. Open two tabs: `localhost:3000?channel=ai:test-1&user=alice` and `…&user=bob`.
3. Plain chat (no `@bernard`) → appears in both tabs, **no** `/api/chat` POST
   (check Network), **no** `run-start`/`run-end` on the channel, map stays empty.
4. `@bernard plan us pizza + a film near Avenida Paulista` → Bernard replies,
   markers appear on **both** maps and the list, all on the **single** channel
   (confirm no `:itinerary` channel is created — e.g. via Ably dev console).
5. Refresh a tab → history hydrates and the itinerary reloads from LiveObjects on
   the shared channel.
6. Repo-root validation per CLAUDE.md: `npm run typecheck`, `npm run lint`,
   `npm run format:check` (note: post-merge the toolchain is pnpm; use the
   workspace's configured scripts).
7. Hygiene pass: re-read the demo source + README for any migration/hack vestige
   (grep for "sibling", "gate", "no longer", "used to", "now handled") — the only
   place caveats appear is `DESIGN-NOTES.md`, framed as design notes.

## Follow-up (NOT in this task) — how the cleaned demo unblocks the blog

Once the demo lands, Fiona's points become light editing (~half a day):

- *"Choose when the agent does work" + code snippet* → the `view.send` +
  conditional `wakeAgent` snippet above; contrast with the non-durable path
  (every message unconditionally POSTs history to the agent).
- *History/replay for late joiners* → call out in the technical section (the
  Trevor-joins-late narrative already demonstrates it; SDK hydrates from channel
  history).
- *multi-user / multi-agent* SEO terms, *name the other AIT features*
  (resumable streaming, multi-surface, human handover, bidirectional control,
  presence — from the AIT positioning page), *screenshots per narrative section*,
  optional durable-sessions diagram.

No SDK changes are required to address any of the feedback.
