# Glossary

Quick definitions for terms used across the internals docs. Ably-specific concepts are marked with **(Ably)**.

## Ably primitives

### Serial **(Ably)**

A lexicographically sortable string identifier that Ably assigns to every message on acceptance. Serials can be compared lexicographically to produce a total order over messages. However, this is not necessarily the order in which messages are delivered to subscribers - the only delivery-order guarantee is that messages published sequentially on the same realtime connection are always delivered in that same relative order, but they may interleave with messages published concurrently from other connections. The [conversation tree](conversation-tree.md) uses serials as the primary ordering mechanism, and the [decoder](decoder.md) uses them to correlate appends back to the originating message.

### Message actions **(Ably)**

Ably supports updates, deletes, and appends on messages after publication. The AI Transport SDK uses **message appends** to stream LLM tokens - a message is created with a `publish` (which returns a serial), then receives `appendMessage` calls that add data incrementally, and ends with a closing append that sets the final state. Each token is appended to a single persistent message rather than published as a separate message.

The alternative is a **discrete message** - a single publish with no subsequent appends. User messages and lifecycle events are discrete.

### Message actions **(Ably)**

The four operations that can happen to an Ably message:

| Action           | Meaning                                             |
| ---------------- | --------------------------------------------------- |
| `message.create` | A new message was published                         |
| `message.append` | Data was appended to an existing message            |
| `message.update` | An existing message's content was replaced entirely |
| `message.delete` | A message was deleted                               |

Subscribers receive these as the `action` field on inbound messages. The [decoder](decoder.md#action-dispatch) switches on this field to determine how to process each message.

### Channel attach **(Ably)**

The act of connecting to an Ably channel. A channel transitions from `initialized` → `attaching` → `attached`. Once attached, the client receives live messages published to the channel. The client session subscribes to the channel before calling `attach()` to ensure no messages are lost during the attach process.

### untilAttach **(Ably)**

A parameter on Ably's `channel.history()` API that fetches messages up to the exact point where the channel was attached. This guarantees **gapless continuity** - history ends precisely where the live subscription begins, with no duplicates and no gaps. See [History hydration](history.md#channel-attach-and-untilattach).

### extras.ai **(Ably)**

Every Ably message has an `extras` field that can carry metadata. The AI Transport protocol stores all its headers under `extras.ai`, reserved for the SDK and split into two tiers: [transport headers](wire-protocol.md#transport-headers) under `extras.ai.transport` and [codec headers](wire-protocol.md#codec-headers) under `extras.ai.codec`. Each tier is a `Record<string, string>` of unprefixed key-value pairs — the tiers isolate the two namespaces, so neither needs a prefix. The separate `extras.headers` field is deliberately left untouched, reserved for the application's own use.

## Transport architecture

### Transport layer vs domain layer

The SDK has two layers with a strict boundary:

- **Transport layer** - generic machinery shared by all codecs. Handles run lifecycle, stream routing, optimistic reconciliation, cancel signals, and conversation tree management. Uses unprefixed transport headers. Lives in `src/core/transport/`.
- **Domain layer** - framework-specific encoding/decoding. Maps between domain events (e.g. Vercel's `UIMessageChunk`) and Ably messages. Uses codec headers (`extras.ai.codec`). Lives in codec implementations (e.g. `src/vercel/codec/`).

The [codec interface](codec-interface.md) is the boundary between these layers.

### Own run vs observer run

A distinction by who started the run:

- **Own run** - a run this client initiated (via `view.send()`, `view.regenerate()`, `view.edit()`).
- **Observer run** - a run started by another client.

The client session does **not** route the two differently: every decoded run output, own or observer, folds into the run's projection in the [conversation tree](conversation-tree.md) and surfaces on the tree's `output` event keyed by `runId`. The distinction matters for affordances layered on top — cancel is scoped to a run the caller holds, and a UI may mark its own runs — not for how outputs are delivered. See [Message lifecycle](message-lifecycle.md#how-run-outputs-surface) for the delivery path.

### Client identity tiers

The protocol attributes each event to a client at two concentric scopes:

- **`runClientId`** (`run-client-id`) — the client that **owns** the run, the one whose initiating `ai-input` started it. Constant for the lifetime of the run, even when later inputs come from other clients.
- **`inputClientId`** (`input-client-id`) — the clientId of the input event (the `ai-input`) that drove the current invocation. The agent reads it from the publisher's Ably-level `clientId` on the triggering wire message and re-stamps it on its own published events for that invocation. Updates on a continuation `ai-run-start` if the triggering input came from a different client (e.g. a tool-result publish from a non-owner).

For a fresh run the two are equal. They diverge on continuation invocations triggered by an input event from someone other than the run owner. The Ably channel-level `clientId` on each message is a third, orthogonal identity field — the publisher of that particular event. See [Wire protocol: client identity](wire-protocol.md#client-identity).

### Run ID vs message ID

Two different identity headers serve different purposes:

- **Run ID** (`run-id`) - groups all messages in one request-response cycle. A single run may produce multiple messages (user message, assistant text, lifecycle events). Used for cancellation scope, active run tracking, and stream routing.
- **Codec message ID** (`codec-message-id`) - uniquely identifies a single domain message (a `crypto.randomUUID()` generated by the client or agent session). Used for [optimistic reconciliation](wire-protocol.md#optimistic-reconciliation), [accumulator routing](codec-interface.md#accumulator), and [conversation tree](conversation-tree.md) node identity. For streamed messages, every append carries the same codec-message-id so the entire message append lifecycle shares one identity.

A run contains one or more messages. A message belongs to exactly one run. See [Wire protocol: message identity](wire-protocol.md#message-identity-codec-message-id) for the full lifecycle.

## Encoding/decoding concepts

### Terminal event

An event that signals the end of a stream. For the Vercel codec, terminal events are `finish`, `error`, and `abort` chunks (the AI SDK chunk type, kept verbatim on the wire). The Vercel [chat transport](chat-transport.md)'s per-run output stream closes the `ReadableStream` when a terminal chunk arrives, so `useChat`'s reader ends. The [decoder](decoder.md#append-handling) checks `status` for `"complete"` or `"cancelled"` to detect terminal state on the wire.

### Fire-and-forget

An async operation where the caller does not `await` the result. The promise is collected but errors are handled later in batch (or logged and discarded). The [encoder](encoder.md#appendstream) uses fire-and-forget for append operations - each token delta is sent without waiting for acknowledgement, and failures are caught during [flush](encoder.md#recovery-mechanism). The Vercel [chat transport](chat-transport.md)'s agent-invocation POST is also fire-and-forget - the response stream arrives over the channel subscription, not the HTTP response.

### Prefix-match

The [decoder's](decoder.md#known-serial-prefix-match) strategy for handling `message.update` on a tracked stream. When an update arrives, the decoder checks: does the new data start with the text already accumulated? If yes (prefix match), it extracts just the new delta (`data.slice(accumulated.length)`) and emits delta events. If no (not a prefix), the message was fully replaced (e.g. [encoder recovery](encoder.md#recovery-mechanism)) and the decoder resets its tracker.

### First-contact

When the [decoder](decoder.md#first-contact) receives an update for a serial it has never seen - the stream started before this client subscribed (e.g. history, reconnect, late join). The decoder synthesizes the full event sequence from the update: start events, delta events (if data is present), and end events (if status is `"complete"`). This allows late-joining clients to reconstruct the stream state.

### Optimistic reconciliation

When a client calls `send()`, it inserts an optimistic message into the conversation tree (with no serial). The server then relays that message onto the channel, and all clients - including the sender - receive it. The sending client matches the relayed message by `codec-message-id` and reconciles the optimistic entry with the server-assigned serial ([serial promotion](conversation-tree.md#upsert-the-sole-mutation)) rather than creating a duplicate.

## Conversation tree concepts

### Group root

The original message in a [sibling group](conversation-tree.md#sibling-groups-and-fork-chains) - the message at the root of the `forkOf` chain. When messages fork the same target transitively (A → B forks A, C forks B), the group root is A. Sibling selections are stored by the group root's `codecMessageId`.

### Serial promotion

When an optimistic message (null serial) receives a server-assigned serial via [optimistic reconciliation](#optimistic-reconciliation), the conversation tree removes it from its current position (end of the sorted list) and re-inserts it at the correct serial-order position. See [conversation tree upsert](conversation-tree.md#upsert-the-sole-mutation).

## Type parameters

### TEvent

The streaming fragment type that the generic layer is parameterized by. For the Vercel codec, this is `UIMessageChunk`. Events are the unit of real-time streaming - individually meaningless fragments (a text delta, a finish event) that must be accumulated into a complete message. The [decoder](decoder.md) produces events; the [conversation tree](conversation-tree.md) surfaces them on its `output` event; the [accumulator](codec-interface.md#accumulator) assembles them into `TMessage` instances.

### TMessage

The complete domain message type that the generic layer is parameterized by. For the Vercel codec, this is `UIMessage`. Messages are the unit of state - what the [conversation tree](conversation-tree.md) stores, what the view's `flattenNodes()` returns, what React hooks render. The [accumulator](codec-interface.md#accumulator) bridges `TEvent → TMessage`; the encoder bridges `TMessage → wire` (for discrete publishes like user messages). See [Message lifecycle](message-lifecycle.md#tevent-and-tmessage) for the full relationship.

## Message state

### Message accumulator

A codec-provided component that assembles [decoder outputs](decoder.md#decoder-output-types) into complete domain messages. Needed because one domain message is built from many wire messages - a streamed assistant response may produce dozens of Ably messages (create + N appends + close) that must be assembled into a single `TMessage`. Used in two contexts: live [observer runs](glossary.md#own-run-vs-observer-run) (working buffer, snapshots upserted into tree on every event) and [history decoding](history.md) (collect only completed messages). See [Accumulator](codec-interface.md#accumulator) for the full explanation.

### Message materialization

The act of producing a flat message list from the [conversation tree](conversation-tree.md). `view.flattenNodes()` returns the visible Run chain as `RunNode[]`; `view.getMessages()` walks each visible Run's `codec.getMessages(projection)` and concatenates them into the flat `TMessage[]` the UI renders. Both are cached in the View and refresh when the tree's structure changes (new Runs, deletions, selection changes, history reveal). All consumers go through the View: React hooks, `sendMessage()` (for the HTTP POST body), `view.loadOlder()` (for pagination snapshots). See [Message lifecycle](message-lifecycle.md#cached-message-list).

### Flatten

`view.flattenNodes()` returns the View's cached Run chain in O(1) — `RunNode<TProjection>[]`. The cache is rebuilt by an internal `_computeFlatNodes()` method that walks the Tree's `_sortedRuns`, checks parent reachability and sibling selection, and produces the visible Run sequence for the currently selected branches. The View's `getMessages()` consumes the cached chain and concatenates each Run's `codec.getMessages(projection)` to produce the flat `TMessage[]`. (`flattenNodes(selections)` on `TreeInternal` does the actual tree walk; the View's public method returns cached results.) See [Conversation tree: flatten](conversation-tree.md#flatten-producing-the-visible-run-chain).

### TProjection

The opaque per-Run codec state that the Tree folds events into. Each `RunNode` owns one `TProjection`, initialised via `codec.init()` and updated via `codec.fold(state, event, meta)`. The View extracts the per-message list from a projection via `codec.getMessages(projection)`. The SDK never inspects projection internals — it's the codec's contract surface.
