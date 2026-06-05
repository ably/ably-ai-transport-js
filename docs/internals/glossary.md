# Glossary

Quick definitions for terms used across the internals docs. Ably-specific concepts are marked with **(Ably)**.

## Ably primitives

### Serial **(Ably)**

A lexicographically sortable string identifier that Ably assigns to every message on acceptance. Serials can be compared lexicographically to produce a total order over messages. However, this is not necessarily the order in which messages are delivered to subscribers - the only delivery-order guarantee is that messages published sequentially on the same realtime connection are always delivered in that same relative order, but they may interleave with messages published concurrently from other connections. The [conversation tree](conversation-tree.md) uses serials as the primary ordering mechanism, and the [decoder](decoder.md) uses them to correlate appends back to the originating message.

### Message appends **(Ably)**

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

The act of connecting to an Ably channel. A channel transitions from INITIALIZED → ATTACHING → ATTACHED. Once attached, the client receives live messages published to the channel. The client session subscribes to the channel before calling `attach()` to ensure no messages are lost during the attach process.

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
- **`inputClientId`** (`input-client-id`) — the clientId of the input event (the `ai-input`) that drove the current invocation. The agent reads it from the publisher's Ably-level `clientId` on the triggering wire message and re-stamps it on its own published events for that invocation. Updates on a continuation `ai-run-resume` if the triggering input came from a different client (e.g. a tool-result publish from a non-owner).

For a fresh run the two are equal. They diverge on continuation invocations triggered by an input event from someone other than the run owner. The Ably channel-level `clientId` on each message is a third, orthogonal identity field — the publisher of that particular event. See [Wire protocol: client identity](wire-protocol.md#client-identity).

### Run ID vs invocation ID vs message ID

Three different identity headers serve different purposes:

- **Run ID** (`run-id`) - groups all messages of one agent response, agent-minted at run-start. A single run may produce multiple messages (assistant text, lifecycle events) and may span multiple invocations (it can suspend and resume under the same `run-id`). Used for cancellation scope, active run tracking, and stream routing.
- **Invocation ID** (`invocation-id`) - identifies a single HTTP invocation of the agent under a run, agent-minted one per request. A suspend/resume cycle re-invokes the agent, so one run can carry several invocation-ids. The agent stamps it on every lifecycle event and output it publishes for that invocation.
- **Codec message ID** (`codec-message-id`) - uniquely identifies a single domain message. Used for [optimistic reconciliation](wire-protocol.md#optimistic-reconciliation), [reducer routing](codec-interface.md#reducer-and-projection) (folding an event onto its target message), and [conversation tree](conversation-tree.md) node identity. For streamed messages, every append carries the same codec-message-id so the entire message append lifecycle shares one identity. See [Who generates it](wire-protocol.md#who-generates-it) for the minting rules.

A run carries the agent's response messages and lifecycle events. The triggering user input is **run-less** — the agent mints the `run-id` at run-start, so a client-published input event carries no `run-id` and lives as its own input node. See [Wire protocol: message identity](wire-protocol.md#message-identity-codec-message-id) for the full lifecycle.

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

When a client calls `view.send()`, it inserts an optimistic node into the conversation tree (with no serial) and publishes the input on the channel. The same message comes back on the client's own subscription - and on every other subscriber's - carrying the server-assigned serial. The sending client matches the echo by `codec-message-id` and reconciles the optimistic entry with the server-assigned serial ([serial promotion](#serial-promotion)) rather than creating a duplicate.

## Conversation tree concepts

### Group root

The original message in a [sibling group](conversation-tree.md#sibling-groups-and-fork-chains) - the message at the root of the `forkOf` chain. When messages fork the same target transitively (A → B forks A, C forks B), the group root is A. Sibling selections are stored by the group root's `codecMessageId`.

### Serial promotion

When an optimistic node (null serial) receives a server-assigned serial via [optimistic reconciliation](#optimistic-reconciliation), the conversation tree promotes the node's serial (`_promoteSerial`) and re-sorts `_sortedNodes` so it lands at the correct serial-order position. See [conversation tree: apply](conversation-tree.md#apply-the-two-mutation-entry-points).

## Type parameters

### TInput and TOutput

The streaming fragment types that the generic layer is parameterized by, split by wire direction. `TInput` events are client-published (`ai-input`: a user-message part, a tool-result, a regenerate signal); `TOutput` events are agent-published (`ai-output`: a text delta, a finish event). For the Vercel codec, `TOutput` is `UIMessageChunk`. Events are the unit of real-time streaming - individually meaningless fragments that must be folded into a complete message. The [decoder](decoder.md) produces events; the [conversation tree](conversation-tree.md) surfaces decoded outputs on its `output` event; the codec's [reducer](codec-interface.md#reducer-and-projection) folds them into a [TProjection](#tprojection) from which `getMessages()` assembles `TMessage` instances.

### TMessage

The complete domain message type that the generic layer is parameterized by. For the Vercel codec, this is `UIMessage`. Messages are the unit of state - what each node's projection yields via `getMessages()`, what the view's `getMessages()` returns, what React hooks render. The codec's [reducer](codec-interface.md#reducer-and-projection) bridges events → projection → `TMessage`; the encoder bridges `TMessage → wire` (for discrete publishes like user messages). See [Message lifecycle](message-lifecycle.md#tinput-toutput-tprojection-and-tmessage) for the full relationship.

## Message state

### Reducer

The codec's `init()` / `fold()` contract that assembles [decoder outputs](decoder.md#decoder-output) into complete domain messages. Needed because one domain message is built from many wire messages - a streamed assistant response may produce dozens of Ably messages (create + N appends + close) that must be folded into a single `TMessage`. Rather than a separate accumulator object, the codec folds each decoded event into an opaque per-node [TProjection](#tprojection) and exposes the assembled messages via `getMessages()`. `fold` is a pure function holding no instance state - all state lives in the projection. See [Reducer and projection](codec-interface.md#reducer-and-projection) for the full explanation.

### Message materialization

The act of producing a flat message list from the [conversation tree](conversation-tree.md). `view.getMessages()` returns the cached flat `CodecMessage<TMessage>[]` the UI renders — each message paired with its `codec-message-id`. The list is built by walking each visible node's `codec.getMessages(node.projection)` and concatenating the results. It is cached in the View and refreshes when the tree's structure changes (new nodes, deletions, selection changes, history reveal) or when a visible node's projection folds a new event. See [Message lifecycle](message-lifecycle.md#cached-message-list).

### Visible node chain

The View's cached chain of visible nodes (input nodes + reply runs), held as `ConversationNode<TProjection>[]`. The cache is rebuilt by the View's internal `_computeFlatNodes()`, which takes the Tree's `visibleNodes()` walk (kind-blind reachability and sibling selection already applied over `_sortedNodes`) and layers the View's pagination window on top by dropping currently withheld node keys. `getMessages()` consumes the cached chain and concatenates each node's `codec.getMessages(node.projection)` to produce the flat `CodecMessage<TMessage>[]`. See [Conversation tree: visible nodes](conversation-tree.md#visible-nodes-producing-the-visible-chain).

### TProjection

The opaque per-node codec state that the Tree folds events into. Each conversation node — a `RunNode` or a run-less `InputNode` — owns one `TProjection`, initialised via `codec.init()` and updated via `codec.fold(state, event, meta)`. The View extracts the per-message list from a projection via `codec.getMessages(projection)`. The SDK never inspects projection internals — it's the codec's contract surface.
