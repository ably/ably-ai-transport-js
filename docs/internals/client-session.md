# Client session

The client session (`src/core/transport/client-session.ts`) manages the full client-side conversation lifecycle over a single Ably channel. It composes a [stream router](transport-components.md#streamrouter), [conversation tree](conversation-tree.md), and codec [decoder](decoder.md) to handle receiving streamed responses and managing conversation state. Write operations (`sendMessage`, `sendInput`, `regenerate`, `edit`) live on the View, which delegates to the session's internal send machinery.

The client publishes user messages directly to the channel via the shared codec encoder. It does **not** send HTTP — the core session is a pure Ably-channel transport. Waking an agent is the application's concern: it POSTs `run.toInvocation().toJSON()` to its own endpoint if and when it wants one woken (the Vercel [chat transport](chat-transport.md) does this automatically for `useChat` parity). The agent correlates the input event by the `invocation-id` header (channel rewind + live subscribe) and publishes [run lifecycle events](wire-protocol.md#lifecycle-events) plus assistant chunks. The channel is the durable session record — agents that weren't running at publish time can resume by reading channel rewind.

## Composition

```
DefaultClientSession
├── Tree                   - Run-keyed conversation forest; owns per-Run TProjection via codec.fold
├── View                   - wraps tree with pagination, selection, 'update' events, and write ops
├── StreamRouter           - maps run events to per-run ReadableStreams
├── Decoder                - decodes inbound Ably messages to codec events
├── EventEmitter           - typed event bus for error events
└── per-run send state     - _ownRunIds, _ownMsgIds, _runMsgIds (relay detection + cancel routing)
```

The Tree is keyed by `runId` and owns the per-Run codec projection. Inbound events flow directly into `tree.applyMessage()`, which folds them into the Run's projection. The session keeps only the bookkeeping it needs locally: `_ownRunIds`, `_ownMsgIds`, `_runMsgIds`, and pending run-start trackers.

All sub-components are created in the constructor and share a single Ably channel. Construction is synchronous and does no channel I/O. Callers must `await session.connect()` before any send or cancel call; otherwise those methods throw `InvalidArgument`. `connect()` subscribes to the channel before attach ([RTL7g](https://sdk.ably.com/builds/ably/specification/main/features/#RTL7g)) to guarantee no messages are missed, and is idempotent - a second call returns the same in-flight promise.

## Send flow

`view.sendMessage()` / `view.sendInput()` is the primary entry point for starting a new run. It delegates to the session's internal `_internalSend` (exposed to views via a `SendDelegate`). The send flow:

1. **Generate identifiers** — a fresh `runId`, a fresh `invocationId`, and per-message `codecMessageId`s and `inputEventId`s (all `crypto.randomUUID()`).
2. **Auto-compute parent** — the View pre-computes `parentCodecMessageId` from the visible branch's tail message and passes it to the delegate. When neither `options.parent` nor `options.forkOf` is set, the delegate uses `parentCodecMessageId` as the auto-parent.
3. **Optimistic insert** — for each `user-message` event, the session builds transport headers (`role: "user"`, `run-id`, `invocation-id`, `codec-message-id`, parent, `event-id`) and calls `tree.applyMessage({ inputs: [event], outputs: [] }, headers, undefined)`. The user message itself does not carry `input-client-id` — the wire publisher's Ably `clientId` already conveys that. The Tree creates the Run on first message arrival, folds the event into the Run's projection, and emits `update`. This makes the optimistic state visible to the view before the publish ack lands.
4. **Create stream** — the [stream router](transport-components.md#streamrouter) creates a `ReadableStream` bound to `(runId, invocationId)`. Events from a different invocation under the same `runId` are dropped.
5. **Publish on the channel** — the session's shared encoder publishes each event via `encoder.publish(event, ...)`. Capability errors (Ably 401/403) are translated to `MissingPublishCapability` and reject `send()` before exposing the stream.
6. **Return `ActiveRun`** — `send()` resolves as soon as the channel publish (step 5) completes. The core sends no HTTP. The caller receives `{ stream, started, runId, invocationId, inputEventId, cancel(), optimisticCodecMessageIds, toInvocation() }`.
7. **Observe run-start (optional)** — `ActiveRun.started` is a promise that resolves when the agent's `ai-run-start` for this send is observed, and rejects only if the session is closed first. There is no deadline — callers who want to bound the wait race `started` against their own timeout. Internally, `started` is backed by a pending-run-start tracker keyed by the triggering input's `codec-message-id` — the agent echoes it back on `run-start` as `input-codec-message-id`, so for any send carrying input the match does not depend on a client-minted `run-id`/`invocation-id`. The lone exception is an empty-input continuation, which publishes no input and so has no such id — it keys by the reused `runId` instead. The run-start handler resolves it, `close()` rejects it. A publish failure (step 5) drops the tracker.

After `send()` returns, the application decides whether to wake an agent. `ActiveRun.toInvocation()` builds the pointer — `runId`, `invocationId`, `inputEventId`, and the channel name as `sessionName` — and the canonical pattern is `await fetch(endpoint, { body: JSON.stringify(run.toInvocation().toJSON()) })`. The agent rebuilds it with `Invocation.fromJSON` and reads the conversation from the channel; the pointer carries only identifiers. The Vercel [chat transport](chat-transport.md) issues this POST itself so `useChat` stays request-driven.

`regenerate()` runs through the same flow as a regular send, with one carve-out: step 3 (optimistic tree-upsert) is skipped because the codec's `ait-regenerate` event decodes to zero TMessages. The wire still publishes — its `msg-regenerate` and `parent` headers carry the routing metadata; the agent's input-event lookup matches it by `event-id`. The Tree creates the new Run when `ai-run-start` arrives under the new runId, populating `regeneratesMsgId` from the lifecycle event's `regenerates` field.

### Multi-message chaining

When `sendMessage()` receives multiple messages, it chains them into a linear thread: each message after the first uses the previous message's `msg-id` as its `parent`. This produces a connected sequence rather than siblings at the same fork point.

## Optimistic reconciliation

When the server relays user messages back onto the channel, the client receives them like any other message. `applyMessage` routes the relay to the existing optimistic Run — by `run-id`, or by the `_codecMessageIdToRunId` index when the relay's `run-id` differs from the one the optimistic insert used — rather than creating a duplicate.

On relay, the Run's `startSerial` is promoted from `undefined` to the server-assigned [serial](glossary.md#serial-ably), which triggers a re-sort in `_sortedRuns` - the optimistic Run (sorted last) moves to its correct serial-order position.

## Message routing

The channel subscription handler (`_handleMessage`) processes every inbound Ably message:

### Run lifecycle events

- **`ai-run-start`** — `tree.applyRunLifecycle({type: 'ai-run-start', runId, clientId, invocationId, serial, parent, forkOf, isContinuation?})` creates or activates the Run, registers it as active, emits a `run` event. The channel serial rides on the event (`parseRunLifecycle` stamps it), so there is no separate serial argument.
- **`ai-run-end`** — close the stream router entry (unless `reason === 'suspended'`), clean up `_ownRunIds`/`_ownMsgIds`/`_runMsgIds`, then `tree.applyRunLifecycle({type: 'ai-run-end', runId, clientId, invocationId, serial, reason})` updates the RunNode's `status` and `endSerial` (from the event's serial), deregisters from active tracking, emits a `run` event.

### Codec-decoded messages

All other messages pass through the codec decoder. The session:

1. Calls `decoder.decode(rawMessage)` to get `{ inputs, outputs }` split by wire direction.
2. Calls `tree.applyMessage({ inputs, outputs }, headers, serial)` — the Tree folds events into the owning Run's projection and emits an `output` event with the message's outputs.
3. Per-event, calls `router.route(runId, invocationId, event)` to enqueue to the active stream (if any). The router drops events whose invocation-id doesn't match the stream's bound invocation.
4. Calls `tree.emitAblyMessage(rawMsg)` so subscribers to `'ably-message'` can observe the raw wire.

There is no separate observer-state map. The Tree's per-Run projection is the single source of truth for every Run (own or observer); the View extracts messages on demand via `codec.getMessages(run.projection)`.

## Regenerate and edit

`view.regenerate(messageId)` and `view.edit(messageId, newMessages)` are convenience methods that delegate to the send flow with computed branching metadata:

- **`forkOf`** - the message ID of the message being replaced
- **`parent`** - the parent of the forked message in the tree
- **`history`** - messages truncated before the fork point (the LLM doesn't see the response being replaced)

The conversation tree handles the fork: the new message becomes a sibling of the original, and branch selection determines which path `flattenNodes()` returns. See [Conversation tree](conversation-tree.md) for the branching mechanics.

## Cancel

`cancel(runId)` publishes an `ai-cancel` message carrying `run-id` and closes the local stream for that run. See [Transport components: cancel routing](transport-components.md#cancel-routing-agent-session) for how the agent session processes cancel messages.

Closing the stream router entry does **not** clear the observer state - late server events (e.g. abort status, final metadata) arriving before `run-end` are still accumulated into the conversation tree.

## History

`view.loadOlder()` loads older Runs from the Ably channel using [`untilAttach`](glossary.md#untilattach-ably) for gapless continuity with the live subscription. Pages are decoded through the codec, lifecycle events are dispatched to `tree.applyRunLifecycle`, and per-Run events fold into the owning Run's projection via `tree.applyMessage`.

The view paginates at **Run** granularity. `loadOlder(limit)` reveals up to `limit` Runs per call. A single channel page may materialise more than `limit` Runs, so the view applies a **withholding** buffer: the newest `limit` Runs are released immediately, and the rest are held back for subsequent `loadOlder()` calls. This prevents the UI from jumping to show many Runs at once and gives the consumer a predictable Run-unit page size regardless of how channel pages happen to align with Run boundaries.

## Stream delivery guarantee

With the Vercel AI SDK's default SSE transport, a broken connection surfaces immediately — `useChat` transitions to `status: 'error'` and the application can respond. The Ably transport should provide at least the same guarantee: after the run's stream is being consumed, either all events for the run are received in order through to run-end, or the stream errors so the consumer knows delivery was interrupted.

Cases where the guarantee would be violated and the stream is errored:

- **Channel continuity loss** - the channel entered a state where message delivery can no longer be assured (FAILED, SUSPENDED, DETACHED, or re-attached with `resumed: false`). Events may have been lost. The stream is errored with `ChannelContinuityLost`. The transport does not clean up per-run state or emit synthetic run-end events — events may still arrive later.
- **Unhealthy channel at send time** - `send()` is called when the channel is not ATTACHED or ATTACHING. The send is rejected with `ChannelNotReady`.

A failed agent-invocation POST is **not** handled here — the core never sends HTTP. Whoever issues the invocation owns that failure: the Vercel [chat transport](chat-transport.md) errors the `useChat`-facing stream when its POST fails (with `SessionSendFailed`), while a generic app that POSTs `run.toInvocation()` itself handles the rejected `fetch` directly.

## Close

`close()` tears down all session state:

1. Optionally publishes a cancel message (if `options.cancel` is set)
2. Unsubscribes from the channel
3. Closes all active stream router entries
4. Clears event handlers, `_ownRunIds`, `_ownMsgIds`, `_runMsgIds`, and pending run-start trackers; closes the encoder

After close, all methods that create runs throw `SessionClosed`. Event subscriptions return no-op unsubscribe functions. The Tree retains its data (so any in-flight observer rendering continues to read the last-known state) — callers that need a fresh Tree must create a new session.

## Events

| Event                    | Payload                | When                                                                                                                         |
| ------------------------ | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `update` (on view)       | (none)                 | View state changed - call `view.flattenNodes()` for current state                                                            |
| `run` (on tree or view)  | `RunLifecycleEvent`    | Run started or ended (includes runId, clientId, invocationId, serial, reason)                                                |
| `output` (on tree)       | `OutputEvent<TOutput>` | Decoded agent outputs folded into a Run - runId, codecMessageId, serial, and the output events (empty for inputs-only folds) |
| `error`                  | `Ably.ErrorInfo`       | Non-fatal error (channel publish failure, channel continuity loss, subscription error). These also error active run streams  |
| `ably-message` (on tree) | (none)                 | Raw Ably message added - subscribe via `tree.on('ably-message')`                                                             |

See [Sessions concept](../concepts/sessions.md) for the public API perspective. See [Transport components](transport-components.md) for the sub-component internals. See [Message lifecycle](message-lifecycle.md) for the end-to-end message flow.
