# Client session

The client session (`src/core/transport/client-session.ts`) manages the full client-side conversation lifecycle over a single Ably channel. It composes a [conversation tree](conversation-tree.md) and codec [decoder](decoder.md) to handle receiving streamed responses and managing conversation state. Write operations (`send`, `regenerate`, `edit`) live on the [ClientView](glossary.md#view-clientview-and-branchsource), which delegates to the session's internal send machinery.

The client publishes user messages directly to the channel via the shared codec encoder. It does **not** send HTTP — the core session is a pure Ably-channel transport. Waking an agent is the application's concern: it POSTs `run.toInvocation().toJSON()` to its own endpoint if and when it wants one woken (the Vercel [chat transport](chat-transport.md) does this automatically for `useChat` parity). The agent locates the triggering input event by its `event-id` header (channel rewind + live subscribe), mints the `invocation-id` itself (one per HTTP request), and publishes [run lifecycle events](wire-protocol.md#lifecycle-events) plus assistant chunks. The channel is the durable session record — agents that weren't running at publish time can resume by reading channel rewind.

## Composition

```
DefaultClientSession
├── Tree                   - node-keyed conversation forest; owns per-node TProjection via codec.fold
├── ClientView(s)          - navigable/writable view over the tree: pagination, branch selection,
│                            'update' events, and the write path (send/regenerate/edit)
├── Decoder                - decodes inbound Ably messages to codec events
├── Encoder                - shared encoder; publishInput on the ai-input wire
├── EventEmitter           - typed event bus for the 'error' event
└── pending run-start trackers - resolve ClientRun.started on the matching ai-run-start
```

The session owns a default `view` plus any further views created via `createView()`, all sharing the one Tree. Each is a [ClientView](glossary.md#view-clientview-and-branchsource) - the read-only [View](glossary.md#view-clientview-and-branchsource) base (`getMessages`, pagination, scoped events) extended with branch navigation and the write path. A ClientView walks the whole-tree branch via an injected [BranchSource](glossary.md#view-clientview-and-branchsource); the agent's leaf-pinned `run.view` reuses the same View base with a different BranchSource.

The Tree keys each node by its primary key — `codec-message-id` for a user [input node](conversation-tree.md), the agent-minted `runId` for a reply run — and owns the per-node codec projection. Inbound events flow directly into `tree.applyMessage()`, which folds them into the owning node's projection and surfaces decoded outputs on the tree's `output` event. The session keeps only the bookkeeping it needs locally: pending run-start trackers keyed by the triggering input's `codec-message-id`.

All sub-components are created in the constructor and share a single Ably channel. Construction is synchronous and does no channel I/O. Callers must `await session.connect()` before any send or cancel call; otherwise those methods throw `InvalidArgument`. `connect()` subscribes to the channel before attach ([RTL7g](https://sdk.ably.com/builds/ably/specification/main/features/#RTL7g)) to guarantee no messages are missed, and is idempotent - a second call returns the same in-flight promise.

## Send flow

`view.send()` is the primary entry point for starting a new run. It sends a single input message (compose a user message via `codec.createUserMessage(message)`). A send introduces at most one new message: exactly one non-wire-only input. The array form exists only to carry the wire-only inputs that resolve a single assistant turn (e.g. the tool results / approval responses for that turn's parallel tool calls, published atomically); passing more than one new (non-wire-only) input rejects with `InvalidArgument`. It delegates to the session's internal `_internalSend` (exposed to views via a `SendDelegate`). The send flow:

1. **Generate identifiers** — per-message `codecMessageId`s and `inputEventId`s (all `crypto.randomUUID()`). Neither the `runId` nor the `invocationId` is minted here. The agent mints the `invocationId` per HTTP request, and the `runId` too for a fresh run; a continuation reuses the run id the caller passes in `options.runId`, which the client stamps on the continuation's `ai-input` (the agent reads it off the channel, not from the invocation body).
2. **Auto-compute parent** — the View pre-computes `parentCodecMessageId` from the visible branch's tail message and passes it to the delegate. When neither `options.parent` nor `options.forkOf` is set, the delegate uses `parentCodecMessageId` as the auto-parent.
3. **Build headers and optimistically fold** — the session builds transport headers for every input (`role: "user"`, `codec-message-id`, `run-client-id` from the session `clientId`, parent / fork-of / msg-regenerate as applicable, `event-id`). For inputs that are **not** wire-only it then calls `tree.applyMessage({ inputs: [event], outputs: [] }, headers)`. An input is wire-only when it is a `regenerate` or otherwise references an existing `codecMessageId` — a fresh `user-message` always folds, even if it pins its own `codecMessageId`. A fresh user input carries no `run-id` — it forms a run-less [input node](conversation-tree.md) keyed by its `codec-message-id`, and the agent's reply becomes a separate reply run parented to it. The session does not stamp `input-client-id` here; the publishing client's `clientId` rides on the wire as `run-client-id`. The Tree creates the input node on first message arrival, folds the event into the node's projection, and emits `update`. This makes the optimistic state visible to the view before the publish ack lands.
4. **Publish on the channel** — the session's shared encoder publishes each event via `encoder.publishInput(event, ...)` (the `ai-input` wire). Capability errors (Ably 401/403) are translated to `InsufficientCapability` and reject `send()`; other publish failures reject with `SessionSendFailed`. Either way the session emits a session `error` event, drops the run-start tracker, and clears a fresh send's optimistic input node.
5. **Return `ClientRun`** — `send()` resolves as soon as the channel publish (step 4) completes. The core sends no HTTP. The caller receives `{ inputCodecMessageId, runId, started, inputEventId, cancel(), toInvocation() }`. `inputCodecMessageId` is the triggering input's `codec-message-id` — the synchronous routing handle the client owns the instant it publishes. `runId` is a **string** getter, empty until run-start lands; `started` is a **promise** (the agent mints the run id now) — `await run.started`, then read `run.runId`. There is no `invocationId` here (the agent owns it; observe it on the wire via the run's `RunNode`/`RunInfo` once run-start lands). Decoded run outputs are not returned here — they are observed on the [conversation tree](conversation-tree.md)'s `output` event, routed by `inputCodecMessageId`.
6. **Observe run-start (optional)** — `ClientRun.started` is a promise that resolves when the agent's opening lifecycle event for this send is observed — `ai-run-start` for a fresh send, `ai-run-resume` for a continuation — at which point `run.runId` holds the agent-minted id; it rejects only if the session is closed first. There is no deadline — callers who want to bound the wait race `run.started` against their own timeout. Internally, it is backed by a pending tracker keyed by the triggering input's `codec-message-id` — the agent echoes it back on the start/resume as `input-codec-message-id`, so the match never depends on the agent-minted `run-id` or `invocation-id`. Every send carries at least one input (an empty input array is rejected), so the triggering `codec-message-id` is always present. The start/resume handler resolves it, `close()` rejects it. A publish failure (step 4) drops the tracker.

After `send()` returns, the application decides whether to wake an agent. `ClientRun.toInvocation()` builds the pointer — `inputEventId` and the channel name as `sessionName` (no `run-id`; run identity lives on the channel) — and the canonical pattern is `await fetch(endpoint, { body: JSON.stringify(run.toInvocation().toJSON()) })`. The agent rebuilds it with `Invocation.fromJSON`, reads the conversation from the channel, mints the `invocation-id` (and the `run-id` for a fresh run, or reads a continuation's off the triggering input), and returns them on the HTTP response; the pointer itself carries only the input-event and session identifiers. The Vercel [chat transport](chat-transport.md) issues this POST itself so `useChat` stays request-driven.

`regenerate()` runs through the same flow as a regular send, with one carve-out: the optimistic projection fold is skipped because the codec's `regenerate` input is wire-only (it references an existing message and decodes to zero fresh TMessages). The wire still publishes — its `msg-regenerate` (the `Regenerate` input's `target`) and `parent` headers carry the routing metadata; the agent's input-event lookup matches it by `event-id`. The Tree creates the new reply run when `ai-run-start` arrives under the agent-minted `runId`, populating `regeneratesCodecMessageId` from the lifecycle event's `regenerates` field; the run is a sibling reply run at the same input node as the original.

### One new message per send

A send introduces at most one new message. `_internalSend` rejects with `InvalidArgument` if more than one non-wire-only input is passed (a fresh user message is non-wire-only; a `regenerate` signal and tool resolutions are wire-only). The array form therefore only ever carries the wire-only inputs that resolve a single assistant turn — for example the tool results / approval responses for that turn's parallel tool calls, published atomically before the agent is woken. Exactly one input optimistically folds (the new message, if any); the wire-only inputs ride the channel without a local fold and reference existing messages by their own `codec-message-id`.

## Optimistic reconciliation

When the server relays user messages back onto the channel, the client receives them like any other message. `applyMessage` routes the relay to the existing optimistic node by its `codec-message-id` — via the `_codecMessageIdToNodeKey` index — rather than creating a duplicate. Keying on `codec-message-id` (not the `run-id`) keeps reconciliation correct now that the agent mints the `run-id`: a user input is a run-less node, and its relay reconciles by the id the client owned at send time.

On relay, the input node's `serial` is promoted from `undefined` to the server-assigned [serial](glossary.md#serial-ably), which triggers a re-sort - the optimistic node (sorted last) moves to its correct serial-order position. (A reply RunNode promotes its `startSerial` the same way; an input node's sort key is its own `serial`.)

## Message routing

The channel subscription handler (`_handleMessage`) processes every inbound Ably message. It delegates the classify-parse-apply to the shared `applyWireMessage(tree, decoder, msg)` engine (`decode-fold.ts`) — the same path the View's history replay uses, so the live loop can't drift from it. `applyWireMessage` dispatches on the Ably message `name`: run-lifecycle names (`ai-run-start`, `ai-run-suspend`, `ai-run-resume`, `ai-run-end`) are parsed via `parseRunLifecycle` and applied with `tree.applyRunLifecycle`; everything else is decoded and applied with `tree.applyMessage`. After the apply, `_handleMessage` runs its live-only side effects and calls `tree.emitAblyMessage(msg)`.

### Run lifecycle events

- **`ai-run-start`** (wire) — `tree.applyRunLifecycle({type: 'start', runId, clientId, invocationId, serial, parent, forkOf, regenerates})` creates or activates the Run, registers it as active, emits a `run` event. The channel serial rides on the event (`parseRunLifecycle` stamps it), so there is no separate serial argument. A run-start only ever opens a fresh run; a continuation re-enters via `ai-run-resume`. Live-only, `_handleMessage` resolves the pending `ClientRun.started` promise here, keyed by the echoed `input-codec-message-id` (the agent-minted run id is now readable on `run.runId`).
- **`ai-run-suspend`** (wire) — `tree.applyRunLifecycle({type: 'suspend', runId, clientId, invocationId, serial})` marks the RunNode `'suspended'` and records `endSerial`, but keeps the run live (a continuation reusing the `runId` re-activates it), and emits a `run` event.
- **`ai-run-resume`** (wire) — `tree.applyRunLifecycle({type: 'resume', runId, clientId, invocationId, serial})` re-activates a suspended Run (`status` back to `'active'`) without touching its structure or serials, and emits a `run` event. This is how a continuation re-enters an existing run; the session resolves the continuation's `ClientRun.started` promise on it, keyed by `input-codec-message-id` just like a run-start.
- **`ai-run-end`** (wire) — `tree.applyRunLifecycle({type: 'end', runId, clientId, invocationId, serial, reason})` updates the RunNode's `state` and `endSerial` (from the event's serial), deregisters from active tracking, emits a `run` event. `ai-run-end` is terminal — a run pausing for input arrives as `ai-run-suspend` instead. The session keeps no per-run stream state to tear down. Live-only, _before_ applying the run-end, `_handleMessage` inspects the `run-reason` header: when it is `error`, it reads the `error-code` / `error-message` headers, builds an `Ably.ErrorInfo`, and emits a session `error` event — preserving the `error`-before-`run` emit ordering so a per-run-stream consumer can error its stream.

### Codec-decoded messages

All non-lifecycle messages pass through the codec decoder inside `applyWireMessage`:

1. `decoder.decode(rawMessage)` yields `{ inputs, outputs }` split by wire direction.
2. `tree.applyMessage({ inputs, outputs }, headers, serial)` — the Tree folds events into the owning Run's (or input node's) projection and emits an `output` event carrying the message's outputs. This is the single fan-out point for run outputs; consumers (the View, and the Vercel chat transport's per-run stream) subscribe to it. A wire-only carrier that decodes to no events and carries no `run-id` is skipped (the eventual reply run is created later by its run-start).

After the apply returns, `_handleMessage` calls `tree.emitAblyMessage(rawMsg)` so subscribers to `'ably-message'` can observe the raw wire — emitted _after_ the apply so View subscribers can already find the owning Run. Any error thrown while processing a message is caught and surfaced as a session `error` event (`SessionSubscriptionError`) rather than escaping the listener.

There is no separate observer-state map. The Tree's per-Run projection is the single source of truth for every Run (own or observer); the View extracts messages on demand via `codec.getMessages(run.projection)`.

## Regenerate and edit

`view.regenerate(messageId)` and `view.edit(messageId, inputs)` are convenience methods that delegate to the send flow with computed branching metadata:

- **`view.edit`** resolves the parent of the target user message, then calls `view.send(inputs, { forkOf: messageId, parent })`. The `forkOf` (the codec-message-id of the message being replaced) becomes the `fork-of` wire header.
- **`view.regenerate`** resolves the target reply run's parent user prompt, mints a `Regenerate` input via `codec.createRegenerate(target, parent)`, and sends it with `{ parent }`. The replacement is carried by the `Regenerate.target` (→ the `msg-regenerate` header), not `fork-of`.

Neither method truncates conversation history in the core — the agent re-reads the conversation from the channel and the codec projection decides which messages the LLM sees; history truncation for `useChat` parity lives in the Vercel [chat transport](chat-transport.md).

The conversation tree handles the fork: the new reply run becomes a sibling of the original at the same input node, and branch selection determines which path the View's `getMessages()` returns. See [Conversation tree](conversation-tree.md) for the branching mechanics.

## Cancel

`cancel(runId)` publishes an `ai-cancel` message carrying `run-id`. See [Transport components: cancel routing](transport-components.md#cancel-routing-agent-session) for how the agent session processes cancel messages.

Publishing the cancel does **not** tear down the Run locally — late server events (e.g. abort status, final metadata) arriving before `run-end` still fold into the conversation tree. A consumer that wants its stream to end immediately on cancel closes its own stream; the Vercel chat transport does this when `useChat` aborts.

## History

`view.loadOlder()` loads older messages from the Ably channel using [`untilAttach`](glossary.md#untilattach-ably) for gapless continuity with the live subscription. Pages are decoded through the codec, lifecycle events are dispatched to `tree.applyRunLifecycle`, and per-Run events fold into the owning Run's projection via `tree.applyMessage`.

The view paginates at **codecMessage** granularity. `loadOlder(limit)` (default `10`) reveals up to `limit` older messages per call and resolves to that revealed page (oldest-first), or `[]` once channel history is exhausted or a load is already in flight. Internally runs are revealed **whole**: the view counts codecMessages to decide how many older runs to bring in, releases the newest run(s) covering the budget, withholds the rest in a buffer for subsequent calls, then trims the flat `getMessages()` list to exactly `limit` new messages. A run straddling the page boundary still appears in `runs()` (it is a revealed node) while only its newest messages show in `getMessages()`. This gives the consumer a predictable message-unit page size regardless of how channel pages align with run boundaries.

## Delivery guarantee

With the Vercel AI SDK's default SSE transport, a broken connection surfaces immediately — `useChat` transitions to `status: 'error'` and the application can respond. The Ably transport should provide at least the same guarantee: either all events for a run are received in order through to run-end, or the consumer is told delivery was interrupted. The core conveys interruption by emitting a session `error` event; the Vercel [chat transport](chat-transport.md)'s per-run stream subscribes to it and errors the `useChat`-facing stream, surfacing as `status: 'error'`.

Cases where the guarantee would be violated and the session emits `error`:

- **Channel continuity loss** - after the initial attach, the channel entered a state where message delivery can no longer be assured (FAILED, SUSPENDED, DETACHED, or re-attached with `resumed: false`). Events may have been lost. The session emits `error` with `ChannelContinuityLost`. The transport does not clean up per-run state or emit synthetic run-end events — events may still arrive later. Transitions to these states _before_ the first attach are not continuity loss: no messages had yet been received, so there was nothing to lose.
- **Unhealthy channel at send time** - `send()` is called when the channel is not ATTACHED or ATTACHING. The send is rejected with `ChannelNotReady`.

A failed agent-invocation POST is **not** handled here — the core never sends HTTP. Whoever issues the invocation owns that failure: the Vercel chat transport errors the `useChat`-facing stream when its POST fails (with `SessionSendFailed`), while a generic app that POSTs `run.toInvocation()` itself handles the rejected `fetch` directly.

## Close

`close()` tears down all session state:

1. Unsubscribes the message listener (only if `connect()` ran) and removes the channel state-change listener
2. Clears the session's `error` handlers, closes all views, and rejects any unresolved `ClientRun.started` promises with `SessionClosed`
3. Best-effort-closes the encoder (a no-op on the client's discrete-only path, but it releases internal resources)
4. Detaches the channel the session attached — `connect()` subscribed (and so attached) it, so `close()` cleans up that attach, but only when `connect()` ran. Best-effort: a detach failure is swallowed (logged at debug).

`close()` does **not** publish a cancel — it is local-state-only. The server keeps streaming until its runs end on their own; to stop in-progress runs, call `cancel(runId)` for each before closing. It also does **not** close the injected Ably client — the caller owns its lifecycle (see [Sessions](../concepts/sessions.md#session-lifecycle)). After close, all methods that create runs throw `SessionClosed`. Event subscriptions return no-op unsubscribe functions. The Tree retains its data (so any in-flight observer rendering continues to read the last-known state) — callers that need a fresh Tree must create a new session.

## Events

| Event                    | Payload                | When                                                                                                                                                                                               |
| ------------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `update` (on view)       | (none)                 | View state changed - call `view.getMessages()` for current state                                                                                                                                   |
| `run` (on tree or view)  | `RunLifecycleEvent`    | Run lifecycle: started, suspended, resumed, or ended (runId, clientId, invocationId; serial when present; reason on the `end` variant)                                                             |
| `output` (on tree)       | `OutputEvent<TOutput>` | Decoded outputs folded into a node - runId (undefined for an input-node fold), inputCodecMessageId (the routing key), codecMessageId, serial, and the output events (empty for inputs-only folds)  |
| `error`                  | `Ably.ErrorInfo`       | Non-fatal error (channel publish failure, channel continuity loss, subscription error). Subscribe via `session.on('error')`; the Vercel chat transport errors its `useChat`-facing stream on these |
| `ably-message` (on tree) | `Ably.InboundMessage`  | Raw Ably message added - subscribe via `tree.on('ably-message')`                                                                                                                                   |

See [Sessions concept](../concepts/sessions.md) for the public API perspective. See [Transport components](transport-components.md) for the sub-component internals. See [Message lifecycle](message-lifecycle.md) for the end-to-end message flow.
