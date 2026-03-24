# Wire protocol

The AI Transport wire protocol defines what gets published on an Ably channel during a conversation. Every message carries headers in [`extras.headers`](glossary.md#extrasheaders-ably) that encode transport-level metadata (identity, lifecycle, branching) alongside domain-specific data from the codec.

The protocol has two header namespaces and two message types: [transport headers](#transport-headers-x-ably) (`x-ably-*`) vs [domain headers](#domain-headers-x-domain) (`x-domain-*`), and [lifecycle events](#lifecycle-events) vs [content messages](#content-messages). See the [glossary](glossary.md) for Ably-specific terms used throughout.

## Header namespaces

### Transport headers (`x-ably-*`)

Transport headers are set by the generic transport layer. They handle turn correlation, stream lifecycle, cancellation, and branching. The codec layer never reads or writes these — the transport layer owns them.

| Header | Values | Purpose |
|---|---|---|
| `x-ably-stream` | `"true"` / `"false"` | Whether this message uses the mutable message lifecycle |
| `x-ably-status` | `"streaming"` / `"finished"` / `"aborted"` | Current lifecycle state of a streamed message |
| `x-ably-stream-id` | string | Identity of the streamed message (correlates create → appends → close) |
| `x-ably-turn-id` | string | [Turn](glossary.md#turn-id-vs-message-id) correlation ID. Every message in a turn carries this |
| `x-ably-msg-id` | string | [Message identity](#message-identity-x-ably-msg-id). One per domain message (user or assistant). Used for [echo detection](#echo-detection) |
| `x-ably-turn-client-id` | string | ClientId of the user who initiated the turn |
| `x-ably-role` | `"user"` / `"assistant"` | Message role |
| `x-ably-parent` | msg-id | Preceding message in the branch (linear parent) |
| `x-ably-fork-of` | msg-id | Message being replaced (creates a fork in the conversation tree) |
| `x-ably-cancel-turn-id` | string | Cancel a specific turn |
| `x-ably-cancel-own` | `"true"` | Cancel all turns belonging to the sender |
| `x-ably-cancel-client-id` | string | Cancel all turns belonging to a specific clientId |
| `x-ably-cancel-all` | `"true"` | Cancel all turns on the channel |
| `x-ably-turn-reason` | `"complete"` / `"cancelled"` / `"error"` | Why a turn ended (on turn-end events) |

### Domain headers (`x-domain-*`)

Domain headers are set by the codec layer. They carry framework-specific metadata — field IDs, tool call IDs, provider metadata. The transport layer passes them through without interpreting them.

For the Vercel `UIMessageCodec`, domain headers include:

| Header | Purpose |
|---|---|
| `x-domain-id` | Chunk/message ID |
| `x-domain-toolCallId` | Tool call identifier |
| `x-domain-providerMetadata` | JSON-serialized provider metadata |
| `x-domain-finishReason` | Why the LLM stopped generating |
| `x-domain-error` | Error message |
| `x-domain-data` | JSON-serialized data payload (for `data-*` parts) |

The `x-domain-` prefix is defined in `constants.ts` as `DOMAIN_HEADER_PREFIX`. Codecs use `headerWriter()` and `headerReader()` utilities that automatically apply the prefix.

## Lifecycle events

Lifecycle events are published by the transport layer to coordinate turn state. They use Ably message `name` as the event type and carry metadata in headers. They have no `data` payload.

| Event name | Direction | Headers | Purpose |
|---|---|---|---|
| `x-ably-turn-start` | Server → Channel | `x-ably-turn-id`, `x-ably-turn-client-id` | Signal that a turn has started |
| `x-ably-turn-end` | Server → Channel | `x-ably-turn-id`, `x-ably-turn-client-id`, `x-ably-turn-reason` | Signal that a turn has ended |
| `x-ably-cancel` | Client → Channel | Cancel filter headers | Request cancellation of one or more turns |
| `x-ably-abort` | Server → Channel | — | Transport-level abort signal (stream cancelled) |
| `x-ably-error` | Server → Channel | — | Transport-level error signal |

## Content messages

Content messages carry domain data — user messages, assistant text, tool calls. They are published through Ably's message primitives and decoded by the codec layer.

### Discrete messages

A discrete message is a single, immutable Ably publish. It carries `x-ably-stream: "false"` and appears as a `message.create` action on the subscriber.

Used for: user messages, tool output, data parts, lifecycle events (start, finish, error).

```
Ably message:
  action: message.create
  name: "user-message"        (codec-defined message name)
  data: { ... }               (codec-defined payload)
  extras.headers:
    x-ably-stream: "false"
    x-ably-turn-id: "turn-1"
    x-ably-msg-id: "msg-1"
    x-ably-role: "user"
    x-domain-id: "ui-msg-1"   (codec-specific)
```

### Streamed messages

A streamed message uses Ably's [mutable message](glossary.md#mutable-message-ably) lifecycle — a single Ably message that evolves over time through create, append, and close [actions](glossary.md#message-actions-ably). It carries `x-ably-stream: "true"`.

The lifecycle has three states:

| Status | Meaning |
|---|---|
| `streaming` | Stream is active, more data expected |
| `finished` | Stream completed normally |
| `aborted` | Stream was cancelled |

A streamed message progresses through these Ably message actions:

```
1. message.create    x-ably-status: "streaming"     (open the stream)
2. message.append    (no status change)              (delta data)
   message.append    (no status change)              (delta data)
   ...
3. message.append    x-ably-status: "finished"       (close the stream)
```

On abort:

```
3. message.append    x-ably-status: "aborted"        (abort the stream)
```

The `data` field on the create is the initial content (often empty string). Each append carries a delta. The [decoder](decoder.md) accumulates deltas via string concatenation and uses [prefix-matching](decoder.md#known-serial-prefix-match) to detect whether an update is an incremental delta or a full replacement.

### Recovery via message.update

If an append fails (network issue, rate limit), the [encoder](encoder.md#recovery-mechanism) falls back to `message.update` with the full accumulated content. The [decoder](decoder.md#first-contact) handles this through first-contact detection — when it sees an update for an unknown serial, it treats it as if the stream just started (synthesizing start + delta + optional end events).

## Turn lifecycle over the wire

A complete turn produces this sequence on the channel:

```
Server                              Channel                              Clients
  |                                    |                                    |
  |-- publish turn-start ------------->|-- x-ably-turn-start ------------>|
  |                                    |                                    |
  |-- publish user messages ---------->|-- message.create (role:user) --->|
  |                                    |                                    |
  |-- publish stream start ----------->|-- message.create (streaming) --->|
  |-- publish stream appends --------->|-- message.append (delta) ------->|
  |-- publish stream appends --------->|-- message.append (delta) ------->|
  |-- publish stream close ----------->|-- message.append (finished) ---->|
  |                                    |                                    |
  |-- publish turn-end --------------->|-- x-ably-turn-end (complete) --->|
```

With cancellation:

```
Client A                           Channel                               Server
  |                                    |                                    |
  |-- publish x-ably-cancel ---------->|                                    |
  |                                    |--> cancel listener matches turn    |
  |                                    |                                    |
  |                                    |<-- message.append (aborted) -------|
  |                                    |<-- x-ably-turn-end (cancelled) ----|
```

## Message identity (`x-ably-msg-id`)

Every domain message — user or assistant — gets a unique `x-ably-msg-id` (a `crypto.randomUUID()`). This is the primary identity for a message throughout the system: the [conversation tree](conversation-tree.md) is indexed by it, the [accumulator](codec-interface.md#accumulator) routes streaming events by it, and [echo detection](#echo-detection) matches on it.

### Who generates it

| Scenario | Generator | Location |
|---|---|---|
| User message (optimistic) | Client transport `send()` | One UUID per message in the batch |
| User message (server echo) | Server transport `Turn.addMessages()` | One UUID per input; if the input already carries an `x-ably-msg-id` header (from the POST body), the existing value is kept |
| Assistant response | Server transport `Turn.pipeStream()` / `Turn.streamResponse()` | One UUID for the entire streamed response |

### How it's stamped

The msg-id flows through the header pipeline:

1. The transport calls `buildTransportHeaders({ msgId, ... })` which sets `headers['x-ably-msg-id'] = msgId`.
2. For **discrete messages** (user messages, tool output, lifecycle events), these headers are passed to the encoder via `WriteOptions.messageId`. The [encoder core's](encoder.md#header-merging) `_buildHeaders()` stamps it into the Ably message's `extras.headers`.
3. For **streamed messages** (assistant text, tool input), the msg-id is included in the persistent headers captured at `startStream()`. Every append — including the closing append — carries the same `x-ably-msg-id`, so the entire mutable message lifecycle shares one identity.

### How it's consumed

| Consumer | What it does with msg-id |
|---|---|
| [Decoder core](decoder.md#message-id-tagging) | Reads `x-ably-msg-id` from inbound message headers and tags every emitted `DecoderOutput` event with it |
| [Accumulator](codec-interface.md#accumulator) | Uses `output.messageId` to route decoded events to the correct in-progress domain message (e.g. the `UIMessage` being built). The msg-id becomes the `UIMessage.id` for assistant messages |
| [Conversation tree](conversation-tree.md#data-structures) | Uses msg-id as the primary key (`_nodeIndex`). Branching headers (`x-ably-parent`, `x-ably-fork-of`) reference other messages by their msg-id |
| [Echo detection](#echo-detection) | Matches returning messages to optimistic inserts (see below) |
| `regenerate()` / `edit()` | Look up the target message in the tree by msg-id to compute `forkOf`, `parent`, and truncated history |

### Echo detection

When a client calls `send()`, it inserts an optimistic message into the conversation tree (with no serial) and records the msg-id in an internal set. The server then publishes that message to the channel. When the client receives it back, it matches the echo by `x-ably-msg-id` and updates the optimistic entry with the server-assigned serial — [serial promotion](conversation-tree.md#upsert-the-sole-mutation) — rather than creating a duplicate.

## Branching headers

Branching uses two headers:

- `x-ably-parent` — points to the preceding message in the conversation. Establishes linear order at branch points.
- `x-ably-fork-of` — points to the message being replaced. Creates a sibling group in the conversation tree.

When a user calls `regenerate(msgId)`, the new assistant message carries `x-ably-fork-of: msgId`. When a user calls `edit(msgId, newMessages)`, the new user message carries `x-ably-fork-of: msgId`. The [conversation tree](conversation-tree.md#sibling-groups-and-fork-chains) uses these to build sibling groups — alternative responses at the same point in the conversation.

In linear sequences (no branching), `x-ably-parent` establishes ordering. Serial-based ordering handles the common case; parent headers are only structurally meaningful at branch points.

## Header persistence on appends

Ably replaces the entire `extras` object on each append. The encoder must repeat all persistent headers (transport + domain) on every append, including the closing append. This is handled internally by the [encoder core](encoder.md), which captures headers from `startStream()` and replays them on every subsequent append and close.

See [Encoder](encoder.md) and [Decoder](decoder.md) for how the mutable message lifecycle is implemented. See [Codec interface](codec-interface.md) for how domain headers are mapped by framework-specific codecs. See [Conversation tree](conversation-tree.md) for how branching headers are used to build the message tree.
