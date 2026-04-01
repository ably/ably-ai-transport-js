# Error handling: outstanding questions

## What we've done so far

- Added `channel.on()` listener in ClientTransport that detects continuity-breaking state changes (FAILED, SUSPENDED, DETACHED, UPDATE with `resumed: false`).
- Added `errorAllStreams()` to StreamRouter — calls `controller.error()` on all active streams.
- Uses `_hasAttachedOnce` flag (borrowed from ably-chat-js) to distinguish initial attach from discontinuity.
- On continuity loss, emit synthetic turn-end events (reason: `'error'`) for all active turns (own and observer) to keep `on('turn')` consumers in sync.
- On continuity loss, clean up all per-turn state (`_turnObservers`, `_turnClientIds`, `_turnMsgIds`, `_ownMsgIds`, `_ownTurnIds`).

## Late-arriving messages after discontinuity

After we clean up per-turn state, late messages may still arrive on the channel for turns we've already invalidated. Currently these are handled incorrectly:

- **Turn-start**: Re-registers the turn in `_turnClientIds` as if it's new.
- **Turn-end**: Mostly harmless (the deletes are no-ops for missing entries), but emits a `'turn'` event for a turn the consumer has already been told is dead.
- **Codec events**: `_router.route()` returns false (no stream), `_ownTurnIds.has()` is false, so events fall through to the observer path — accumulating events as if this were someone else's turn. This is wrong.
- **`_updateTurnObserverHeaders`**: Creates a new observer entry, re-establishing state for an invalidated turn.

A possible approach: track the set of turn IDs that were invalidated by discontinuity and ignore late messages for those specific turns, without poisoning the transport for new turns.

## send() and the attach promise

`send()` awaits `_attachPromise` before proceeding. This promise comes from `channel.subscribe(callback)`, which implicitly attaches the channel (RTL7g). The guarantee `send()` expects is: by the time the await resolves, the subscription is active and the channel is attached, so when the server publishes response messages they will be delivered to our listener.

`_attachPromise` resolves once on the initial attach and stays resolved forever. It doesn't re-await on re-attach. This means:

- **After FAILED/DETACHED**: `_attachPromise` is already resolved (from the initial successful attach). `send()` proceeds, creates a stream, fires the HTTP POST. But the channel is no longer delivering messages, so the stream will never receive anything.
- **After SUSPENDED → re-attach**: Same — the promise resolved long ago. The channel may or may not be healthy again by the time `send()` runs. If it has re-attached with `resumed: false`, there was a gap, and we can't know whether any messages published during the gap (including response messages for this new turn) were lost.
- **After discontinuity (UPDATE with `resumed: false`)**: The channel is attached and the subscription is active, but messages were lost during the gap. A new `send()` would probably work — the turn hasn't started yet so there's no gap in *its* messages. But the transport's existing state (conversation tree, message history) may be inconsistent because of the gap in prior turns.

We need some mechanism for `send()` to know the transport is currently unhealthy. Options:

- Check `channel.state` directly at the top of `send()`.
- Track continuity loss with a flag and check it in `send()`.
- Rely on the POST failing or the stream being errored shortly after by the channel state listener (but this is racy — the listener may have already fired before `send()` was called, and the new stream wouldn't be in `errorAllStreams`'s set).

Note that `decodeHistory()` also interacts with attach — it calls `channel.attach()` and then `channel.history({ untilAttach: true })` to get gapless continuity between historical and live messages. After a re-attach, `untilAttach` is relative to the new attach serial, which could potentially be used for recovery (reload history to fill the gap). But that's a future "smarter than SSE" concern.

## Open questions

1. **Does the server transport need the same treatment?** It only subscribes to cancel messages. A missed cancel is less critical (the server-side turn just won't be cancelled), but the consumer might still want to know the channel is unhealthy.

2. **Should we try to be smarter than SSE for recoverable cases?** SUSPENDED may recover (Ably will try to re-attach). We currently treat it the same as FAILED. Is that the right call, or should we allow the possibility of surviving a transient disconnection in a future iteration?

## Transport as a state machine — considered and deferred

We explored making ClientTransport an explicit state machine (like Ably channels or chat rooms) with states like INITIALIZED, READY, FAILED, CLOSED. A commit exists on a separate branch (`b162b0f`) replacing the `_closed` boolean with a `ClientTransportState` enum as a first step.

We decided this isn't on the critical path for error handling because:

- A permanent FAILED state is too aggressive — it would prevent `send()` from working even after the channel recovers, which is worse than SSE.
- The problems we're solving (error streams, clean up turn state, emit turn-end events, handle late arrivals) are per-turn concerns, not transport-level state concerns.
- The transport isn't "failed" after discontinuity — it can still be used for new turns.

The enum replacement is still a clean improvement over the boolean and could be adopted independently. Further ideas (discriminated unions for per-state data, an INITIALIZED state) remain viable but are not needed for the current work.
