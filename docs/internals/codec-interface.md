# Codec interface

The codec is the boundary between the [transport layer and domain layer](glossary.md#transport-layer-vs-domain-layer). It defines how domain events (e.g. Vercel's `UIMessageChunk`) map to and from Ably messages. The transport is parameterized by `Codec<TEvent, TMessage>` — swap the codec and the same transport works with a different AI framework.

## The Codec interface

```typescript
interface Codec<TEvent, TMessage> {
  createEncoder(channel: ChannelWriter, options?: EncoderOptions): StreamEncoder<TEvent, TMessage>;
  createDecoder(): StreamDecoder<TEvent, TMessage>;
  createAccumulator(): MessageAccumulator<TEvent, TMessage>;
  isTerminal(event: TEvent): boolean;
  getMessageKey(message: TMessage): string;
}
```

| Method              | Purpose                                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createEncoder`     | Creates a [streaming encoder](encoder.md) that maps domain events to Ably publish operations                                                                      |
| `createDecoder`     | Creates a [decoder](decoder.md) that converts inbound Ably messages to domain events/messages                                                                     |
| `createAccumulator` | Creates an accumulator that builds complete messages from streaming events                                                                                        |
| `isTerminal`        | Returns true if an event signals stream completion (finish, error, abort). Used by the [stream router](transport-components.md#terminal-detection) to auto-close streams |
| `getMessageKey`     | Returns a stable [codec key](glossary.md#codec-key) for a domain message (used by the [conversation tree](conversation-tree.md) for upsert)                       |

## How the transport uses the codec

### Server transport

The server transport uses `createEncoder()` to get a `StreamEncoder`. For each turn:

1. `writeMessages()` — publishes user messages as discrete Ably messages
2. `appendEvent()` — streams LLM response events as message appends
3. `close()` / `abort()` — finalizes the stream

The encoder translates domain events into [encoder core](encoder.md#stream-lifecycle) operations (`startStream`, `appendStream`, `closeStream`). The encoder core handles Ably primitives.

### Client transport

The client transport uses:

- `createDecoder()` — decodes inbound Ably messages into domain events and messages
- `createAccumulator()` — builds complete messages from events (for [observer turns](glossary.md#own-turn-vs-observer-turn) — other clients' streams)
- `isTerminal()` — tells the [stream router](transport-components.md#terminal-detection) when to close a per-turn ReadableStream
- `getMessageKey()` — provides the [conversation tree's](conversation-tree.md#data-structures) secondary index key

## Encoder architecture

A domain encoder composes the encoder core rather than extending it:

```
Domain Encoder (e.g. UIMessageEncoder)
  └── EncoderCore
        └── ChannelWriter (Ably channel)
```

The domain encoder maps events to core operations:

| Domain event (Vercel)            | Core operation                                         |
| -------------------------------- | ------------------------------------------------------ |
| `text-start`                     | `core.startStream(id, { name: 'text' })`               |
| `text-delta`                     | `core.appendStream(id, delta)`                         |
| `text-end`                       | `core.closeStream(id, payload)`                        |
| `tool-input-start`               | `core.startStream(toolCallId, { name: 'tool-input' })` |
| `tool-input-delta`               | `core.appendStream(toolCallId, delta)`                 |
| `tool-input-available`           | `core.closeStream(toolCallId, payload)`                |
| `start`, `finish`, `error`, etc. | `core.publishDiscrete(payload)`                        |

The [encoder core](encoder.md) handles all Ably-specific concerns: serial tracking, append queuing, [flush/recovery](encoder.md#recovery-mechanism), [header persistence](encoder.md#closing-appends-repeat-all-headers).

## Decoder architecture

A domain decoder provides hooks to the decoder core:

```
DecoderCore
  ├── buildStartEvents(tracker)    → domain-specific start events
  ├── buildDeltaEvents(tracker, δ) → domain-specific delta events
  ├── buildEndEvents(tracker, h)   → domain-specific end events
  └── decodeDiscrete(payload)      → domain-specific messages/events
```

The [decoder core](decoder.md) handles [action dispatch](decoder.md#action-dispatch), serial tracking, and [prefix-match accumulation](decoder.md#known-serial-prefix-match). The hooks transform stream state into domain events without knowing about Ably message actions.

## Accumulator

The accumulator assembles complete domain messages (`TMessage`) from streaming decoder outputs (`TEvent`). It exists because the decoder produces individually meaningless fragments — a `text-delta` is not a message — and the assembly logic is codec-specific. The transport is generic and cannot know how to build a `UIMessage` from `UIMessageChunk` events, so the codec provides an accumulator that does.

See [Message lifecycle](message-lifecycle.md) for how the accumulator fits into the full data flow from wire to UI.

```typescript
interface MessageAccumulator<TEvent, TMessage> {
  processOutputs(outputs: DecoderOutput<TEvent, TMessage>[]): void;
  updateMessage(message: TMessage): void;
  readonly messages: TMessage[];
  readonly completedMessages: TMessage[];
  readonly hasActiveStream: boolean;
}
```

### Why a list, not a single message

A single turn can produce multiple domain messages. For example, a Vercel turn produces both the user message (via `writeMessages`, which emits a `kind: 'message'` output) and the assistant message (built from streaming `kind: 'event'` outputs). The accumulator tracks all messages within its scope.

### Two usage contexts

The transport creates accumulators in two situations, and reads different properties from each:

**Live streaming (observer turns):** When another client's turn is streaming, the transport creates a per-turn accumulator and feeds decoded events into it. After each event, the transport reads **`messages`** to get the latest in-progress snapshot — including partially-built messages still receiving data — and upserts it into the [conversation tree](conversation-tree.md). The accumulator is a working buffer; the tree is the source of truth.

**History decoding:** When loading [history](history.md), each turn gets its own accumulator. After replaying all wire messages through the decoder, the transport reads **`completedMessages`** — only messages whose streams have terminated (finish, abort, error). Partial messages at page boundaries are excluded until more history pages are fetched. Each turn needs a separate accumulator because events from interleaved concurrent turns would corrupt each other's message assembly.

### Properties

| Property            | Returns                                     | Used by                                                |
| ------------------- | ------------------------------------------- | ------------------------------------------------------ |
| `messages`          | All messages, including in-progress         | Live streaming — shows partial state while streaming   |
| `completedMessages` | Only messages with no active streams        | History — only fully terminated messages should appear |
| `hasActiveStream`   | Whether any message is still receiving data | Transport — detects when a turn is complete            |

### Identity and ownership

The accumulator does not own message identity. The transport assigns [`x-ably-msg-id`](wire-protocol.md#message-identity-x-ably-msg-id) and headers; the accumulator routes events to the correct in-progress message using the `messageId` field on decoder event outputs. The accumulator builds the domain object — the transport handles identity, headers, and tree placement.

## Lifecycle tracker

The lifecycle tracker (`src/core/codec/lifecycle-tracker.ts`) handles mid-stream joins. When a client connects mid-stream (or loads from [history](history.md)), the decoder may see delta events without the preceding start event — the [first-contact path](decoder.md#first-contact) handles the stream-level reconstruction, but the lifecycle tracker ensures all _codec-level_ phases are emitted in order.

```typescript
interface LifecycleTracker<TEvent> {
  ensurePhases(scopeId: string, context: Record<string, string | undefined>): TEvent[];
  markEmitted(scopeId: string, phaseKey: string): void;
  resetPhase(scopeId: string, phaseKey: string): void;
  clearScope(scopeId: string): void;
}
```

Configured with an ordered list of phases (e.g. `["start", "start-step"]`). When `ensurePhases()` is called, it checks which phases have been emitted for the scope and synthesizes missing ones using codec-provided build functions.

For the Vercel codec, this means: if a client joins a stream after `text-start` was published, the tracker synthesizes a `start` chunk so the Vercel UI message lifecycle is complete. See [Lifecycle tracker](lifecycle-tracker.md) for the full internals.

## Vercel UIMessageCodec

The Vercel codec (`src/vercel/codec/`) is the concrete implementation for the Vercel AI SDK. It maps between `UIMessageChunk` events and `UIMessage` messages.

### Event mapping

| UIMessageChunk type                          | Wire representation                                      |
| -------------------------------------------- | -------------------------------------------------------- |
| `text-start`                                 | Streamed message create (name: `"text"`)                 |
| `text-delta`                                 | Streamed message append                                  |
| `text-end`                                   | Streamed message close (status: `"finished"`)            |
| `tool-input-start`                           | Streamed message create (name: `"tool-input"`)           |
| `tool-input-delta`                           | Streamed message append                                  |
| `tool-input-available`                       | Streamed message close or discrete (if no active stream) |
| `start`, `finish`, `error`                   | Discrete message                                         |
| `tool-output-available`, `tool-output-error` | Discrete message                                         |
| `data-*`                                     | Discrete message                                         |

### Domain headers

The Vercel codec uses [`x-domain-*` headers](wire-protocol.md#domain-headers-x-domain) to carry Vercel-specific metadata:

- `x-domain-id` — chunk/message ID
- `x-domain-toolCallId` — tool call identifier
- `x-domain-providerMetadata` — JSON-serialized `ProviderMetadata`
- `x-domain-finishReason` — why the LLM stopped
- `x-domain-error` — error message
- `x-domain-data` — JSON-serialized data payload

These headers are read/written using `headerReader()` and `headerWriter()` utilities that automatically prefix keys with `x-domain-`. See [Headers](headers.md) for the full reader/writer API.

## Writing a new codec

To support a new AI framework, implement the `Codec<TEvent, TMessage>` interface:

1. **Define TEvent and TMessage** — the framework's streaming event and accumulated message types
2. **Implement the encoder** — map domain events to encoder core operations (startStream, appendStream, closeStream, publishDiscrete)
3. **Implement the decoder hooks** — build domain events from stream tracker state
4. **Implement the accumulator** — build complete messages from decoder outputs
5. **Implement isTerminal** — identify events that close a stream
6. **Implement getMessageKey** — return a stable identity for each message

See [Vercel codec](vercel-codec.md) for the concrete Vercel implementation details. See [Encoder](encoder.md) for the encoder core that domain encoders delegate to. See [Decoder](decoder.md) for the decoder core and its hook interface. See [Wire protocol](wire-protocol.md) for the transport vs domain header discipline.
