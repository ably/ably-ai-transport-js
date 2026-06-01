# Transport sub-components

The client and agent sessions are composed from several focused sub-components. Each handles one concern: routing events to streams, managing run lifecycle, piping streams through encoders, or publishing cancel signals.

## StreamRouter

`src/core/transport/stream-router.ts` - client-side only.

The stream router maps decoded events to per-run `ReadableStream` instances for [own runs](glossary.md#own-run-vs-observer-run) - runs this client initiated via `send()`, `regenerate()`, or `edit()`. When the client starts a run, the router creates a new stream. As decoded events arrive from the channel subscription, the transport routes them through the router to the correct stream.

The stream is **not the only destination** for own-run events. After routing an event to the stream, the transport also feeds it to a per-run [accumulator](codec-interface.md#accumulator) that builds complete domain messages for the [conversation tree](conversation-tree.md). This means the view updates on every event regardless of who started the run. The stream exists primarily as an integration seam for framework adapters (e.g. Vercel's `useChat()` expects a `ReadableStream`); most application code consumes accumulated messages via the view instead.

Events from [observer runs](glossary.md#own-run-vs-observer-run) (other clients' runs) go to the accumulator only - the router has no stream for them because no caller on this client initiated the run. See [Message lifecycle](message-lifecycle.md#own-runs-vs-observer-runs) for the full routing picture.

### Operations

| Method                      | What it does                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| `createStream(runId)`       | Creates a `ReadableStream`, captures the controller synchronously, returns the stream    |
| `route(runId, event)`       | Enqueues the event on the run's stream. If the event is terminal, auto-closes the stream |
| `closeStream(runId)`        | Closes the controller and removes the entry                                              |
| `errorStream(runId, error)` | Errors the controller with the given `ErrorInfo` and removes the entry                   |
| `has(runId)`                | Checks whether a run has an active stream                                                |

### Terminal detection

The router accepts an [`isTerminal()`](codec-interface.md#the-codec-interface) predicate at construction (provided by the codec). When a routed event matches the predicate, the router automatically closes the stream after enqueueing the event. This means the stream consumer sees the [terminal event](glossary.md#terminal-event) as the last item before the stream ends.

### Controller capture

`ReadableStream`'s `start()` callback runs synchronously per the WHATWG spec. The router exploits this to capture the controller in the same tick as stream creation - no async gap where events could be lost.

## RunManager

`src/core/transport/run-manager.ts` - server-side only.

The run manager tracks active runs and publishes [run lifecycle events](wire-protocol.md#lifecycle-events) (`ai-run-start`, `ai-run-end`) on the Ably channel.

### Operations

| Method                                                 | What it does                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startRun(runId, clientId?, controller?, metadata?)`   | Registers the run, publishes `ai-run-start`, returns an `AbortSignal`. `metadata` optionally stamps `parent`, `forkOf`, `invocationId`, `inputClientId` (→ `x-ably-input-client-id`), and a `continuation` flag (→ `x-ably-run-continue: "true"`) on the lifecycle event headers |
| `endRun(runId, reason, invocationId?, inputClientId?)` | Publishes `ai-run-end` with the reason (and `invocationId` / `inputClientId` if provided), removes the run                                                                                                                                                                       |
| `cancel(runId)`                                        | Fires the run's `AbortController.abort()` immediately                                                                                                                                                                                                                            |
| `getSignal(runId)`                                     | Returns the `AbortSignal` for a run                                                                                                                                                                                                                                              |
| `getClientId(runId)`                                   | Returns the clientId that owns a run                                                                                                                                                                                                                                             |
| `getActiveRunIds()`                                    | Returns all active run IDs                                                                                                                                                                                                                                                       |
| `close()`                                              | Cancels all active runs and clears state                                                                                                                                                                                                                                         |

### AbortController per run

Each run gets its own `AbortController`. The agent session can pass an external controller to `startRun()` to share cancel control with the cancel routing system. The signal is passed to the LLM call and to `pipeStream`, so cancellation propagates from the channel (cancel signal → AbortController → AbortSignal → stream reader stops → encoder cancels its streams).

The run manager publishes `ai-run-end` **before** deleting local state. If the publish fails, the run remains in the active set and can be retried or cleaned up.

## pipeStream

`src/core/transport/pipe-stream.ts` - server-side only.

A pure function that reads events from a `ReadableStream`, writes them through a [streaming encoder](codec-interface.md#encoder-architecture), and handles cancel/error. No dependencies on run state or transport internals.

### Flow

```
while true:
  race(reader.read(), abortPromise)
    → cancelled?  call onCancelled(), then encoder.cancel('cancelled')
    → done?       call encoder.close()
    → value?      call encoder.publish(value)
    → error?      call encoder.close() (best-effort), return 'error'
```

### Cancel handling

The `AbortSignal` is converted to a promise (`abortPromise`) and raced against `reader.read()`. The `.then(() => 'cancelled')` pattern creates a tagged discriminant for `Promise.race` - this is one of the documented exceptions to the async/await rule (see `.claude/rules/PROMISES.md`).

When cancelled:

1. The `onCancelled` callback fires (if provided) - the server can write final events before the stream closes (e.g. `[generation cancelled]`)
2. `encoder.cancel('cancelled')` cancels all in-progress streams
3. The reader lock is released

### Error handling

When the stream throws or `appendEvent()` fails, `pipeStream` catches the error and calls `encoder.close()` as a best-effort cleanup (the close itself may also fail if the channel is disconnected). The original error is preserved in the return value as `reason: 'error'`.

### Return value

Returns `{ reason }` where reason is `'complete'`, `'cancelled'`, or `'error'`. The agent session passes this to `run.end()`.

## Cancel routing (agent session)

Cancel routing lives in the agent session (`src/core/transport/agent-session.ts`), not in a separate component.

The agent session subscribes to [`ai-cancel`](wire-protocol.md#lifecycle-events) events on channel construction. When a cancel message arrives, it:

1. Reads `x-ably-run-id` from the message headers — the protocol's single cancel target. Messages missing this header are dropped with a warn-level log.
2. Looks up the registered run by id. If nothing matches, the cancel is a no-op.
3. Calls the run's `onCancel` hook (if provided) — the hook can return `false` to reject the cancel.
4. If allowed, fires `controller.abort()` on the run's AbortController.

Each `ai-cancel` event targets exactly one run, so cancel routing is one lookup deep. Clients that want to stop multiple runs publish one `ai-cancel` per runId.

## buildTransportHeaders

`src/core/transport/headers.ts` - used by both client and server.

A single function that builds the standard [`x-ably-*` header set](wire-protocol.md#transport-headers-x-ably) for a message. Used by the agent session's `addMessages()` and `pipe()`, and by the client session for optimistic message stamping.

```typescript
buildTransportHeaders({
  role: 'assistant', // required - 'user' or 'assistant'
  runId: 'run-1', // required
  codecMessageId: 'msg-2', // required
  runClientId: 'user-1', // optional - run owner; omits header when undefined
  parent: 'msg-1', // optional - see Branching headers
  forkOf: 'msg-0', // optional - sibling marker for fork chains
  invocationId: 'inv-1', // optional - per-invocation correlator
  inputClientId: 'user-2', // optional - publisher clientId of the triggering input event (see Client identity)
  inputEventId: 'e-1', // optional - per-event correlator (client side)
});
// → {
//     'x-ably-role': 'assistant', 'x-ably-run-id': 'run-1',
//     'x-ably-codec-message-id': 'msg-2', 'x-ably-run-client-id': 'user-1',
//     'x-ably-parent': 'msg-1', 'x-ably-fork-of': 'msg-0',
//     'x-ably-invocation-id': 'inv-1', 'x-ably-input-client-id': 'user-2',
//     'x-ably-event-id': 'e-1',
//   }
```

Optional fields are omitted from the result entirely when undefined, not stamped as empty strings. The two `*ClientId` fields (`runClientId`, `inputClientId`) treat the empty string `''` as a present value and still stamp the header — so anonymous publishers surface as an explicit empty string rather than vanishing. Other optional fields (`parent`, `forkOf`, `invocationId`, `inputEventId`, `runContinue`) omit on any falsy value. See [Branching headers](wire-protocol.md#branching-headers) for how `parent` and `forkOf` shape the conversation tree, [Run.pipe parent resolution](wire-protocol.md#how-x-ably-parent-is-resolved) for the default-parent rules, and [Client identity](wire-protocol.md#client-identity) for the two `clientId` tiers.

See [Client session](client-session.md) and [Agent session](agent-session.md) for how these sub-components are composed into the full session implementations. See [Wire protocol](wire-protocol.md) for the full header and event specification. See [Encoder](encoder.md) for how the encoder writes through the channel. See [Decoder](decoder.md) for how decoded events are produced for routing. See [Headers](headers.md) for the domain header reader/writer utilities.
