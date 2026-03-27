# Client transport

The client transport (`src/core/transport/client/client-transport.ts`) manages the full client-side conversation lifecycle over a single Ably channel. It composes a [stream router](transport-components.md#streamrouter), [conversation tree](conversation-tree.md), and codec [decoder](decoder.md)/[accumulator](codec-interface.md#accumulator) to handle sending messages, receiving streamed responses, managing conversation state, and supporting branching operations (edit, regenerate).

The client never publishes domain messages directly to the channel. Instead, it sends them to the server via HTTP POST. The server publishes user messages and [turn lifecycle events](wire-protocol.md#lifecycle-events) on behalf of the client. The channel subscription is the sole source of truth for conversation state.

## Composition

```
DefaultClientTransport
├── ConversationTree       - branching message history (flatten → getMessages)
├── StreamRouter           - maps turn events to per-turn ReadableStreams
├── StreamDecoder          - decodes inbound Ably messages to events/messages
├── EventEmitter           - typed event bus for message/turn/error/ably-message
└── per-turn state maps    - observer headers, accumulators, relay detection
```

All sub-components are created in the constructor and share a single Ably channel. The transport subscribes to the channel before attach ([RTL7g](https://sdk.ably.com/builds/ably/specification/main/features/#RTL7g)) to guarantee no messages are missed.

## Send flow

`send()` is the primary entry point for starting a new turn. It handles optimistic insertion, HTTP POST dispatch, and stream creation in a specific order:

1. **Generate identifiers** - a turn ID and per-message msg-ids (`crypto.randomUUID()`)
2. **Auto-compute parent** - if no explicit `parent` or `forkOf` is provided, reads the last message in the [flattened tree](conversation-tree.md#flatten-producing-the-linear-path) to chain messages into a linear thread
3. **Optimistic insert** - each user message is inserted into the conversation tree immediately with [transport headers](wire-protocol.md#transport-headers-x-ably) (role, turn ID, msg-id, parent). This makes the message visible to `getMessages()` before the server acknowledges it
4. **Create stream** - the [stream router](transport-components.md#streamrouter) creates a `ReadableStream` for the turn, capturing the controller synchronously
5. **Fire-and-forget POST** - the HTTP POST is dispatched without `await` so the stream is returned immediately. POST errors are surfaced via the `error` event, not thrown
6. **Return `ActiveTurn`** - the caller receives `{ stream, turnId, cancel() }` synchronously

The POST body includes `history` (all messages before the optimistic inserts), `messages` (the new messages with headers), `turnId`, and `clientId`.

### Multi-message chaining

When `send()` receives multiple messages, it chains them into a linear thread: each message after the first uses the previous message's msg-id as its `parent`. This produces a connected sequence rather than siblings at the same fork point.

## Optimistic reconciliation

When the server relays user messages back onto the channel, the client receives them like any other message. The transport detects own-message relays by matching the `x-ably-msg-id` against the set of optimistically inserted msg-ids (`_ownMsgIds`).

On relay match, the transport upserts the message with the server-assigned [serial](glossary.md#serial-ably), which triggers [serial promotion](glossary.md#serial-promotion) in the conversation tree - the optimistic entry (null serial, sorted last) moves to its correct position in serial order.

## Message routing

The channel subscription handler (`_handleMessage`) processes every inbound Ably message:

### Turn lifecycle events

- **`x-ably-turn-start`** - records the turn's clientId, emits a `turn` event
- **`x-ably-turn-end`** - closes the stream router entry, cleans up observer state and relay-detection state, emits a `turn` event

### Codec-decoded messages

All other messages pass through the codec decoder. Each `DecoderOutput` is routed based on its `kind`:

- **`message` outputs** - user messages or discrete content. Upserted into the conversation tree (with relay detection for own messages)
- **`event` outputs** - streaming fragments. Routed by turn ownership:

| Turn type | Stream router | Accumulator | Tree upsert |
|---|---|---|---|
| [Own turn](glossary.md#own-turn-vs-observer-turn) (active stream) | Enqueued | Processed, snapshot upserted | On every event |
| Own turn (stream closed) | Skipped | Skipped | No |
| [Observer turn](glossary.md#own-turn-vs-observer-turn) | No stream exists | Processed, snapshot upserted | On every event |

### Observer accumulation

For both own and observer turns, the transport maintains a `TurnObserverState` that tracks:

- **headers** - accumulated from every event in the turn (later headers override earlier ones)
- **serial** - advances on every event, so the tree node always sorts after earlier messages in the turn
- **accumulator** - a codec-provided [MessageAccumulator](codec-interface.md#accumulator) that builds complete domain messages from streaming events

On every event, the transport calls `accumulator.processOutputs()`, clones the latest message, and upserts it into the conversation tree. This is why `getMessages()` updates in real-time during streaming - even for observer turns where no `ReadableStream` exists.

## Regenerate and edit

`regenerate(messageId)` and `edit(messageId, newMessages)` are convenience methods that delegate to `send()` with computed branching metadata:

- **`forkOf`** - the msg-id of the message being replaced
- **`parent`** - the parent of the forked message in the tree
- **`history`** - messages truncated before the fork point (the LLM doesn't see the response being replaced)

The conversation tree handles the fork: the new message becomes a sibling of the original, and branch selection determines which path `flatten()` returns. See [Conversation tree](conversation-tree.md) for the branching mechanics.

## Cancel

`cancel(filter?)` publishes a cancel message to the channel and closes matching local streams. The filter defaults to `{ own: true }` (all turns started by this client). See [Transport components: cancel routing](transport-components.md#cancel-routing-server-transport) for how the server processes cancel messages.

Closing the stream router entry does **not** clear the observer state - late server events (e.g. abort status, final metadata) arriving before `turn-end` are still accumulated into the conversation tree.

## History

`history()` loads older messages from the Ably channel using [`untilAttach`](glossary.md#untilattach-ably) for gapless continuity with the live subscription. Pages are decoded through the codec and upserted into the conversation tree.

The transport implements a **withholding** mechanism for pagination: newly loaded messages are initially hidden from `getMessages()`. The newest batch is released immediately, while older messages are buffered and released in subsequent `next()` calls. This prevents the UI from jumping to show hundreds of messages at once.

## Close

`close()` tears down all transport state:

1. Optionally publishes a cancel message (if `options.cancel` is set)
2. Unsubscribes from the channel
3. Closes all active stream router entries
4. Clears observer state, event handlers, relay detection state, and the Ably message log

After close, all methods that create turns throw `TransportClosed`. Event subscriptions return no-op unsubscribe functions.

## Events

| Event | Payload | When |
|---|---|---|
| `message` | (none) | Tree state changed - call `getMessages()` for current state |
| `turn` | `TurnLifecycleEvent` | Turn started or ended (includes turnId, clientId, reason) |
| `error` | `Ably.ErrorInfo` | Non-fatal error (HTTP POST failure, subscription error) |
| `ably-message` | (none) | Raw Ably message added - call `getAblyMessages()` for current state |

See [Transport concept](../concepts/transport.md) for the public API perspective. See [Transport components](transport-components.md) for the sub-component internals. See [Message lifecycle](message-lifecycle.md) for the end-to-end message flow.
