# Glossary

Quick definitions for terms used across the internals docs. Ably-specific concepts are marked with **(Ably)**.

## Ably primitives

### Serial **(Ably)**

A lexicographically sortable string identifier that Ably assigns to every message on acceptance. Serials can be compared lexicographically to produce a total order over messages. However, this is not necessarily the order in which messages are delivered to subscribers - the only delivery-order guarantee is that messages published sequentially on the same realtime connection are always delivered in that same relative order, but they may interleave with messages published concurrently from other connections. The [conversation tree](conversation-tree.md) uses serials as the primary ordering mechanism, and the [decoder](decoder.md) uses them to correlate appends back to the originating message.

### Message actions **(Ably)**

Ably supports updates, deletes, and appends on messages after publication. The AI Transport SDK uses **message appends** to stream LLM tokens - a message is created with a `publish` (which returns a serial), then receives `appendMessage` calls that add data incrementally, and ends with a closing append that sets the final state. Each token is appended to a single persistent message rather than published as a separate message.

The alternative is a **discrete message** - a single publish with no subsequent appends. User messages, tool output, and lifecycle events are discrete.

### Message actions **(Ably)**

The four operations that can happen to an Ably message:

| Action           | Meaning                                             |
| ---------------- | --------------------------------------------------- |
| `message.create` | A new message was published                         |
| `message.append` | Data was appended to an existing message             |
| `message.update` | An existing message's content was replaced entirely |
| `message.delete` | A message was deleted                               |

Subscribers receive these as the `action` field on inbound messages. The [decoder](decoder.md#action-dispatch) switches on this field to determine how to process each message.

### Channel attach **(Ably)**

The act of connecting to an Ably channel. A channel transitions from `initialized` → `attaching` → `attached`. Once attached, the client receives live messages published to the channel. The client transport subscribes to the channel before calling `attach()` to ensure no messages are lost during the attach process.

### untilAttach **(Ably)**

A parameter on Ably's `channel.history()` API that fetches messages up to the exact point where the channel was attached. This guarantees **gapless continuity** - history ends precisely where the live subscription begins, with no duplicates and no gaps. See [History hydration](history.md#channel-attach-and-untilattach).

### extras.headers **(Ably)**

Every Ably message has an `extras` field that can carry metadata. The AI Transport protocol stores all its headers in `extras.headers` - a `Record<string, string>` of key-value pairs. Both [transport headers](wire-protocol.md#transport-headers-x-ably) (`x-ably-*`) and [domain headers](wire-protocol.md#domain-headers-x-domain) (`x-domain-*`) live here.

## Transport architecture

### Transport layer vs domain layer

The SDK has two layers with a strict boundary:

- **Transport layer** - generic machinery shared by all codecs. Handles turn lifecycle, stream routing, optimistic reconciliation, cancel signals, and conversation tree management. Uses `x-ably-*` headers. Lives in `src/core/transport/`.
- **Domain layer** - framework-specific encoding/decoding. Maps between domain events (e.g. Vercel's `UIMessageChunk`) and Ably messages. Uses `x-domain-*` headers. Lives in codec implementations (e.g. `src/vercel/codec/`).

The [codec interface](codec-interface.md) is the boundary between these layers.

### Own turn vs observer turn

When the client transport receives messages from the channel, it routes them differently depending on who started the turn:

- **Own turn** - a turn this client initiated (via `send()`, `regenerate()`, `edit()`). Decoded events are routed to **both** the [stream router](transport-components.md#streamrouter) (which enqueues them on a `ReadableStream`) and a per-turn [accumulator](codec-interface.md#accumulator) (which builds complete messages for the [conversation tree](conversation-tree.md)). The stream exists primarily as an integration seam for framework adapters (e.g. Vercel's `useChat`); most application code consumes accumulated messages via `getMessages()`.
- **Observer turn** - a turn started by another client. Decoded events go to the accumulator only - there is no stream because no caller on this client initiated the turn.

Both paths use the same accumulation logic. The only difference is that own turns additionally expose a `ReadableStream` for framework integration. See [Message lifecycle](message-lifecycle.md#own-turns-vs-observer-turns) for the full routing picture.

### Turn ID vs message ID

Two different identity headers serve different purposes:

- **Turn ID** (`x-ably-turn-id`) - groups all messages in one request-response cycle. A single turn may produce multiple messages (user message, assistant text, tool calls, lifecycle events). Used for cancellation scope, active turn tracking, and stream routing.
- **Message ID** (`x-ably-msg-id`) - uniquely identifies a single domain message (a `crypto.randomUUID()` generated by the client or server transport). Used for [optimistic reconciliation](wire-protocol.md#optimistic-reconciliation), [accumulator routing](codec-interface.md#accumulator), and [conversation tree](conversation-tree.md) node identity. For streamed messages, every append carries the same msg-id so the entire message append lifecycle shares one identity.

A turn contains one or more messages. A message belongs to exactly one turn. See [Wire protocol: message identity](wire-protocol.md#message-identity-x-ably-msg-id) for the full lifecycle.

## Encoding/decoding concepts

### Terminal event

An event that signals the end of a stream. For the Vercel codec, terminal events are `finish`, `error`, and abort signals. The [stream router](transport-components.md#terminal-detection) uses the codec's `isTerminal()` predicate to automatically close the `ReadableStream` when a terminal event arrives. The [decoder](decoder.md#append-handling) checks `x-ably-status` for `"finished"` or `"aborted"` to detect terminal state on the wire.

### Fire-and-forget

An async operation where the caller does not `await` the result. The promise is collected but errors are handled later in batch (or logged and discarded). The [encoder](encoder.md#appendstream) uses fire-and-forget for append operations - each token delta is sent without waiting for acknowledgement, and failures are caught during [flush](encoder.md#recovery-mechanism). The client transport's HTTP POST is also fire-and-forget - the stream is available immediately from the channel subscription, not the HTTP response.

### Prefix-match

The [decoder's](decoder.md#known-serial-prefix-match) strategy for handling `message.update` on a tracked stream. When an update arrives, the decoder checks: does the new data start with the text already accumulated? If yes (prefix match), it extracts just the new delta (`data.slice(accumulated.length)`) and emits delta events. If no (not a prefix), the message was fully replaced (e.g. [encoder recovery](encoder.md#recovery-mechanism)) and the decoder resets its tracker.

### First-contact

When the [decoder](decoder.md#first-contact) receives an update for a serial it has never seen - the stream started before this client subscribed (e.g. history, reconnect, late join). The decoder synthesizes the full event sequence from the update: start events, delta events (if data is present), and end events (if status is `"finished"`). This allows late-joining clients to reconstruct the stream state.

### Optimistic reconciliation

When a client calls `send()`, it inserts an optimistic message into the conversation tree (with no serial). The server then relays that message onto the channel, and all clients - including the sender - receive it. The sending client matches the relayed message by `x-ably-msg-id` and reconciles the optimistic entry with the server-assigned serial ([serial promotion](conversation-tree.md#upsert-the-sole-mutation)) rather than creating a duplicate.

## Conversation tree concepts

### Group root

The original message in a [sibling group](conversation-tree.md#sibling-groups-and-fork-chains) - the message at the root of the `forkOf` chain. When messages fork the same target transitively (A → B forks A, C forks B), the group root is A. Sibling selections are stored by the group root's `msgId`.

### Serial promotion

When an optimistic message (null serial) receives a server-assigned serial via [optimistic reconciliation](#optimistic-reconciliation), the conversation tree removes it from its current position (end of the sorted list) and re-inserts it at the correct serial-order position. See [conversation tree upsert](conversation-tree.md#upsert-the-sole-mutation).

## Type parameters

### TEvent

The streaming fragment type that the generic layer is parameterized by. For the Vercel codec, this is `UIMessageChunk`. Events are the unit of real-time streaming - individually meaningless fragments (a text delta, a tool-input start signal, a finish event) that must be accumulated into a complete message. The [decoder](decoder.md) produces events; the [stream router](transport-components.md) delivers them to own-turn consumers; the [accumulator](codec-interface.md#accumulator) assembles them into `TMessage` instances.

### TMessage

The complete domain message type that the generic layer is parameterized by. For the Vercel codec, this is `UIMessage`. Messages are the unit of state - what the [conversation tree](conversation-tree.md) stores, what `getMessages()` returns, what React hooks render. The [accumulator](codec-interface.md#accumulator) bridges `TEvent → TMessage`; the encoder bridges `TMessage → wire` (for discrete publishes like user messages). See [Message lifecycle](message-lifecycle.md#tevent-and-tmessage) for the full relationship.

## Message state

### Message accumulator

A codec-provided component that assembles [decoder outputs](decoder.md#decoder-output-types) into complete domain messages. Needed because one domain message is built from many wire messages - a streamed assistant response may produce dozens of Ably messages (create + N appends + close) that must be assembled into a single `TMessage`. Used in two contexts: live [observer turns](glossary.md#own-turn-vs-observer-turn) (working buffer, snapshots upserted into tree on every event) and [history decoding](history.md) (collect only completed messages). See [Accumulator](codec-interface.md#accumulator) for the full explanation.

### Message materialization

The act of producing a flat message list from the [conversation tree](conversation-tree.md) via [`flattenNodes()`](#flatten). `flattenNodes()` returns `ConversationNode<TMessage>[]` - the transport's `getMessages()` extracts `.message` from each node to produce the public `TMessage[]`. Every call rebuilds from scratch - there is no cached list - because the result depends on branch selection state. All consumers go through `getMessages()`, which delegates to `flattenNodes()`: React hooks, `send()` (for the HTTP POST body), `history()` (for pagination snapshots). See [Message lifecycle](message-lifecycle.md#why-no-cached-message-list).

### Flatten

`ConversationTree.flattenNodes()` - the sole path from tree state to a message array. Walks the sorted node list, checks parent reachability and sibling selection, and returns the linear message sequence for the currently selected conversation path. See [Conversation tree: flatten](conversation-tree.md#flatten-producing-the-linear-path).
