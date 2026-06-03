# Transport sub-components

The client and agent sessions are composed from several focused sub-components. Each handles one concern: managing run lifecycle, piping streams through encoders, or publishing cancel signals.

Per-run output streaming is **not** a core concern. The core client session surfaces every decoded run output on the [conversation tree](conversation-tree.md)'s `output` event — keyed by `runId` — and treats all runs identically regardless of who started them. The `ReadableStream` that Vercel's `useChat()` consumes is built in the Vercel layer by the [chat transport](chat-transport.md), which subscribes to those tree events for a single run. See [Message lifecycle](message-lifecycle.md#how-run-outputs-surface) for the full picture.

## RunManager

`src/core/transport/run-manager.ts` - server-side only.

The run manager tracks active runs and publishes [run lifecycle events](wire-protocol.md#lifecycle-events) (`ai-run-start`, `ai-run-suspend`, `ai-run-end`) on the Ably channel.

### Operations

| Method                                                                   | What it does                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `startRun(runId, clientId?, controller?, metadata?)`                     | Registers the run, publishes `ai-run-start`, returns an `AbortSignal`. `metadata` optionally stamps `parent`, `forkOf`, `invocationId`, `inputClientId` (→ `input-client-id`), and a `continuation` flag (→ `run-continue: "true"`) on the lifecycle event headers |
| `suspendRun(runId, invocationId?, inputClientId?, inputCodecMessageId?)` | Publishes `ai-run-suspend` (run paused awaiting input) and drops the run from the active set — a cancel during suspension is a no-op; the resuming invocation re-registers the run                                                                                 |
| `endRun(runId, reason, invocationId?, inputClientId?)`                   | Publishes `ai-run-end` with the reason (and `invocationId` / `inputClientId` if provided), removes the run                                                                                                                                                         |
| `cancel(runId)`                                                          | Fires the run's `AbortController.abort()` immediately                                                                                                                                                                                                              |
| `getSignal(runId)`                                                       | Returns the `AbortSignal` for a run                                                                                                                                                                                                                                |
| `getClientId(runId)`                                                     | Returns the clientId that owns a run                                                                                                                                                                                                                               |
| `getActiveRunIds()`                                                      | Returns all active run IDs                                                                                                                                                                                                                                         |
| `close()`                                                                | Cancels all active runs and clears state                                                                                                                                                                                                                           |

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

1. Reads `run-id` from the message headers — the protocol's single cancel target. Messages missing this header are dropped with a warn-level log.
2. Looks up the registered run by id. If nothing matches, the cancel is a no-op.
3. Calls the run's `onCancel` hook (if provided) — the hook can return `false` to reject the cancel.
4. If allowed, fires `controller.abort()` on the run's AbortController.

Each `ai-cancel` event targets exactly one run, so cancel routing is one lookup deep. Clients that want to stop multiple runs publish one `ai-cancel` per runId.

## buildTransportHeaders

`src/core/transport/headers.ts` - used by both client and server.

A single function that builds the standard [transport header set](wire-protocol.md#transport-headers) for a message. Used by the agent session's `addMessages()` and `pipe()`, and by the client session for optimistic message stamping.

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
//     'role': 'assistant', 'run-id': 'run-1',
//     'codec-message-id': 'msg-2', 'run-client-id': 'user-1',
//     'parent': 'msg-1', 'fork-of': 'msg-0',
//     'invocation-id': 'inv-1', 'input-client-id': 'user-2',
//     'event-id': 'e-1',
//   }
```

Optional fields are omitted from the result entirely when undefined, not stamped as empty strings. The two `*ClientId` fields (`runClientId`, `inputClientId`) treat the empty string `''` as a present value and still stamp the header — so anonymous publishers surface as an explicit empty string rather than vanishing. Other optional fields (`parent`, `forkOf`, `invocationId`, `inputEventId`, `runContinue`) omit on any falsy value. See [Branching headers](wire-protocol.md#branching-headers) for how `parent` and `forkOf` shape the conversation tree, [Run.pipe parent resolution](wire-protocol.md#how-parent-is-resolved) for the default-parent rules, and [Client identity](wire-protocol.md#client-identity) for the two `clientId` tiers.

See [Client session](client-session.md) and [Agent session](agent-session.md) for how these sub-components are composed into the full session implementations. See [Wire protocol](wire-protocol.md) for the full header and event specification. See [Encoder](encoder.md) for how the encoder writes through the channel. See [Decoder](decoder.md) for how decoded events are produced for routing. See [Headers](headers.md) for the domain header reader/writer utilities.
