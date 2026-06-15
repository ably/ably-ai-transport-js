# Design notes

Decisions and rough edges in this demo, split into:

- **A. SDK gaps** — places where `@ably/ai-transport` or Ably LiveObjects could
  improve; the demo works around them.
- **B. Demo shortcuts** — deliberate simplifications, not SDK issues.
- **C. Build / setup notes.**

---

## A. SDK gaps surfaced by this demo

### A1. The agent can't cleanly attribute per-message sender

Bernard is told **who just asked** for help, but the earlier conversation he
reads is **not** attributed message-by-message.

- **Current asker (server):** `session.tree.getRunNode(run.runId)?.clientId` in
  `api/chat/route.ts` — the run that triggered the invocation carries the
  publisher's `clientId`.
- **Sender labels (client):** `view.runOf(codecMessageId)?.clientId` in
  `message-list.tsx` — each visible message's owning run carries the sender.

The gap is the agent's **history**: `run.messages` (the conversation the agent
rebuilds from the channel via `loadConversation()`) is a flat `UIMessage[]` with
no per-message sender. The data exists in the tree (every run node has a
`clientId`), but there's no public accessor pairing each historical message with
its sender, so Bernard sees prior turns as one unattributed stream. A clean fix
would have the agent surface the conversation as `CodecMessage[]` with
`clientId`, the way the client's `view.messages` + `view.runOf` already does. We
deliberately avoided the alternative (injecting the sender into message text/data
parts), which pollutes the stored conversation.

**This is a step backwards from an earlier version of this demo.** Against the
earlier SDK, the agent received the whole invocation history as message _nodes_
carrying their transport headers, so the route could read each message's sender
straight off `node.headers['x-ably-run-client-id']` (on `run.view.messages`) and
prefix the name before calling the LLM — full per-message attribution, server
side, no hacks. The mature API removed that affordance: `run.view.messages` is
now the current invocation's input only and returns empty `headers`, and the
rebuilt `run.messages` carries no sender. So the information the agent used to
have is no longer reachable through the public API.

### A2. No first-class "publish a message without invoking the agent"

A plain chat message and a message that wakes Bernard are published identically
— both are ordinary `ai-input` user messages
(`view.send(UIMessageCodec.createUserMessage(...))`). The only difference is that
the client POSTs the invocation to `/api/chat` **only** when `@bernard` is
mentioned (`chat-pane.tsx`).

That gives us what we want (every human message lands in the session and so in
Bernard's context), but there is **no wire-level marker** distinguishing
"chat-only" from "agent-invoking" input, and the SDK has no dedicated
"publish-without-invocation" concept — this is an interim representation, not a
blessed pattern. Side effect: because `view.send` always mints a run, a plain
chat message creates a client-side run that no agent ever starts or ends. It
stays open on the client; we don't render run status for user messages, so it
isn't visible, but it's there.

### A3. No `LiveList` type for ordered collections

The itinerary is an ordered list of places, but LiveObjects offers only
`LiveMap` and `LiveCounter` — there's no list/array type. We fake ordering with a
root `LiveMap` keyed by item id plus a fractional `order` field on each item, so
inserting between two items just picks a value between their orders (e.g. 1.5
between 1 and 2) with no renumbering. A `LiveList` primitive would remove the
need for this.

### A4. Outdated SDK JSDoc

`View.send` / `ViewHandle.send` (`src/core/transport/types/view.ts`,
`src/react/use-view.ts`) say "Send … and fire a POST … The HTTP POST is
fire-and-forget". That's stale: the client session never sends HTTP — waking the
agent is the application's job (it POSTs `run.toInvocation()`), as the
`ClientSession` source itself documents. Worth correcting so the contract reads
true.

---

## B. Demo shortcuts

### B1. Itinerary items stored as JSON strings (whole-item updates)

Each item is a JSON-stringified value in the root `LiveMap`, so updating any
field rewrites the whole item. Nested `LiveMap`s per item would allow granular
field-level updates; whole-item replacement is plenty for a demo. (See also A3
for why the collection is a map at all.)

### B2. Bernard has no real research / tool-augmented grounding

His only tools are the three itinerary mutations — no web search, geocoding, or
showtime lookup. Venue names, timings, and latitude/longitude all come from the
model's own (training-cutoff, possibly-inaccurate) knowledge, per the system
prompt's "you do not have web access" instruction. Markers can land on the wrong
block; for well-known areas they tend to be close enough.

### B3. Bernard has no idea where the users actually are

There is no geolocation, presence, or any other location signal. He infers the
relevant area **solely** from places the users name in the conversation
(e.g. "near Avenida Paulista"). With no place mentioned, he has nothing to anchor
on.

### B4. Minor

- Two people picking the same name collide on `clientId`. Not handled.
- The Leaflet default marker icon is loaded from a CDN rather than bundled.

---

## C. Build / setup notes

- **Peer version pinning.** The demo links the local `@ably/ai-transport` build
  (`link:../../../..`) but installs its own `ai` / `react` / `react-dom`. If
  those drift from the versions the SDK build resolved, TypeScript sees two
  unrelated copies of the `ai`/`ably` types and rejects passing values between
  them. `pnpm-workspace.yaml` pins them via `overrides` to match the SDK build;
  update the overrides if the SDK's resolved versions change.
- **Supply-chain cooldown.** `pnpm-workspace.yaml` sets `minimumReleaseAge`
  (reject packages published in the last 7 days). A fresh install can fail if a
  dependency published a release within that window; either wait it out or pin
  the affected package to an older version.
