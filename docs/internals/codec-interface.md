# Codec interface

The codec is the boundary between the [transport layer and domain layer](glossary.md#transport-layer-vs-domain-layer). It defines how domain events map to and from Ably messages, and how those events fold into the per-node state the conversation tree reads. The session is parameterized by `Codec<TInput, TOutput, TProjection, TMessage>` - swap the codec and the same session works with a different AI framework.

## The Codec interface

The codec is an [event-sourced](glossary.md) reducer. It extends `Reducer<CodecEvent<TInput, TOutput>, TProjection>` (the `init()` / `fold()` pair) and adds encoder/decoder factories plus the input-construction helpers:

```typescript
interface Codec<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> extends Reducer<CodecEvent<TInput, TOutput>, TProjection> {
  // from Reducer
  init(): TProjection;
  fold(state: TProjection, event: CodecEvent<TInput, TOutput>, meta: ReducerMeta): TProjection;

  // optional Ably-Agent identifier (registered on the channel when present)
  readonly adapterTag?: string;

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
| `fold()`                            | Folds one direction-tagged `CodecEvent` into the projection (from `Reducer`)                |
| `createEncoder()`                   | Creates an [encoder](encoder.md) that maps domain events to Ably publish operations         |
| `createDecoder()`                   | Creates a [decoder](decoder.md) that converts inbound Ably messages to typed inputs/outputs |
| `getMessages()`                     | Extracts `TMessage[]` (each paired with its `codec-message-id`) from a projection           |
| `createUserMessage()`               | Wraps a `TMessage` as the well-known `user-message` input variant                           |
| `createRegenerate()`                | Builds the well-known `regenerate` input variant                                            |
| `createToolResult?()` / `…Error?()` | Optional: build tool-result inputs (only codecs whose `TInput` includes the variant)        |
| `createToolApprovalResponse?()`     | Optional: build the tool-approval-response input variant                                    |

`TInput` is the union of input variants the client publishes on the `ai-input` wire (each extends `CodecInputEvent`, discriminated by `kind`); `TOutput` is the union of agent-published output variants on the `ai-output` wire (each extends `CodecOutputEvent`, discriminated by `type`). `TProjection` is the opaque per-node state the reducer folds into - the SDK never inspects it directly. `TMessage` is the per-message domain object the tree consumes.

The reducer folds the **direction-tagged** `CodecEvent<TInput, TOutput>` union, not a bare `TInput | TOutput`, so it dispatches on the wire direction rather than re-inferring it from each event's shape:

```typescript
type CodecEvent<TInput, TOutput> =
  | { readonly direction: 'input'; readonly event: TInput }
  | { readonly direction: 'output'; readonly event: TOutput };
```

Direction is derived once, from the Ably message name (`ai-input` xor `ai-output`), at decode time - a single message is one direction, never both.

Codec authors rarely implement this interface by hand. The [`defineCodec`](#defining-a-codec) factory assembles a conforming codec from a reducer, declarative descriptor tables, a `factories` selector, and an optional decode-lifecycle policy; it supplies the encoder/decoder skeletons and the well-known factory bodies, from which the codec's `factories` selector picks the subset it exposes.

## How the session uses the codec

### Agent session

The agent session uses `createEncoder()` to get an `Encoder<TInput, TOutput>`. The encoder exposes two direction-typed publish methods - `publishInput()` for client-originated inputs on the `ai-input` wire and `publishOutput()` for agent-originated outputs on the `ai-output` wire - plus `cancelStreams()` (close all in-flight streams as `status:cancelled`) and `close()`. A run streams its response by pushing each `TOutput` through `publishOutput()`.

Internally the encoder is built by `defineCodec` and is codec-agnostic: it routes each event through the codec's [descriptor tables](#defining-a-codec), which translate streamed families into [encoder core](encoder.md#stream-lifecycle) operations (`startStream()`, `appendStream()`, `closeStream()`) and discrete events into `publishDiscrete()`. The encoder core handles Ably primitives.

### Client session

The client session uses:

- `createDecoder()` - decodes inbound Ably messages into `{ inputs, outputs }` via `DecodedMessage`
- `init()` / `fold()` - the SDK tags each decoded event with its wire direction (via `toCodecEvents`, yielding the `CodecEvent` union) and folds it, with its `ReducerMeta` serial and `messageId`, into the owning node's projection
- `getMessages()` - extracts the message list from the projection to populate the [conversation tree](conversation-tree.md)

## Defining a codec

Codecs are assembled by the `defineCodec` factory (`src/core/codec/define-codec.ts`) rather than hand-written encoder/decoder classes. A codec author supplies only its parts; `defineCodec` builds the codec-agnostic encoder/decoder skeletons, wires the descriptor drivers, and spreads the factory subset the codec's `factories` selector returns:

```typescript
import { defineCodec } from '@ably/ai-transport';

export const UIMessageCodec = defineCodec<VercelInput, VercelOutput>()({
  adapterTag: 'vercel-ai-sdk-ui-message',
  reducer: { init, fold, getMessages },
  output: outputs, // (b: OutputBuilder<TOutput>) => readonly OutputDescriptor<TOutput>[]
  input: inputs, //  (b: InputBuilder<TInput>) => readonly InputDescriptor<TInput>[]
  factories: (base) => base, // full codec: expose every well-known factory (a partial codec returns a subset)
  decodeLifecycle: createVercelDecodeLifecycle,
});
```

`defineCodec` is curried on the input/output unions (`defineCodec<TInput, TOutput>()({ … })`) so `TProjection` and `TMessage` infer from `config.reducer` - a caller never spells them out. It returns a `DefinedCodec` (a conforming `Codec` whose exposed well-known input factories are typed concretely, callable without a guard).

| Config field       | Purpose                                                                                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapterTag?`      | Optional Ably-Agent identifier; only set on the codec when supplied                                                                                                                                               |
| `reducer`          | `{ init, fold, getMessages }` - `TProjection` / `TMessage` infer from here                                                                                                                                        |
| `output`           | Returns the `ai-output` descriptor table from the injected `{ event, stream, drop }` builder                                                                                                                      |
| `input`            | Returns the `ai-input` descriptor table from the injected `{ event, batch }` builder                                                                                                                              |
| `factories`        | Required. Selects, from the injected full well-known set, the factory subset this codec exposes: `createUserMessage` / `createRegenerate` are mandatory, each tool factory only when `TInput` carries the variant |
| `decodeLifecycle?` | Factory called once per decoder instance for mid-stream-join repair; omit for none                                                                                                                                |

### Descriptor tables

Both directions are declarative descriptor tables driven by the generic encode/decode drivers, so encode and decode cannot drift. Each builder is curried on the codec's union, so every callback receives the exact narrowed member with no casts.

The **output** builder offers three constructs:

- `event(type, spec?)` - one discrete output event. `spec` declares optional header `fields` (defaulting to none), an optional wire `data` codec, an `ephemeral` predicate, and an `encode` escape hatch. A `-*` type literal (e.g. `data-*`) declares a wildcard family; the dispatch predicate is derived from the literal's prefix.
- `stream(kind, spec)` - a streamed family. The first argument is the family's `kind` - the value stamped on the wire `kind` dispatch header. `spec` declares the `start` / `delta` / `end` chunk `type`s, a `streamId` extractor, a `deltaField`, header `fields`, and `onEnd` / `decodeDelta` / `decodeEnd` / `decodeDiscrete` hatches. The driver routes start/delta/end to `startStream()` / `appendStream()` / `closeStream()`.
- `drop(type)` - an output `type` the codec deliberately keeps off the wire. The encoder skips it silently (publishing nothing), and any type that is neither described nor dropped throws on encode - so an unexpected provider event fails loudly rather than being dropped unnoticed. An exact `drop` beats a wildcard `event` family, and a dropped type may double as a shared stream start's decline target.

The **input** builder mirrors it:

- `event(kind, spec)` - one discrete input ↔ one wire message. `fields` and `data` operate on the member's nested `payload`; `wireOnly: true` stamps only the `kind` header (empty data) and decodes to `[]`.
- `batch(kind, spec)` - one domain message ↔ many atomic wire events. `explode` decomposes the message into parts, each published as one wire event sharing the input's `kind` and codec-message-id with a `partType` sub-discriminator; `assemble` rebuilds one part on decode and the reducer merges parts by codec-message-id.

### Header-field bindings

Descriptor `fields` are typed `HeaderField` bindings from `src/core/codec/fields.ts` - a thin bidirectional string (de)serializer over the raw headers record, **not** a schema library. A single binding drives both encode (`write`) and decode (`read`), so a key cannot drift between directions. Four constructors cover every header value shape:

| Constructor         | Value type                                            | Notes                                                           |
| ------------------- | ----------------------------------------------------- | --------------------------------------------------------------- |
| `strField(key)`     | `string \| undefined` (or `string` with a fallback)   | Plain string                                                    |
| `boolField(key)`    | `boolean \| undefined` (or `boolean` with a fallback) | Serialized as `"true"` / `"false"`                              |
| `jsonField<V>(key)` | `V \| undefined`                                      | `JSON.stringify` / `JSON.parse`; malformed reads as `undefined` |
| `enumField(key, …)` | one of the allowed literals (total via fallback)      | Validated against an allow-list (e.g. a finish reason)          |

`write` skips `undefined` (and `null`, for JSON) and type-mismatched values, leaving the key unset. Passing a fallback to `strField` / `boolField` makes `read` total.

A field's key plays a dual role in descriptor tables: it is the wire header key **and** the property name read off the member (chunk, payload, or part) on encode and written back on decode. The `FieldFor<C>` type enforces this - a declared field's key must name a real property of the member it lenses onto, with a compatible value type, so a typo'd key or a wrong-typed field is a compile error rather than a silently absent header.

### Well-known input factories

The five well-known input factory bodies (`createUserMessage`, `createRegenerate`, `createToolResult`, `createToolResultError`, `createToolApprovalResponse`) are provided once by the core (`src/core/codec/well-known-inputs.ts`), so codec authors never re-implement them. Their bodies are fully determined by the well-known variant shapes - e.g. `createUserMessage(message)` returns `{ kind: 'user-message', message }` and `createToolResult(codecMessageId, payload)` returns `{ kind: 'tool-result', codecMessageId, payload }`.

`defineCodec` calls `wellKnownInputs<TInput>()` and hands the full set to the codec's `factories` selector as `base`; whatever that selector returns is spread onto the codec. A **full** codec exposes them all (`factories: (base) => base`); a **partial** codec whose `TInput` omits the tool variants returns just the two mandatory factories (`(base) => ({ createUserMessage: base.createUserMessage, createRegenerate: base.createRegenerate })`). The selector's return type (`DefinedCodecFactories<TInput>`) types each tool factory as present only when `TInput` carries the matching variant, so a partial codec cannot over-expose a factory its `TInput` can't represent - and, because only the selected factories are spread, a partial codec carries no tool-factory methods at runtime. This is what keeps a partial codec's `DefinedCodec` assignable to `Codec` (whose tool factories are optional).

### Decode lifecycle policy

`decodeLifecycle` is a factory returning a fresh `LifecyclePolicy<TOutput>` per decoder instance, used to repair mid-stream joins (history compaction, rewind miss, partial page). `onDiscrete` (keyed on codec `kind`) and `onStreamStart` perform a side effect on the per-decoder lifecycle tracker and **return lead-in events to prepend**; the descriptor driver always runs after and its output is appended - the policy never replaces a decode. See [Lifecycle tracker](#lifecycle-tracker) below.

The [encoder core](encoder.md) handles all Ably-specific concerns: serial tracking, append queuing, [flush/recovery](encoder.md#recovery-mechanism), [header persistence](encoder.md#closing-appends-repeat-all-headers). The [decoder core](decoder.md) handles [action dispatch](decoder.md#action-dispatch), serial tracking, and [prefix-match accumulation](decoder.md#known-serial-prefix-match), invoking the descriptor-driven build/decode hooks `defineCodec` supplies.

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

Ordering, deduplication, and replay are the transport's responsibility, not the reducer's. The [conversation tree](conversation-tree.md) invokes `fold` exactly once per event, in canonical order — wire messages ascending by serial, events within a wire in decode order — refolding a node from a fresh `init()` when a late wire would otherwise land out of order. The reducer therefore folds **unconditionally**: it keeps no serial high-water-mark and never skips "already-seen" events. Last-writer-wins for events competing over the same state falls out of fold order, since the highest-serial event folds last. `init()` runs once per node and again on every refold.

### ReducerMeta — transport-derived metadata

Each fold call carries a `ReducerMeta` the SDK reads from the inbound Ably message:

```typescript
interface ReducerMeta {
  serial: string;
  messageId?: string;
}
```

- `serial` is the Ably channel serial of the wire message that produced the event (or `''` for a not-yet-sequenced optimistic fold). It is ordering context only: the transport invokes `fold` exactly once per event, in canonical serial order, so the reducer must **not** use it to dedup or skip "already-seen" events — ordering, deduplication, and replay are the transport's responsibility (see [Reducer contract](#reducer-and-projection) below).
- `messageId` is the optional [`codec-message-id`](wire-protocol.md#message-identity-codec-message-id) of the inbound message, used to route an event onto a target message within the projection (e.g. to amend an existing assistant message with a tool result).

### Why a list, not a single message

`getMessages()` returns a `CodecMessage<TMessage>[]` - a list, not a single message - because one node's projection can hold more than one domain message, each paired with the `codec-message-id` that identifies it on the wire. (The user prompt and the agent's reply are _not_ an instance of this: they live in separate nodes - an `InputNode` and a `RunNode` - each with its own projection. A list arises when a single projection accumulates several messages under distinct codec-message-ids, e.g. more than one assistant message folded into one run's projection.)

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

Its output table (`src/vercel/codec/outputs.ts`) and input table (`src/vercel/codec/inputs.ts`) are built with the `defineCodec` descriptor builders; the reducer is split into `reducer.ts` + `reducer-state.ts` and per-concern `fold-*` modules. (The previous hand-written `vercel/codec/encoder.ts` and `decoder.ts` were removed.)

### Event mapping

All Vercel output events publish under the `ai-output` wire name, with the stream family id (for streamed chunks) or the discrete event type carried in the codec `kind` [header](#codec-headers) so the decoder can dispatch.

| UIMessageChunk type        | Wire representation                             |
| -------------------------- | ----------------------------------------------- |
| `text-start`               | Streamed family start (`kind: "text"`)          |
| `text-delta`               | Streamed family append                          |
| `text-end`                 | Streamed family close (status: `"complete"`)    |
| `start`, `finish`, `error` | Discrete message (`kind` = the event type)      |
| `data-*`                   | Discrete message (`data-*` wildcard descriptor) |

### Codec headers

The Vercel codec uses [codec headers](wire-protocol.md#codec-headers) (under `extras.ai.codec`) to carry Vercel-specific metadata:

- `kind` - the SDK-controlled dispatch discriminator: the stream family id (`text`, `reasoning`, `tool-input`) for streamed chunks, or the discrete event type otherwise. The decoder routes on this header value, never on message shape.
- `id` - chunk/part ID
- `providerMetadata` - JSON-serialized `ProviderMetadata`
- `finishReason` - why the LLM stopped (on `finish`)

Error text and `data-*` payloads ride in the message `data`, not in a header. These headers are declared as typed [header-field bindings](#header-field-bindings) (`src/vercel/codec/fields.ts`) so encode and decode share one definition per key. Tool wire-data payloads in the message `data` are validated by runtime guards (`src/vercel/codec/wire-data.ts`) before being read.

## Writing a new codec

To support a new AI framework, assemble a codec with [`defineCodec`](#defining-a-codec):

1. **Define the type parameters** - the input/output event unions (`TInput` extending `CodecInputEvent`, `TOutput` extending `CodecOutputEvent`), the per-node projection, and the domain message type
2. **Implement the reducer** - `init()`, `fold()` (dispatching on `event.direction`), and `getMessages()`, folding events unconditionally (the transport delivers them once, in canonical order)
3. **Declare the output table** - the `output` builder function returning `event` / `stream` / `drop` descriptors built on [header-field bindings](#header-field-bindings)
4. **Declare the input table** - the `input` builder function returning `event` / `batch` descriptors
5. **Select the exposed factories** - the `factories` selector: return `base` unchanged for a full codec, or the mandatory `createUserMessage` / `createRegenerate` subset for a partial one
6. **Optionally supply `decodeLifecycle`** - a policy factory for mid-stream-join repair

You never implement the well-known input factory bodies (`createUserMessage`, `createRegenerate`, and the tool-result / tool-approval factories) - the core provides them and `defineCodec` hands them to your `factories` selector; you only choose which subset the codec exposes.

See [Vercel codec](vercel-codec.md) for the concrete Vercel implementation details. See [Encoder](encoder.md) for the encoder core the descriptor drivers delegate to. See [Decoder](decoder.md) for the decoder core. See [Wire protocol](wire-protocol.md) for the transport vs domain header discipline.
