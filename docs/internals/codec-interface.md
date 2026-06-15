# Codec interface

The codec is the boundary between the [transport layer and domain layer](glossary.md#transport-layer-vs-domain-layer). It defines how domain events map to and from Ably messages, and how those events fold into the per-node state the conversation tree reads. The session is parameterized by `Codec<TInput, TOutput, TProjection, TMessage>` - swap the codec and the same session works with a different AI framework.

## The Codec interface

The codec is an [event-sourced](glossary.md) reducer. It extends `Reducer<TInput | TOutput, TProjection>` (the `init()` / `fold()` pair) and adds encoder/decoder factories plus the input-construction helpers:

```typescript
interface Codec<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> extends Reducer<TInput | TOutput, TProjection> {
  // from Reducer
  init(): TProjection;
  fold(state: TProjection, event: TInput | TOutput, meta: ReducerMeta): TProjection;

  // wire mapping
  createEncoder(channel: ChannelWriter, options?: EncoderOptions): Encoder<TInput, TOutput>;
  createDecoder(): Decoder<TInput, TOutput>;

  // projection → messages
  getMessages(projection: TProjection): CodecMessage<TMessage>[];

  // well-known input construction
  createUserMessage(message: TMessage): TInput;
  createRegenerate(target: string, parent: string): TInput;
  createToolResult?(codecMessageId: string, payload: ToolResultPayloadOf<TInput>): TInput;
  createToolResultError?(codecMessageId: string, payload: ToolResultErrorPayloadOf<TInput>): TInput;
  createToolApprovalResponse?(codecMessageId: string, payload: ToolApprovalResponsePayloadOf<TInput>): TInput;
}
```

| Method                              | Purpose                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------- |
| `init()`                            | Builds an empty per-node `TProjection` (from `Reducer`)                                     |
| `fold()`                            | Folds one `TInput` / `TOutput` event into the projection (from `Reducer`)                   |
| `createEncoder()`                   | Creates an [encoder](encoder.md) that maps domain events to Ably publish operations         |
| `createDecoder()`                   | Creates a [decoder](decoder.md) that converts inbound Ably messages to typed inputs/outputs |
| `getMessages()`                     | Extracts `TMessage[]` (each paired with its `codec-message-id`) from a projection           |
| `createUserMessage()`               | Wraps a `TMessage` as the well-known `user-message` input variant                           |
| `createRegenerate()`                | Builds the well-known `regenerate` input variant                                            |
| `createToolResult?()` / `…Error?()` | Optional: build tool-result inputs (only codecs whose `TInput` includes the variant)        |
| `createToolApprovalResponse?()`     | Optional: build the tool-approval-response input variant                                    |

`TInput` is the union of input variants the client publishes on the `ai-input` wire (each extends `CodecInputEvent`, discriminated by `kind`); `TOutput` is the union of agent-published output variants on the `ai-output` wire (each extends `CodecOutputEvent`, discriminated by `type`). `TProjection` is the opaque per-node state the reducer folds into - the SDK never inspects it directly. `TMessage` is the per-message domain object the tree consumes.

## How the session uses the codec

### Agent session

The agent session uses `createEncoder()` to get an `Encoder<TInput, TOutput>`. The encoder exposes two direction-typed publish methods - `publishInput()` for client-originated inputs on the `ai-input` wire and `publishOutput()` for agent-originated outputs on the `ai-output` wire - plus `cancel()` and `close()`. A run streams its response by pushing each `TOutput` through `publishOutput()`.

Internally the encoder translates streamed events into [encoder core](encoder.md#stream-lifecycle) operations (`startStream()`, `appendStream()`, `closeStream()`) and discrete events into `publishDiscrete()`. The encoder core handles Ably primitives.

### Client session

The client session uses:

- `createDecoder()` - decodes inbound Ably messages into `{ inputs, outputs }` via `DecodedMessage`
- `init()` / `fold()` - folds each decoded event (with its `ReducerMeta` serial and `messageId`) into the owning node's projection
- `getMessages()` - extracts the message list from the projection to populate the [conversation tree](conversation-tree.md)

## Encoder architecture

A domain encoder composes the encoder core rather than extending it:

```
Domain Encoder (e.g. UIMessageEncoder)
  └── EncoderCore
        └── ChannelWriter (Ably channel)
```

The domain encoder maps events to core operations:

| Domain event (Vercel)            | Core operation                  |
| -------------------------------- | ------------------------------- |
| `text-start`                     | `core.startStream(id, payload)` |
| `text-delta`                     | `core.appendStream(id, delta)`  |
| `text-end`                       | `core.closeStream(id, payload)` |
| `start`, `finish`, `error`, etc. | `core.publishDiscrete(payload)` |

Every Vercel event publishes under the single `ai-output` wire name (`EVENT_AI_OUTPUT`); the chunk's own type (`text`, `reasoning`, `tool-input`, …) travels in the codec `type` [codec header](wire-protocol.md#codec-headers) so the decoder can dispatch.

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

## Reducer and projection

The decoder produces individually meaningless fragments - a `text-delta` is not a message - and the assembly logic is codec-specific. Rather than a separate accumulator object, the codec folds events into an opaque per-node `TProjection` via the `Reducer` half of its contract (`init()` and `fold()`), then exposes the assembled messages via `getMessages()`.

See [Message lifecycle](message-lifecycle.md) for how the reducer fits into the full data flow from wire to UI.

```typescript
interface Reducer<TEvent, TProjection> {
  init(): TProjection;
  fold(state: TProjection, event: TEvent, meta: ReducerMeta): TProjection;
}
```

`fold` is a pure function: the same `(state, event, meta)` triple always produces the same result, and the reducer holds no instance state - all state lives in the projection. `fold` may mutate the projection passed in and return it; the caller treats the projection as single-owner.

### ReducerMeta — transport-derived metadata

Each fold call carries a `ReducerMeta` the SDK reads from the inbound Ably message:

```typescript
interface ReducerMeta {
  serial: string;
  messageId?: string;
}
```

- `serial` is the Ably channel serial of the message that produced the event. The reducer uses it for idempotency: re-folding an event whose serial has already been incorporated must be a no-op (the reducer is free to store a high-water-mark inside the projection).
- `messageId` is the optional [`codec-message-id`](wire-protocol.md#message-identity-codec-message-id) of the inbound message, used to route an event onto a target message within the projection (e.g. to amend an existing assistant message with a tool result).

### Why a list, not a single message

A single run can produce multiple domain messages. For example, a Vercel run produces both the user message and the streamed assistant message. `getMessages()` returns a `CodecMessage<TMessage>[]` - each message paired with the `codec-message-id` that identifies it on the wire:

```typescript
interface CodecMessage<TMessage> {
  codecMessageId: string;
  message: TMessage;
}
```

### Identity and ownership

The reducer does not own message identity. The SDK assigns [`codec-message-id`](wire-protocol.md#message-identity-codec-message-id) and headers and supplies them via `ReducerMeta`; `getMessages()` returns each domain object paired with its `codecMessageId`. All internal correlation - tree indexing, parent/fork/regenerate routing, branch grouping - keys on `codecMessageId`, never on the message's own identity. `message` is reconstructed verbatim from the source values and surfaced to the application unchanged.

## Lifecycle tracker

The lifecycle tracker (`src/core/codec/lifecycle-tracker.ts`) handles mid-stream joins. When a client connects mid-stream (or loads from [history](history.md)), the decoder may see delta events without the preceding start event - the [first-contact path](decoder.md#first-contact) handles the stream-level reconstruction, but the lifecycle tracker ensures all _codec-level_ phases are emitted in order.

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

All Vercel events publish under the `ai-output` wire name, with the chunk type carried in the codec `type` header.

| UIMessageChunk type        | Wire representation                           |
| -------------------------- | --------------------------------------------- |
| `text-start`               | Streamed message create (`type: "text"`)      |
| `text-delta`               | Streamed message append                       |
| `text-end`                 | Streamed message close (status: `"complete"`) |
| `start`, `finish`, `error` | Discrete message                              |
| `data-*`                   | Discrete message                              |

### Codec headers

The Vercel codec uses [codec headers](wire-protocol.md#codec-headers) (under `extras.ai.codec`) to carry Vercel-specific metadata:

- `type` - the codec event type (e.g. `text`, `reasoning`, `tool-input`), used by the decoder to dispatch
- `id` - chunk/part ID
- `providerMetadata` - JSON-serialized `ProviderMetadata`
- `finishReason` - why the LLM stopped (on `finish`)

Error text and `data-*` payloads ride in the message `data`, not in a header. These headers are written and read with the `headerWriter()` and `headerReader()` utilities over the bare codec-tier keys. See [Headers](headers.md) for the full reader/writer API.

## Writing a new codec

To support a new AI framework, implement the `Codec<TInput, TOutput, TProjection, TMessage>` interface:

1. **Define the type parameters** - the input/output event unions (`TInput` extending `CodecInputEvent`, `TOutput` extending `CodecOutputEvent`), the per-node projection, and the domain message type
2. **Implement the reducer** - `init()` and `fold()`, folding events into the projection idempotently by serial
3. **Implement the encoder** - map domain events to encoder core operations (startStream, appendStream, closeStream, publishDiscrete)
4. **Implement the decoder hooks** - build domain events from stream tracker state
5. **Implement `getMessages()`** - extract `CodecMessage<TMessage>[]` from the projection
6. **Implement the input factories** - `createUserMessage` and `createRegenerate` are required; the tool-result and tool-approval factories are optional

See [Vercel codec](vercel-codec.md) for the concrete Vercel implementation details. See [Encoder](encoder.md) for the encoder core that domain encoders delegate to. See [Decoder](decoder.md) for the decoder core and its hook interface. See [Wire protocol](wire-protocol.md) for the transport vs domain header discipline.
