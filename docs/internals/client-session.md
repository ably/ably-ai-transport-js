# Client session

The client session (`src/core/transport/client-session.ts`) manages the full client-side conversation lifecycle over a single Ably channel. It composes a [conversation tree](conversation-tree.md) and codec [decoder](decoder.md) to handle receiving streamed responses and managing conversation state. Write operations (`sendMessage`, `sendInput`, `regenerate`, `edit`) live on the View, which delegates to the session's internal send machinery.

The client publishes user messages directly to the channel via the shared codec encoder. It does **not** send HTTP — the core session is a pure Ably-channel transport. Waking an agent is the application's concern: it POSTs `run.toInvocation().toJSON()` to its own endpoint if and when it wants one woken (the Vercel [chat transport](chat-transport.md) does this automatically for `useChat` parity). The agent locates the triggering input event by its `event-id` header (channel rewind + live subscribe), mints the `invocation-id` itself (one per HTTP request), and publishes [run lifecycle events](wire-protocol.md#lifecycle-events) plus assistant chunks. The channel is the durable session record — agents that weren't running at publish time can resume by reading channel rewind.

## Composition

```
DefaultClientSession
├── Tree                   - node-keyed conversation forest; owns per-node TProjection via codec.fold
├── View                   - wraps tree with pagination, selection, 'update' events, and write ops
├── Decoder                - decodes inbound Ably messages to codec events
├── EventEmitter           - typed event bus for error events
└── pending run-start trackers - resolve ActiveRun.runId on the matching ai-run-start
```

The Tree keys each node by its primary key — `codec-message-id` for a user [input node](conversation-tree.md), the agent-minted `runId` for a reply run — and owns the per-node codec projection. Inbound events flow directly into `tree.applyMessage()`, which folds them into the owning node's projection and surfaces decoded outputs on the tree's `output` event. The session keeps only the bookkeeping it needs locally: pending run-start trackers keyed by the triggering input's `codec-message-id`.

All sub-components are created in the constructor and share a single Ably channel. Construction is synchronous and does no channel I/O. Callers must `await session.connect()` before any send or cancel call; otherwise those methods throw `InvalidArgument`. `connect()` subscribes to the channel before attach ([RTL7g](https://sdk.ably.com/builds/ably/specification/main/features/#RTL7g)) to guarantee no messages are missed, and is idempotent - a second call returns the same in-flight promise.

## Send flow

`view.sendMessage()` / `view.sendInput()` is the primary entry point for starting a new run. It delegates to the session's internal `_internalSend` (exposed to views via a `SendDelegate`). The send flow:

1. **Generate identifiers** — per-message `codecMessageId`s and `inputEventId`s (all `crypto.randomUUID()`). Neither the `runId` nor the `invocationId` is minted here — the agent mints both per HTTP request (the `runId` for a fresh run; a continuation reuses the run id the caller passed in `options.runId`).
2. **Auto-compute parent** — the View pre-computes `parentCodecMessageId` from the visible branch's tail message and passes it to the delegate. When neither `options.parent` nor `options.forkOf` is set, the delegate uses `parentCodecMessageId` as the auto-parent.
3. **Optimistic insert** — for each `user-message` event, the session builds transport headers (`role: "user"`, `codec-message-id`, parent, `event-id`) and calls `tree.applyMessage({ inputs: [event], outputs: [] }, headers, undefined)`. A fresh user input carries no `run-id` — it forms a run-less [input node](conversation-tree.md) keyed by its `codec-message-id`, and the agent's reply becomes a separate reply run parented to it. The user message itself does not carry `input-client-id` — the wire publisher's Ably `clientId` already conveys that. The Tree creates the input node on first message arrival, folds the event into the node's projection, and emits `update`. This makes the optimistic state visible to the view before the publish ack lands.
4. **Publish on the channel** — the session's shared encoder publishes each event via `encoder.publish(event, ...)`. Capability errors (Ably 401/403) are translated to `MissingPublishCapability` and reject `send()`.
5. **Return `ActiveRun`** — `send()` resolves as soon as the channel publish (step 4) completes. The core sends no HTTP. The caller receives `{ key, runId, inputEventId, cancel(), optimisticCodecMessageIds, toInvocation() }`. `key` is the triggering input's `codec-message-id` — the synchronous routing handle the client owns the instant it publishes. `runId` is a **promise** (the agent mints the run id now) — `await run.runId` to learn it once run-start lands. There is no `invocationId` here (the agent owns it; observe it on the wire via the run's `RunNode`/`RunInfo` once run-start lands). Decoded run outputs are not returned here — they are observed on the [conversation tree](conversation-tree.md)'s `output` event, routed by `inputCodecMessageId`.
6. **Observe run-start (optional)** — `ActiveRun.runId` is a promise that resolves to the agent-minted run id when the agent's opening lifecycle event for this send is observed — `ai-run-start` for a fresh send, `ai-run-resume` for a continuation — and rejects only if the session is closed first. There is no deadline — callers who want to bound the wait race `run.runId` against their own timeout. Internally, it is backed by a pending tracker keyed by the triggering input's `codec-message-id` — the agent echoes it back on the start/resume as `input-codec-message-id`, so for any send carrying input the match does not depend on the agent-minted `run-id` or `invocation-id`. The lone exception is an empty-input continuation, which publishes no input and so has no such id — it keys by the reused `runId` instead (and resolves immediately, since the caller already knows it). The start/resume handler resolves it, `close()` rejects it. A publish failure (step 4) drops the tracker.

After `send()` returns, the application decides whether to wake an agent. `ActiveRun.toInvocation()` builds the pointer — `inputEventId`, the channel name as `sessionName`, and `runId` only for a continuation (a fresh run omits it, leaving the agent to mint it) — and the canonical pattern is `await fetch(endpoint, { body: JSON.stringify(run.toInvocation().toJSON()) })`. The agent rebuilds it with `Invocation.fromJSON`, reads the conversation from the channel, mints the `run-id` (for a fresh run) and the `invocation-id`, and returns them on the HTTP response; the pointer itself carries only identifiers. The Vercel [chat transport](chat-transport.md) issues this POST itself so `useChat` stays request-driven.

`regenerate()` runs through the same flow as a regular send, with one carve-out: step 3 (optimistic tree-upsert) is skipped because the codec's `ait-regenerate` event decodes to zero TMessages. The wire still publishes — its `msg-regenerate` and `parent` headers carry the routing metadata; the agent's input-event lookup matches it by `event-id`. The Tree creates the new reply run when `ai-run-start` arrives under the agent-minted `runId`, populating `regeneratesMsgId` from the lifecycle event's `regenerates` field; the run is a sibling reply run at the same input node as the original.

### Multi-message chaining

When `sendMessage()` receives multiple messages, it chains them into a linear thread: each message after the first uses the previous message's `msg-id` as its `parent`. This produces a connected sequence rather than siblings at the same fork point.

## Optimistic reconciliation

When the server relays user messages back onto the channel, the client receives them like any other message. `applyMessage` routes the relay to the existing optimistic node by its `codec-message-id` — via the `_codecMessageIdToNodeKey` index — rather than creating a duplicate. Keying on `codec-message-id` (not the `run-id`) keeps reconciliation correct now that the agent mints the `run-id`: a user input is a run-less node, and its relay reconciles by the id the client owned at send time.

On relay, the node's `startSerial` is promoted from `undefined` to the server-assigned [serial](glossary.md#serial-ably), which triggers a re-sort - the optimistic node (sorted last) moves to its correct serial-order position.

## Message routing

The channel subscription handler (`_handleMessage`) processes every inbound Ably message:

### Run lifecycle events

- **`ai-run-start`** (wire) — `tree.applyRunLifecycle({type: 'start', runId, clientId, invocationId, serial, parent, forkOf})` creates or activates the Run, registers it as active, emits a `run` event. The channel serial rides on the event (`parseRunLifecycle` stamps it), so there is no separate serial argument. A run-start only ever opens a fresh run; a continuation re-enters via `ai-run-resume`.
- **`ai-run-suspend`** (wire) — `tree.applyRunLifecycle({type: 'suspend', runId, clientId, invocationId, serial})` marks the RunNode `'suspended'` and records `endSerial`, but keeps the run live (a continuation reusing the `runId` re-activates it), and emits a `run` event.
- **`ai-run-resume`** (wire) — `tree.applyRunLifecycle({type: 'resume', runId, clientId, invocationId, serial})` re-activates a suspended Run (`status` back to `'active'`) without touching its structure or serials, and emits a `run` event. This is how a continuation re-enters an existing run; the session resolves the continuation's `ActiveRun.runId` promise on it, keyed by `input-codec-message-id` just like a run-start.
- **`ai-run-end`** (wire) — `tree.applyRunLifecycle({type: 'end', runId, clientId, invocationId, serial, reason})` updates the RunNode's `status` and `endSerial` (from the event's serial), deregisters from active tracking, emits a `run` event. `ai-run-end` is terminal — a run pausing for input arrives as `ai-run-suspend` instead. The session keeps no per-run stream state to tear down.

### Codec-decoded messages

All other messages pass through the codec decoder. The session:

1. Calls `decoder.decode(rawMessage)` to get `{ inputs, outputs }` split by wire direction.
2. Calls `tree.applyMessage({ inputs, outputs }, headers, serial)` — the Tree folds events into the owning Run's projection and emits an `output` event with the message's outputs. This is the single fan-out point for run outputs; consumers (the View, and the Vercel chat transport's per-run stream) subscribe to it.
3. Calls `tree.emitAblyMessage(rawMsg)` so subscribers to `'ably-message'` can observe the raw wire.

There is no separate observer-state map. The Tree's per-Run projection is the single source of truth for every Run (own or observer); the View extracts messages on demand via `codec.getMessages(run.projection)`.

## Regenerate and edit

`view.regenerate(messageId)` and `view.edit(messageId, newMessages)` are convenience methods that delegate to the send flow with computed branching metadata:

- **`forkOf`** - the message ID of the message being replaced
- **`parent`** - the parent of the forked message in the tree
- **`history`** - messages truncated before the fork point (the LLM doesn't see the response being replaced)

The conversation tree handles the fork: the new message becomes a sibling of the original, and branch selection determines which path `flattenNodes()` returns. See [Conversation tree](conversation-tree.md) for the branching mechanics.

## Cancel

`cancel(runId)` publishes an `ai-cancel` message carrying `run-id`. See [Transport components: cancel routing](transport-components.md#cancel-routing-agent-session) for how the agent session processes cancel messages.

Publishing the cancel does **not** tear down the Run locally — late server events (e.g. abort status, final metadata) arriving before `run-end` still fold into the conversation tree. A consumer that wants its stream to end immediately on cancel closes its own stream; the Vercel chat transport does this when `useChat` aborts.

## History

`view.loadOlder()` loads older Runs from the Ably channel using [`untilAttach`](glossary.md#untilattach-ably) for gapless continuity with the live subscription. Pages are decoded through the codec, lifecycle events are dispatched to `tree.applyRunLifecycle`, and per-Run events fold into the owning Run's projection via `tree.applyMessage`.

The view paginates at **Run** granularity. `loadOlder(limit)` reveals up to `limit` Runs per call. A single channel page may materialise more than `limit` Runs, so the view applies a **withholding** buffer: the newest `limit` Runs are released immediately, and the rest are held back for subsequent `loadOlder()` calls. This prevents the UI from jumping to show many Runs at once and gives the consumer a predictable Run-unit page size regardless of how channel pages happen to align with Run boundaries.

## Delivery guarantee

With the Vercel AI SDK's default SSE transport, a broken connection surfaces immediately — `useChat` transitions to `status: 'error'` and the application can respond. The Ably transport should provide at least the same guarantee: either all events for a run are received in order through to run-end, or the consumer is told delivery was interrupted. The core conveys interruption by emitting a session `error` event; the Vercel [chat transport](chat-transport.md)'s per-run stream subscribes to it and errors the `useChat`-facing stream, surfacing as `status: 'error'`.

Cases where the guarantee would be violated and the session emits `error`:

- **Channel continuity loss** - the channel entered a state where message delivery can no longer be assured (FAILED, SUSPENDED, DETACHED, or re-attached with `resumed: false`). Events may have been lost. The session emits `error` with `ChannelContinuityLost`. The transport does not clean up per-run state or emit synthetic run-end events — events may still arrive later.
- **Unhealthy channel at send time** - `send()` is called when the channel is not ATTACHED or ATTACHING. The send is rejected with `ChannelNotReady`.

A failed agent-invocation POST is **not** handled here — the core never sends HTTP. Whoever issues the invocation owns that failure: the Vercel chat transport errors the `useChat`-facing stream when its POST fails (with `SessionSendFailed`), while a generic app that POSTs `run.toInvocation()` itself handles the rejected `fetch` directly.

## Close

`close()` tears down all session state:

1. Optionally publishes a cancel message (if `options.cancel` is set)
2. Unsubscribes from the channel
3. Clears event handlers and pending run-start trackers (rejecting any unresolved `ActiveRun.runId` promises with `SessionClosed`); closes the encoder

After close, all methods that create runs throw `SessionClosed`. Event subscriptions return no-op unsubscribe functions. The Tree retains its data (so any in-flight observer rendering continues to read the last-known state) — callers that need a fresh Tree must create a new session.

## Events

| Event                    | Payload                | When                                                                                                                                                                                               |
| ------------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `update` (on view)       | (none)                 | View state changed - call `view.flattenNodes()` for current state                                                                                                                                  |
| `run` (on tree or view)  | `RunLifecycleEvent`    | Run started or ended (includes runId, clientId, invocationId, serial, reason)                                                                                                                      |
| `output` (on tree)       | `OutputEvent<TOutput>` | Decoded agent outputs folded into a Run - runId, codecMessageId, serial, and the output events (empty for inputs-only folds)                                                                       |
| `error`                  | `Ably.ErrorInfo`       | Non-fatal error (channel publish failure, channel continuity loss, subscription error). Subscribe via `session.on('error')`; the Vercel chat transport errors its `useChat`-facing stream on these |
| `ably-message` (on tree) | (none)                 | Raw Ably message added - subscribe via `tree.on('ably-message')`                                                                                                                                   |

See [Sessions concept](../concepts/sessions.md) for the public API perspective. See [Transport components](transport-components.md) for the sub-component internals. See [Message lifecycle](message-lifecycle.md) for the end-to-end message flow.
