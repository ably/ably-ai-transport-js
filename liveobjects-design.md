# Design: LiveObjects pass-through on AI Transport sessions

## Goal

Make Ably's LiveObjects feature available on the same channel a session uses for AI
Transport, mirroring the recently-shipped presence pass-through. Two deliverables:

1. **Object pass-through** — expose the channel's `RealtimeObject` on both
   `ClientSession` and `AgentSession`, the way `presence` is exposed.
2. **Hooks work out-of-the-box** — ensure the existing `<ChannelProvider>` pass-through
   plays nicely so descendants can use ably-js channel hooks against the session's
   channel.

This is the LiveObjects analogue of the work in commits `0fcfa76` (pass through pubsub
presence api) and `5578594` (implicit `<ChannelProvider>` for core pubsub hooks).

## Background — why this is not a straight copy of presence

Presence "just works" on any attached channel: presence modes are part of the server's
default channel-mode set, so the session never had to set channel `modes` at all.
LiveObjects is different in three ways that drive this design.

### 1. Object operations require explicit channel modes

LiveObjects reads/writes require the channel to be attached with the `object_subscribe` /
`object_publish` modes. ably-js enforces this client-side
(`ably-js` `src/plugins/liveobjects/realtimeobject.ts:566`, spec RTO2): every `get()` /
write throws `ErrorInfo` code `40024` unless the user-supplied `channelOptions.modes`
includes the relevant object mode — even after a successful attach.

### 2. Setting `modes` is a full replacement, not additive

Confirmed against the realtime backend
(`realtime` `go/realtime/lib/channel/options.go:93`):

```go
opts.RequestedMode = cmp.Or(opts.RequestedParams.Modes, urlParams.Modes, req.Flags&MODE_FLAGS, MODE_DEFAULT)
```

`cmp.Or` is select-first. The moment an ATTACH carries any mode flag, that bitfield is
taken verbatim as the complete requested set and `MODE_DEFAULT` is never reached. The
granted set is then `requested ∩ capability`
(`go/realtime/lib/channel/attachment.go:1730`).

The server default (`go/realtime/lib/channel/flags.go:34`) is:

```
MODE_DEFAULT = PRESENCE_PUBLISH | MESSAGE_PUBLISH | MESSAGE_SUBSCRIBE | PRESENCE_SUBSCRIBE | ANNOTATION_PUBLISH
```

Object modes are **not** in the default (`flags.go:26-27`) — they are opt-in only.

**Consequence:** to use LiveObjects _and_ keep everything AIT relies on today, the
session must request the full default set **plus** the object modes. Requesting only the
object modes would silently drop `subscribe`, `publish`, presence, and — critically —
`annotation_publish`, which AIT's message appends/annotations depend on.

### 3. Silent mode reversion is the real hazard

`normaliseChannelOptions` replaces rather than merges
(`ably-js` `src/common/lib/util/defaults.ts:377`), and `_shouldReattachToSetOptions`
only checks modes when `options.modes` is truthy
(`ably-js` `src/common/lib/client/realtimechannel.ts:245`). So any `setOptions` /
`channels.get` call on the same channel that omits `modes` wipes the previously-set modes
from `channelOptions` **without triggering a reattach** — it looks fine until the next
transport drop/resume sends an ATTACH with no mode flags, the server falls back to
`MODE_DEFAULT`, and LiveObjects silently stops syncing.

AIT has exactly the multi-writer setup that triggers this:

- `ClientSession` constructor — `client.channels.get(channelName, { params: { agent } })`
  (`src/core/transport/client-session.ts:141`)
- `AgentSession` constructor — `client.channels.get(channelName, { params: { agent }, params.rewind })`
  (`src/core/transport/agent-session.ts:397`)
- React `<ChannelProvider>` — re-`get`s the same channel and calls `setOptions` with the
  provider's `channelOptions` (`src/react/contexts/client-session-provider.tsx:202`)

(The `load-history` / `load-conversation` paths receive a channel and call `attach()` on
it — they do not re-resolve, so they are not writers.)

If any one of these writes options without the modes the others set, modes revert. The
fix is to set the **same** modes, in the **same canonical order**, on **every** option
write to the channel (`arrEquals` is order- and duplicate-sensitive,
`realtimechannel.ts:246`).

### Good news: no reattach churn from adding object modes

Server-side, a re-ATTACH on an existing attachment is an in-place _update_
(`go/realtime/lib/channel/attachment.go:618-633`, `:973-1022`) with a no-op
short-circuit when modes are unchanged (`:1000-1009`). The subscribe stream is only torn
down if `MESSAGE_SUBSCRIBE` itself flips (`:1043-1058`) — adding object modes while
keeping `subscribe` leaves the stream intact, so there is no message loss and no presence
re-entry. Client-side, a modes change reattaches in-place via `attachImpl()` without going
through DETACHING. So as long as modes are set consistently, the change is clean.

## API stability

LiveObjects is GA as of ably-js **2.20.0** (2026-03-13) — "no longer in Public Preview
and is now generally available" (ably-js CHANGELOG). `liveobjects.d.ts` carries no
`@experimental`/`@beta` annotations. Under semver, the public API will not break without a
**v3 major bump**. (Caveat: it broke during minor `2.16.0` while still in preview — the
`channel.objects` → `channel.object` PathObject redesign — but that is behind us now that
it is GA. It reached GA only ~3 months ago and the protocol is still evolving additively.)

The entry point is `channel.object` (singular) → `RealtimeObject`
(`ably-js` `liveobjects.d.ts:2352`, `src/common/lib/client/realtimechannel.ts:162`).

LiveObjects is a **plugin**, imported as `import { LiveObjects } from 'ably/liveobjects'`
and passed to the Realtime constructor via `plugins: { LiveObjects }`. Because the session
receives the client by injection, AIT cannot enable the plugin on the user's behalf —
`channel.object` throws a "missing plugin" error if it is absent. This is a
documentation concern (see Docs below), not something AIT can fix in code.

## Design

### 1. A single canonical mode resolver (shared by core + React)

Add a pure helper, alongside the existing agent helpers in `src/core/agent.ts` (or a new
`src/core/channel-options.ts` if cleaner), that is the **single source of truth** for the
channel modes AIT requests. Both the session `channels.get` calls and the React provider
call it, so they always agree.

```ts
/** The modes AIT always needs — byte-for-byte the server's MODE_DEFAULT, so
 *  enabling explicit modes for objects changes nothing else about behaviour. */
const AIT_BASE_MODES: Ably.ChannelMode[] = [
  'PUBLISH',
  'SUBSCRIBE',
  'PRESENCE',
  'PRESENCE_SUBSCRIBE',
  'ANNOTATION_PUBLISH',
];

/**
 * Resolve the channel modes to request. Returns `undefined` when no extra modes
 * are asked for — preserving today's behaviour of sending no mode flags and
 * letting the server apply MODE_DEFAULT. When the caller opts into extra modes
 * (e.g. object modes), returns the base set unioned with them, de-duplicated and
 * in a fixed canonical order so repeated `setOptions` calls compare equal.
 */
export const resolveChannelModes = (extraModes?: Ably.ChannelMode[]): Ably.ChannelMode[] | undefined => {
  /* union + dedupe + canonical sort */
};
```

Key properties:

- **Opt-in.** With no extra modes, returns `undefined` → AIT sets no `modes` (current
  behaviour). We do not force explicit modes on every attachment.
- **Base set == `MODE_DEFAULT`.** Turning on objects adds object modes and nothing else
  changes — in particular `annotation_publish` is preserved.
- **Canonical order + dedupe.** Guarantees `arrEquals` treats the session's and the
  provider's modes as identical, so no spurious reattach.

### 2. New session option for specifying modes

Add to both `ClientSessionOptions` (`src/core/transport/types/client.ts:16`) and
`AgentSessionOptions` (`src/core/transport/types/agent.ts:16`):

```ts
/**
 * Extra Ably channel modes to request on the session's channel, on top of the
 * modes AI Transport always needs. Pass `['OBJECT_SUBSCRIBE', 'OBJECT_PUBLISH']`
 * to use LiveObjects via {@link ClientSession.objects}. Omit to attach with the
 * default mode set. Requires the connection's token/key capability to permit the
 * requested operations.
 */
channelModes?: Ably.ChannelMode[];
```

> **Decided: explicit `channelModes: Ably.ChannelMode[]` array.** More general than a
> narrow boolean and future-proofs other modes; the base-set union already removes the
> main footgun (you cannot accidentally drop AIT's required modes). Optionally re-export an
> `OBJECT_MODES` constant for ergonomics.

Wire it into the two `channels.get` calls:

- `client-session.ts:141` — merge `resolveChannelModes(options.channelModes)` into the
  options returned by `registerAgent(...)`.
- `agent-session.ts:394-397` — same, merged alongside the existing `params.rewind`.

### 3. The object pass-through accessor

Mirror `presence` exactly. On the interfaces and `Default*` classes:

```ts
// src/core/transport/types/client.ts — ClientSession (and the AgentSession equivalent)
import type * as AblyObjects from 'ably/liveobjects'; // also pulls in the channel.object augmentation

/**
 * The Ably LiveObjects entry point for this session's channel. Use it to read
 * and mutate shared objects (LiveMap/LiveCounter) on the same channel the session
 * uses. Requires (a) the `LiveObjects` plugin on the Realtime client and (b) the
 * object channel modes (see {@link ClientSessionOptions.channelModes}); otherwise
 * accessing it / operating on it throws.
 */
readonly object: AblyObjects.RealtimeObject;
```

```ts
// DefaultClientSession (and DefaultAgentSession)
// Spec: AIT-CT2x
get object(): AblyObjects.RealtimeObject {
  return this._channel.object;
}
```

And the skipped-session stub in `src/react/use-client-session.ts` (mirroring the
`presence` stub):

```ts
get object(): AblyObjects.RealtimeObject {
  throw new Ably.ErrorInfo('unable to access object; hook is skipped', ErrorCode.InvalidArgument, 400);
}
```

Notes:

- The getter simply returns `this._channel.object`; if the plugin is missing, ably-js's
  own descriptive `ErrorInfo` propagates. No extra wrapping needed.
- Importing from `ably/liveobjects` brings in the module augmentation that types
  `channel.object`, so no cast is required (satisfies TYPES.md). Import as a namespace per
  project convention.
- The accessor is named `object` (singular) to match ably-js's `channel.object`.

### 4. React `<ChannelProvider>` plumbing

In `client-session-provider.tsx`, extend the memoised `channelOptions` (currently
`{ params: { agent } }`, line 115-118) to include the resolved modes, using the same
resolver so the session and provider agree:

```ts
const channelOptions = useMemo<Ably.ChannelOptions>(
  () => ({
    params: { agent: channelAgent(sessionOptions.codec) },
    modes: resolveChannelModes(sessionOptions.channelModes),
  }),
  [sessionOptions.codec, sessionOptions.channelModes],
);
```

Because `channelModes` is already part of `ClientSessionOptions`, it is already a prop on
`ClientSessionProviderProps` (which `Omit`s only `client`) — no new prop needed.

Ordering is safe: `createClientSession` runs during render and creates the channel with
the modes first; `<ChannelProvider>`'s `useLayoutEffect` then calls `setOptions` via
`channelOptionsForReactHooks` (which spreads `...options`, preserving `modes`, and appends
the agent param). Since both produce the identical modes array, `_shouldReattachToSetOptions`
returns false — no reattach, no throw. `channelModes` should be referentially stable across
renders (document this, or normalise it inside the resolver) to avoid re-running the effect.

### 5. Capability / demo

The connection's token or key capability must permit object operations, otherwise the
granted modes will exclude them (`requested ∩ capability`). The demo currently scopes its
token capability to the channel namespace (commit `1891c62`) — it will need
`object-subscribe` / `object-publish` capability added, and the demo client constructed
with `plugins: { LiveObjects }`, for any demo that exercises objects.

## Docs

- Document that using `session.objects` requires constructing the Realtime client with
  `plugins: { LiveObjects }` from `ably/liveobjects`, and passing
  `channelModes: ['OBJECT_SUBSCRIBE', 'OBJECT_PUBLISH']` (or the exported constant).
- Document the capability requirement.
- Note that there are no first-party React hooks for LiveObjects (see Out of scope).

## Testing

Match the coverage the presence pass-through already has in this repo: presence is covered
by **unit tests only** (`test/core/transport/client-session.test.ts`,
`agent-session.test.ts`) with **no** dedicated integration test. So the object
pass-through is unit-only too — no new integration test. Unit coverage:

- `resolveChannelModes` — union/dedupe/canonical-order; `undefined` with no extra modes.
- Both sessions pass the resolved modes to `channels.get` (mock channel records options).
- `session.object` getter returns the mock channel's `object`; skipped-session stub throws.
- React provider passes matching modes to `<ChannelProvider>` and does not trigger a
  reattach when session + provider modes agree (jsdom).

## Out of scope

- **First-party object React hooks.** `ably/react` exports no object hooks
  (`useObjects`/`useLiveMap`/`useLiveCounter` do not exist — confirmed in
  `ably-js` `src/platform/react-hooks/src/index.ts`). Unlike presence, where `usePresence`
  already existed and the `<ChannelProvider>` wrapper made it work, there is nothing
  upstream to plumb here. Authoring AIT's own object hooks is a separate, larger design and
  is not part of this work. Consumers use `session.objects` imperatively (or build their
  own hook) for now.

## Work breakdown

1. Add `resolveChannelModes` + `AIT_BASE_MODES` (and optional exported `OBJECT_MODES`
   constant) in core. Unit tests: union/dedupe/canonical-order, `undefined` when no extra
   modes.
2. Add `channelModes?` to `ClientSessionOptions` and `AgentSessionOptions` with JSDoc.
3. Wire modes into `client-session.ts:141` and `agent-session.ts:394-397`. Unit tests
   assert the resolved modes reach `channels.get`.
4. Add the `object` accessor to `ClientSession`/`AgentSession` interfaces, both
   `Default*` classes, and the skipped-session stub. Unit tests: getter returns
   `channel.object`; stub throws.
5. Thread `channelModes` through `client-session-provider.tsx`'s `channelOptions`. Unit
   test (jsdom): provider passes matching modes to `<ChannelProvider>` and no reattach is
   triggered when session + provider modes agree.
6. Export the new option types / constants from the relevant `index.ts` files.
7. Docs: plugin requirement, capability requirement, `channelModes` usage, no-hooks note.
   Update the demo's token capability + client plugins if a demo exercises objects.
8. Add `AIT-CT2x` / `AIT-ST2x` spec points for the objects accessor and `channelModes`
   (the `specification` submodule is currently not checked out — init it before editing).
9. Bump the ably-js peer dependency floor to `>= 2.20.0` (LiveObjects GA) — verify the
   current floor; the repo already runs 2.22.1.
10. Independent subagent review against this doc and `.claude/rules/` before presenting.

## Decisions

1. **Mode API shape** — explicit `channelModes: Ably.ChannelMode[]` array (optionally with
   an exported `OBJECT_MODES` constant for ergonomics).
2. **Accessor name** — `session.object` (singular), matching ably-js's `channel.object`.
3. **Test depth** — unit tests only, matching the presence pass-through; no new
   integration test.
