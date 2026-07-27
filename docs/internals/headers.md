# Header utilities

The SDK uses two distinct header tiers on every Ably message: **transport headers** under `extras.ai.transport`, managed by the transport layer, and **codec headers** under `extras.ai.codec`, managed by codec implementations. Both are unprefixed — the tiers isolate them. Each tier has its own builder.

## Transport headers

Transport headers are built by [`buildTransportHeaders()`](transport-components.md#buildtransportheaders) in `src/core/transport/headers.ts`. See [Wire protocol](wire-protocol.md#transport-headers) for the full specification.

## Codec header fields

Codec headers carry codec-specific metadata — field names like `id`, `providerMetadata`, `finishReason` — plus the SDK-controlled dispatch header `kind`. They live under `extras.ai.codec` and carry no prefix; the tier isolates them from transport headers.

Codecs no longer build these headers with an ad-hoc fluent writer. Instead, each header key is bound **once** to its value type via a typed `HeaderField` (`src/core/codec/fields.ts`), and the encode and decode sides both go through that single binding — so a key cannot be misspelled on one side and silently read as absent on the other.

### HeaderField

A `HeaderField<V>` binds a header key to its decoded value type `V` and exposes a symmetric read/write pair over a raw `Record<string, string>`:

```typescript
interface HeaderField<V> {
  readonly key: string;
  read(headers: Record<string, string>): V;
  // value is `unknown`, not `V`, so heterogeneous fields share a HeaderField<unknown>[]
  write(headers: Record<string, string>, value: unknown): void;
}
```

`write` is a no-op when the value is `undefined` (and `null`, for JSON), or when its runtime type doesn't match the field — the key is left unset rather than written.

This is deliberately **not** a schema library — it is a thin bidirectional string (de)serializer over the headers record. Four constructors cover every header value shape the codecs use:

| Constructor                         | `read` yields            | Serialization                                                                    |
| ----------------------------------- | ------------------------ | -------------------------------------------------------------------------------- |
| `strField(key)`                     | `string \| undefined`    | Stored directly; absent → `undefined`.                                           |
| `strField(key, fallback)`           | `string` (total)         | Stored directly; absent → `fallback`.                                            |
| `boolField(key)`                    | `boolean \| undefined`   | `"true"` / `"false"`; absent → `undefined`.                                      |
| `boolField(key, fallback)`          | `boolean` (total)        | `"true"` / `"false"`; absent → `fallback`.                                       |
| `jsonField<V>(key)`                 | `V \| undefined`         | `JSON.stringify` / `JSON.parse`; absent or malformed → `undefined`.              |
| `enumField(key, allowed, fallback)` | one of `allowed` (total) | Stored directly; absent or not in `allowed` → `fallback` (validated allow-list). |

Passing a fallback to `strField` / `boolField` makes the field **total**: its `read` returns `V` rather than `V | undefined`, for required headers that should always decode to a concrete value. The `enumField` allow-list is the same shape used for a finish reason.

```typescript
import { boolField, enumField, jsonField, strField } from '../../core/codec/fields.js';

const fId = strField('id'); // string | undefined
const fApproved = boolField('approved', false); // total: absent → false
const fMeta = jsonField<AI.ProviderMetadata>('providerMetadata'); // parsed JSON | undefined
const fFinishReason = enumField('finishReason', ['stop', 'length', 'error'] as const, 'stop');
```

### Vercel codec field bindings

The Vercel codec declares its domain header bindings in `src/vercel/codec/fields.ts` — for example `fId`, `fMeta`, `fToolCallId`, `fFinishReason`, and the input-side `fApproved`. Domain field names live in the Vercel layer, not core, per the header-discipline rule. The `kind` and `partType` dispatch headers are not codec field bindings — they are owned and stamped by the core descriptor drivers (`KIND_HEADER` / `PART_TYPE_HEADER` in `src/core/codec/field-bag.ts`), so a codec author never binds them. The output and input descriptors and the escape hatches all read and write through the domain bindings, so a header key cannot drift between encode and decode. Provider metadata is read directly through the `fMeta` binding (`fMeta.read(codecHeaders)`), which decodes to `AI.ProviderMetadata | undefined`.

### The `kind` dispatch header

The codec tier carries one SDK-controlled header, `kind` (`KIND_HEADER = 'kind'` in `src/core/codec/field-bag.ts`). It holds the dispatch discriminator the decoder routes on — for discrete messages the descriptor `kind`, and for streamed messages the stream-family id. The decoder dispatches on this header value within the wire direction fixed by the Ably message name (`ai-input` vs `ai-output`), never on the in-memory event shape. `kind` values are codec-defined: each descriptor's `kind` literal becomes a valid wire value.

### writeFields / readFields

The descriptor drivers move whole field sets through the bindings using the helpers in `field-bag.ts`:

- `writeFields(fields, kindValue, source, keys?)` seeds the record with `{ kind: kindValue }`, then writes each field's value (read off `source` by the field's key). An optional `keys` subset restricts which fields are written.
- `readFields(fields, headers)` reads each field out of the inbound codec headers into a bag keyed by `field.key`; a field that reads `undefined` contributes no key.

## Low-level utilities

These back the `HeaderField` bindings (`boolField` uses `parseBool`, `jsonField` uses `parseJson`) and the transport layer. Codec implementations should prefer the typed `HeaderField` bindings over calling these directly.

| Function                        | Purpose                                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `getTransportHeaders(msg)`      | Extract `extras.ai.transport` from an Ably `InboundMessage`. Returns `{}` if absent.            |
| `getCodecHeaders(msg)`          | Extract `extras.ai.codec` from an Ably `InboundMessage`. Returns `{}` if absent.                |
| `mergeHeaders(base, overrides)` | Shallow merge of two header records into a new object (overrides win).                          |
| `parseJson(value)`              | Parse a JSON string, returning undefined on failure.                                            |
| `parseBool(value)`              | Parse `"true"` / `"false"` (any other string is `false`), returning undefined if absent.        |
| `stripUndefined(obj)`           | Remove undefined-valued keys from an object. Used to build chunk literals with optional fields. |

## Header merge order

When the [encoder](encoder.md#header-merging) publishes a message, it builds two independent tiers — the transport tier and the codec tier — that never merge into one another.

The **transport tier** (`_buildTransport`) is merged in priority order (later wins):

1. **Default extras** - encoder-level defaults from construction
2. **Per-write overrides** - headers passed to individual write calls
3. **Payload transport headers** - transport-tier headers the codec stamps on the payload (`payload.transportHeaders`, e.g. `role`, `status`)

If `WriteOptions.messageId` is set, the encoder then stamps it as `codec-message-id` on the transport tier.

The **codec tier** (`payload.codecHeaders`) is a separate tier taken verbatim and omitted from the wire entirely when empty. It is never merged into the transport priority chain.

The `onAblyMessage` hook is a generic, optional message-mutation callback (default noop) invoked once on the fully built `Ably.Message`; it does not perform transport stamping. Transport headers (run IDs, role, parent) come from `payload.transportHeaders` (produced by `buildTransportHeaders`), set while building the transport tier.

See [Wire protocol](wire-protocol.md) for the complete header specification. See [Encoder](encoder.md#header-merging) for the merge implementation. See [Transport components: buildTransportHeaders](transport-components.md#buildtransportheaders) for the transport header builder.
