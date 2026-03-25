# Transport sub-components

The client and server transports are composed from several focused sub-components. Each handles one concern: routing events to streams, managing turn lifecycle, piping streams through encoders, or publishing cancel signals.

## StreamRouter

`src/core/transport/stream-router.ts` - client-side only.

The stream router maps decoded events to per-turn `ReadableStream` instances for [own turns](glossary.md#own-turn-vs-observer-turn) - turns this client initiated via `send()`, `regenerate()`, or `edit()`. When the client starts a turn, the router creates a new stream. As decoded events arrive from the channel subscription, the transport routes them through the router to the correct stream.

The stream is **not the only destination** for own-turn events. After routing an event to the stream, the transport also feeds it to a per-turn [accumulator](codec-interface.md#accumulator) that builds complete domain messages for the [conversation tree](conversation-tree.md). This means `getMessages()` updates on every event regardless of who started the turn. The stream exists primarily as an integration seam for framework adapters (e.g. Vercel's `useChat` expects a `ReadableStream`); most application code consumes accumulated messages instead.

Events from [observer turns](glossary.md#own-turn-vs-observer-turn) (other clients' turns) go to the accumulator only - the router has no stream for them because no caller on this client initiated the turn. See [Message lifecycle](message-lifecycle.md#own-turns-vs-observer-turns) for the full routing picture.

### Operations

| Method                 | What it does                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `createStream(turnId)` | Creates a `ReadableStream`, captures the controller synchronously, returns the stream     |
| `route(turnId, event)` | Enqueues the event on the turn's stream. If the event is terminal, auto-closes the stream |
| `closeStream(turnId)`  | Closes the controller and removes the entry                                               |
| `has(turnId)`          | Checks whether a turn has an active stream                                                |

### Terminal detection

The router accepts an [`isTerminal`](codec-interface.md#the-codec-interface) predicate at construction (provided by the codec). When a routed event matches the predicate, the router automatically closes the stream after enqueueing the event. This means the stream consumer sees the [terminal event](glossary.md#terminal-event) as the last item before the stream ends.

### Controller capture

`ReadableStream`'s `start()` callback runs synchronously per the WHATWG spec. The router exploits this to capture the controller in the same tick as stream creation - no async gap where events could be lost.

## TurnManager

`src/core/transport/turn-manager.ts` - server-side only.

The turn manager tracks active turns and publishes [turn lifecycle events](wire-protocol.md#lifecycle-events) (`x-ably-turn-start`, `x-ably-turn-end`) on the Ably channel.

### Operations

| Method                                      | What it does                                                                |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| `startTurn(turnId, clientId?, controller?)` | Registers the turn, publishes `x-ably-turn-start`, returns an `AbortSignal` |
| `endTurn(turnId, reason)`                   | Publishes `x-ably-turn-end` with the reason, removes the turn               |
| `abort(turnId)`                             | Fires the turn's `AbortController.abort()` immediately                      |
| `getSignal(turnId)`                         | Returns the `AbortSignal` for a turn                                        |
| `getClientId(turnId)`                       | Returns the clientId that owns a turn                                       |
| `getActiveTurnIds()`                        | Returns all active turn IDs                                                 |
| `close()`                                   | Aborts all active turns and clears state                                    |

### AbortController per turn

Each turn gets its own `AbortController`. The server transport can pass an external controller to `startTurn()` to share abort control with the cancel routing system. The signal is passed to the LLM call and to `pipeStream`, so cancellation propagates from the channel (cancel signal → abort controller → abort signal → stream reader stops → encoder aborts).

The turn manager publishes `x-ably-turn-end` **before** deleting local state. If the publish fails, the turn remains in the active set and can be retried or cleaned up.

## pipeStream

`src/core/transport/pipe-stream.ts` - server-side only.

A pure function that reads events from a `ReadableStream`, writes them through a [streaming encoder](codec-interface.md#encoder-architecture), and handles abort/error. No dependencies on turn state or transport internals.

### Flow

```
while true:
  race(reader.read(), abortPromise)
    → aborted?  call onAbort(), then encoder.abort('cancelled')
    → done?     call encoder.close()
    → value?    call encoder.appendEvent(value)
    → error?    call encoder.close() (best-effort), return 'error'
```

### Abort handling

The abort signal is converted to a promise and raced against `reader.read()`. The `.then(() => 'aborted')` pattern creates a tagged discriminant for `Promise.race` - this is one of the documented exceptions to the async/await rule (see `.claude/rules/PROMISES.md`).

When cancelled:

1. The `onAbort` callback fires (if provided) - the server can write final events before the stream closes (e.g. `[generation cancelled]`)
2. `encoder.abort('cancelled')` aborts all in-progress streams
3. The reader lock is released

### Error handling

When the stream throws or `appendEvent` fails, `pipeStream` catches the error and calls `encoder.close()` as a best-effort cleanup (the close itself may also fail if the channel is disconnected). The original error is preserved in the return value as `reason: 'error'`.

### Return value

Returns `{ reason }` where reason is `'complete'`, `'cancelled'`, or `'error'`. The server transport passes this to `turn.end()`.

## Cancel routing (server transport)

Cancel routing lives in the server transport (`src/core/transport/server-transport.ts`), not in a separate component.

The server transport subscribes to [`x-ably-cancel`](wire-protocol.md#lifecycle-events) events on channel construction. When a cancel message arrives, it:

1. Parses the cancel filter from [cancel headers](wire-protocol.md#transport-headers-x-ably) (`x-ably-cancel-turn-id`, `x-ably-cancel-own`, `x-ably-cancel-client-id`, `x-ably-cancel-all`)
2. Resolves which active turns match the filter
3. For each matched turn:
   - Calls the turn's `onCancel` hook (if provided) - the hook can return `false` to reject the cancel
   - If allowed, fires `controller.abort()` on the turn's AbortController

Throwing handlers don't prevent other turns from being cancelled - each turn's cancel is isolated in its own try/catch.

### Cancel filter resolution

| Header                    | Matches                                       |
| ------------------------- | --------------------------------------------- |
| `x-ably-cancel-turn-id`   | The specific turn                             |
| `x-ably-cancel-own`       | All turns whose clientId matches the sender   |
| `x-ably-cancel-client-id` | All turns belonging to the specified clientId |
| `x-ably-cancel-all`       | All active turns                              |

## buildTransportHeaders

`src/core/transport/headers.ts` - used by both client and server.

A single function that builds the standard [`x-ably-*` header set](wire-protocol.md#transport-headers-x-ably) for a message. Takes role, turnId, msgId, and optional [branching headers](wire-protocol.md#branching-headers) (parent, forkOf). Used by the server transport's `addMessages()` and `streamResponse()`, and by the client transport for optimistic message stamping.

```typescript
buildTransportHeaders({
  role: 'assistant',
  turnId: 'turn-1',
  msgId: 'msg-2',
  turnClientId: 'user-1',
  parent: 'msg-1',
});
// → { 'x-ably-role': 'assistant', 'x-ably-turn-id': 'turn-1', ... }
```

See [Client transport](client-transport.md) and [Server transport](server-transport.md) for how these sub-components are composed into the full transport implementations. See [Wire protocol](wire-protocol.md) for the full header and event specification. See [Encoder](encoder.md) for how the encoder writes through the channel. See [Decoder](decoder.md) for how decoded events are produced for routing. See [Headers](headers.md) for the domain header reader/writer utilities.
