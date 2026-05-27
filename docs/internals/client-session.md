# Client session

The client session (`src/core/transport/client-session.ts`) manages the full client-side conversation lifecycle over a single Ably channel. It composes a [stream router](transport-components.md#streamrouter), [conversation tree](conversation-tree.md), and codec [decoder](decoder.md)/[accumulator](codec-interface.md#accumulator) to handle receiving streamed responses and managing conversation state. Write operations (`send`, `regenerate`, `edit`) live on the View, which delegates to the session's internal send machinery.

The client publishes user messages directly to the channel via the shared codec encoder, and POSTs an HTTP invocation in parallel. The agent correlates the prompt by the `x-ably-invocation-id` header (channel rewind + live subscribe) and publishes [run lifecycle events](wire-protocol.md#lifecycle-events) plus assistant chunks. The channel is the durable session record — agents that weren't running at publish time can resume by reading channel rewind.

## Composition

```
DefaultClientSession
├── Tree       - branching message history
├── View       - wraps tree with pagination, selection, 'update' events, and write ops (send/regenerate/edit)
├── StreamRouter           - maps run events to per-run ReadableStreams
├── StreamDecoder          - decodes inbound Ably messages to events/messages
├── EventEmitter           - typed event bus for error events
└── per-run state maps    - observer headers, accumulators, relay detection
```

All sub-components are created in the constructor and share a single Ably channel. Construction is synchronous and does no channel I/O. Callers must `await session.connect()` before any send, cancel, or `waitForRun` call; otherwise those methods throw `InvalidArgument`. `connect()` subscribes to the channel before attach ([RTL7g](https://sdk.ably.com/builds/ably/specification/main/features/#RTL7g)) to guarantee no messages are missed, and is idempotent - a second call returns the same in-flight promise.

## Send flow

`view.send()` is the primary entry point for starting a new run. It delegates to the session's internal `_internalSend` (exposed to views via a `SendDelegate`). The send flow:

1. **Generate identifiers** — a fresh `runId`, a fresh `invocationId`, and per-message `codecMessageId`s (all `crypto.randomUUID()`).
2. **Auto-compute parent** — if no explicit `parent` or `forkOf` is provided, reads the last message in the [flattened tree](conversation-tree.md#flatten-producing-the-linear-path) to chain messages into a linear thread.
3. **Optimistic insert** — each user message is inserted into the conversation tree immediately with [transport headers](wire-protocol.md#transport-headers-x-ably) (`role: "user"`, `run-id`, `invocation-id`, `codec-message-id`, parent). The user message itself does not carry `x-ably-input-client-id` — the wire publisher's Ably `clientId` already conveys that. This makes the message visible to the view before the publish ack lands.
4. **Create stream** — the [stream router](transport-components.md#streamrouter) creates a `ReadableStream` bound to `(runId, invocationId)`. Events from a different invocation under the same `runId` are dropped.
5. **Publish on the channel** — the session's shared encoder publishes the user message(s) via `writeMessages`. Capability errors (Ably 401/403) are translated to `MissingPublishCapability` and reject `send()` before exposing the stream.
6. **POST in parallel** — the HTTP POST is fired in parallel with the publish. The body carries `runId`, `invocationId`, `history`, and `eventIds`. It does **not** carry a `clientId` or `messages` field — the prompt (and its publisher `clientId`) is on the channel, and the agent reads it from there.
7. **Wait for run-start** — `send()` awaits an `ai-run-start` event for the run+invocation, bounded by `runStartDeadlineMs` (default 30 000 ms). Deadline lapse rejects `send()` with `RunStartDeadlineExceeded`. POST failure also rejects.
8. **Return `ActiveRun`** — once run-start arrives, the caller receives `{ stream, runId, cancel() }`.

`regenerate()` and `update()` (which carry no user-message text) skip the encoder publish and the run-start wait — the agent receives the invocation via POST and runs without needing a channel-published prompt.

### Multi-message chaining

When `send()` receives multiple messages, it chains them into a linear thread: each message after the first uses the previous message's message ID as its `parent`. This produces a connected sequence rather than siblings at the same fork point.

## Optimistic reconciliation

When the server relays user messages back onto the channel, the client receives them like any other message. The transport detects own-message relays by matching the `x-ably-codec-message-id` against the set of optimistically inserted codec-message-ids (`_ownCodecMessageIds`).

On relay match, the transport upserts the message with the server-assigned [serial](glossary.md#serial-ably), which triggers [serial promotion](glossary.md#serial-promotion) in the conversation tree - the optimistic entry (null serial, sorted last) moves to its correct position in serial order.

## Message routing

The channel subscription handler (`_handleMessage`) processes every inbound Ably message:

### Run lifecycle events

- **`ai-run-start`** - records the run's clientId, emits a `run` event
- **`ai-run-end`** - closes the stream router entry, cleans up observer state and relay-detection state, emits a `run` event. When `x-ably-run-reason: error`, the client first reifies an `Ably.ErrorInfo` from `x-ably-error-code` / `x-ably-error-message`, routes it to the active stream, and emits `error` on the session before the regular teardown. `statusCode` is derived from the code (`Math.floor(code / 100)` for codes in `10000–59999`, else `500`)

### Codec-decoded messages

All other messages pass through the codec decoder. Each `DecoderOutput` is routed based on its `kind`:

- **`message` outputs** - user messages or discrete content. Upserted into the conversation tree (with relay detection for own messages)
- **`event` outputs** - streaming fragments. Routed by run ownership:

| Run type                                                       | Stream router    | Accumulator                  | Tree upsert    |
| -------------------------------------------------------------- | ---------------- | ---------------------------- | -------------- |
| [Own run](glossary.md#own-run-vs-observer-run) (active stream) | Enqueued         | Processed, snapshot upserted | On every event |
| Own run (stream closed)                                        | Skipped          | Skipped                      | No             |
| [Observer run](glossary.md#own-run-vs-observer-run)            | No stream exists | Processed, snapshot upserted | On every event |

### Observer accumulation

For both own and observer runs, the transport maintains a `RunObserverState` that tracks:

- **headers** - accumulated from every event in the run (later headers override earlier ones)
- **serial** - advances on every event, so the tree node always sorts after earlier messages in the run
- **accumulator** - a codec-provided [MessageAccumulator](codec-interface.md#accumulator) that builds complete domain messages from streaming events

On every event, the transport calls `accumulator.processOutputs()`, clones the latest message, and upserts it into the conversation tree. This is why the view updates in real-time during streaming - even for observer runs where no `ReadableStream` exists.

## Regenerate and edit

`view.regenerate(messageId)` and `view.edit(messageId, newMessages)` are convenience methods that delegate to the send flow with computed branching metadata:

- **`forkOf`** - the message ID of the message being replaced
- **`parent`** - the parent of the forked message in the tree
- **`history`** - messages truncated before the fork point (the LLM doesn't see the response being replaced)

The conversation tree handles the fork: the new message becomes a sibling of the original, and branch selection determines which path `flattenNodes()` returns. See [Conversation tree](conversation-tree.md) for the branching mechanics.

## Cancel

`cancel(runId)` publishes an `ai-cancel` message carrying `x-ably-run-id` and closes the local stream for that run. See [Transport components: cancel routing](transport-components.md#cancel-routing-agent-session) for how the agent session processes cancel messages.

Closing the stream router entry does **not** clear the observer state - late server events (e.g. cancel status, final metadata) arriving before `run-end` are still accumulated into the conversation tree.

## History

`view.loadOlder()` loads older messages from the Ably channel using [`untilAttach`](glossary.md#untilattach-ably) for gapless continuity with the live subscription. Pages are decoded through the codec and upserted into the conversation tree.

The view implements a **withholding** mechanism for pagination: newly loaded messages are initially hidden from `flattenNodes()`. The newest batch is released immediately, while older messages are buffered and released in subsequent `loadOlder()` calls. This prevents the UI from jumping to show hundreds of messages at once.

## Stream delivery guarantee

With the Vercel AI SDK's default SSE transport, a broken connection surfaces immediately — `useChat` transitions to `status: 'error'` and the application can respond. The Ably transport should provide at least the same guarantee: after `send()`, either all events for the run are received in order through to run-end, or the stream errors so the consumer knows delivery was interrupted.

Cases where the guarantee would be violated and the stream is errored:

- **HTTP POST failure** - the server never received the request, so no events will arrive. The stream is errored with `SessionSendFailed`.
- **Channel continuity loss** - the channel entered a state where message delivery can no longer be assured (FAILED, SUSPENDED, DETACHED, or re-attached with `resumed: false`). Events may have been lost. The stream is errored with `ChannelContinuityLost`. The transport does not clean up per-run state or emit synthetic run-end events — events may still arrive later.
- **Unhealthy channel at send time** - `send()` is called when the channel is not ATTACHED or ATTACHING. The send is rejected with `ChannelNotReady`.

## Close

`close()` tears down all session state:

1. Optionally publishes a cancel message (if `options.cancel` is set)
2. Unsubscribes from the channel
3. Closes all active stream router entries
4. Clears observer state, event handlers, relay detection state, and the Ably message log

After close, all methods that create runs throw `SessionClosed`. Event subscriptions return no-op unsubscribe functions.

## Events

| Event                    | Payload             | When                                                                                                                                                                                                                    |
| ------------------------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `update` (on view)       | (none)              | View state changed - call `view.flattenNodes()` for current state                                                                                                                                                       |
| `run` (on tree or view)  | `RunLifecycleEvent` | Run started or ended (includes runId, clientId, reason)                                                                                                                                                                 |
| `error`                  | `Ably.ErrorInfo`    | Non-fatal error (HTTP POST failure, channel continuity loss, subscription error, agent-reported mid-run failure via `ai-run-end` with `reason: error`). POST, channel, and agent failures also error active run streams |
| `ably-message` (on tree) | (none)              | Raw Ably message added - subscribe via `tree.on('ably-message')`                                                                                                                                                        |

See [Sessions concept](../concepts/sessions.md) for the public API perspective. See [Transport components](transport-components.md) for the sub-component internals. See [Message lifecycle](message-lifecycle.md) for the end-to-end message flow.
