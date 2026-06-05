# Header utilities

The SDK uses two distinct header tiers on every Ably message: **transport headers** under `extras.ai.transport`, managed by the transport layer, and **codec headers** under `extras.ai.codec`, managed by codec implementations. Both are unprefixed — the tiers isolate them. Two sets of utilities handle reading and writing these headers.

## Transport headers

Transport headers are built by [`buildTransportHeaders()`](transport-components.md#buildtransportheaders) in `src/core/transport/headers.ts`. See [Wire protocol](wire-protocol.md#transport-headers) for the full specification.

## Codec header utilities

Codec headers (`src/utils.ts`) carry codec-specific metadata - field names like `id`, `providerMetadata`, `finishReason`. They live under `extras.ai.codec` and carry no prefix — the tier isolates them from transport headers.

### headerWriter

A fluent builder for constructing codec header records under their bare keys, returning the builder for chaining.

```typescript
import { headerWriter } from '@ably/ai-transport';

const headers = headerWriter()
  .str('id', chunk.id)
  .str('finishReason', chunk.finishReason)
  .json('providerMetadata', chunk.providerMetadata)
  .build();
// → { 'id': 'msg-1', 'finishReason': 'stop', ... }
```

| Method             | Value type             | Serialization                                         |
| ------------------ | ---------------------- | ----------------------------------------------------- |
| `str(key, value)`  | `string \| undefined`  | Stored directly. Skipped if undefined.                |
| `bool(key, value)` | `boolean \| undefined` | Stored as `"true"` / `"false"`. Skipped if undefined. |
| `json(key, value)` | `unknown`              | `JSON.stringify()`. Skipped if undefined or null.     |
| `build()`          | -                      | Returns the accumulated `Record<string, string>`.     |

### headerReader

A typed accessor for reading domain headers. Mirrors `headerWriter` with the same method names for symmetry.

```typescript
import { headerReader } from '@ably/ai-transport';

const r = headerReader(headers);
const id = r.str('id'); // string | undefined
const finishReason = r.strOr('finishReason', ''); // string (with fallback)
const error = r.str('error'); // string | undefined
const metadata = r.json('providerMetadata'); // unknown (parsed JSON)
```

| Method                 | Return type            | Behavior                                                          |
| ---------------------- | ---------------------- | ----------------------------------------------------------------- |
| `str(key)`             | `string \| undefined`  | Raw value, or undefined if absent.                                |
| `strOr(key, fallback)` | `string`               | Raw value, or fallback if absent.                                 |
| `bool(key)`            | `boolean \| undefined` | `"true"` → `true`, anything else → `false`, absent → `undefined`. |
| `json(key)`            | `unknown`              | `JSON.parse()` the value, or undefined if absent or invalid.      |

### Vercel-specific extension

The Vercel codec (`src/vercel/codec/decoder.ts`) extends `headerReader` with a `providerMetadata()` method that casts the parsed JSON to `AI.ProviderMetadata`:

```typescript
const r = headerReader(headers);
const pm = r.providerMetadata(); // AI.ProviderMetadata | undefined
```

## Low-level utilities

These back `headerReader` / `headerWriter` and the transport layer. Codec implementations should prefer the typed reader/writer over calling these directly.

| Function                            | Purpose                                                                                                         |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `getTransportHeaders(msg)`          | Extract `extras.ai.transport` from an Ably `InboundMessage`. Returns `{}` if absent.                            |
| `getCodecHeaders(msg)`              | Extract `extras.ai.codec` from an Ably `InboundMessage`. Returns `{}` if absent.                                |
| `mergeHeaders(base, overrides)`     | Shallow merge of two header records into a new object (overrides win).                                          |
| `getDomainHeader(headers, key)`     | Read a single domain header by unprefixed key.                                                                  |
| `setIfPresent(headers, key, value)` | Set a header if the value is defined - strings directly, booleans/numbers stringified, objects JSON-serialized. |
| `parseJson(value)`                  | Parse a JSON string, returning undefined on failure.                                                            |
| `parseBool(value)`                  | Parse `"true"` / `"false"` (any other string is `false`), returning undefined if absent.                        |
| `stripUndefined(obj)`               | Remove undefined-valued keys from an object. Used to build chunk literals with optional fields.                 |

## Header merge order

When the [encoder](encoder.md#header-merging) publishes a message, it builds two independent tiers — the transport tier and the codec tier — that never merge into one another.

The **transport tier** (`_buildTransport`) is merged in priority order (later wins):

1. **Default extras** - encoder-level defaults from construction
2. **Per-write overrides** - headers passed to individual write calls
3. **Payload transport headers** - transport-tier headers the codec stamps on the payload (`payload.transportHeaders`, e.g. `role`, `status`)

If `WriteOptions.messageId` is set, the encoder then stamps it as `codec-message-id` on the transport tier.

The **codec tier** (`payload.codecHeaders`) is a separate tier taken verbatim and omitted from the wire entirely when empty. It is never merged into the transport priority chain.

The `onMessage` hook is a generic, optional message-mutation callback (default noop) invoked once on the fully built `Ably.Message`; it does not perform transport stamping. Transport headers (run IDs, role, parent) come from `payload.transportHeaders` (produced by `buildTransportHeaders`), set while building the transport tier.

See [Wire protocol](wire-protocol.md) for the complete header specification. See [Encoder](encoder.md#header-merging) for the merge implementation. See [Transport components: buildTransportHeaders](transport-components.md#buildtransportheaders) for the transport header builder.
