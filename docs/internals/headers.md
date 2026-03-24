# Header utilities

The SDK uses two distinct header namespaces on every Ably message: **transport headers** (`x-ably-*`) managed by the transport layer, and **domain headers** (`x-domain-*`) managed by codec implementations. Two sets of utilities handle reading and writing these headers.

## Transport headers

Transport headers are built by [`buildTransportHeaders`](transport-components.md#buildtransportheaders) in `src/core/transport/headers.ts`. See [Wire protocol](wire-protocol.md#transport-headers-x-ably) for the full specification.

## Domain header utilities

Domain headers (`src/utils.ts`) carry codec-specific metadata — field names like `toolCallId`, `providerMetadata`, `finishReason`. The prefix `x-domain-` is applied automatically by the writer and stripped by the reader, so codec code works with unprefixed keys.

### headerWriter

A fluent builder for constructing domain header records. Each setter method auto-prefixes the key with `x-domain-` and returns the builder for chaining.

```typescript
import { headerWriter } from '@ably/ably-ai-transport-js';

const headers = headerWriter()
  .str('toolCallId', chunk.toolCallId)
  .str('toolName', chunk.toolName)
  .bool('dynamic', chunk.dynamic)
  .json('providerMetadata', chunk.providerMetadata)
  .build();
// → { 'x-domain-toolCallId': 'tc-1', 'x-domain-toolName': 'get_weather', ... }
```

| Method | Value type | Serialization |
|---|---|---|
| `str(key, value)` | `string \| undefined` | Stored directly. Skipped if undefined. |
| `bool(key, value)` | `boolean \| undefined` | Stored as `"true"` / `"false"`. Skipped if undefined. |
| `json(key, value)` | `unknown` | `JSON.stringify()`. Skipped if undefined or null. |
| `build()` | — | Returns the accumulated `Record<string, string>`. |

### headerReader

A typed accessor for reading domain headers. Mirrors `headerWriter` with the same method names for symmetry.

```typescript
import { headerReader } from '@ably/ably-ai-transport-js';

const r = headerReader(headers);
const toolCallId = r.str('toolCallId');        // string | undefined
const toolName = r.strOr('toolName', '');       // string (with fallback)
const dynamic = r.bool('dynamic');              // boolean | undefined
const metadata = r.json('providerMetadata');    // unknown (parsed JSON)
```

| Method | Return type | Behavior |
|---|---|---|
| `str(key)` | `string \| undefined` | Raw value, or undefined if absent. |
| `strOr(key, fallback)` | `string` | Raw value, or fallback if absent. |
| `bool(key)` | `boolean \| undefined` | `"true"` → `true`, anything else → `false`, absent → `undefined`. |
| `json(key)` | `unknown` | `JSON.parse()` the value, or undefined if absent or invalid. |

### Vercel-specific extension

The Vercel codec (`src/vercel/codec/decoder.ts`) extends `headerReader` with a `providerMetadata()` method that casts the parsed JSON to `AI.ProviderMetadata`:

```typescript
const r = headerReader(headers);
const pm = r.providerMetadata(); // AI.ProviderMetadata | undefined
```

## Low-level utilities

These are used internally by `headerWriter` / `headerReader` and by the transport layer. Codec implementations should prefer the typed reader/writer over calling these directly.

| Function | Purpose |
|---|---|
| `getHeaders(msg)` | Extract `extras.headers` from an Ably `InboundMessage`. Returns `{}` if absent. |
| `mergeHeaders(base, overrides)` | Shallow merge of two header records (overrides win). |
| `domainHeaders(entries)` | Build a domain headers record from unprefixed key-value pairs. |
| `getDomainHeader(headers, key)` | Read a single domain header by unprefixed key. |
| `setIfPresent(headers, key, value)` | Set a header if the value is defined — strings directly, booleans/numbers stringified, objects JSON-serialized. |
| `parseJson(value)` | Parse a JSON string, returning undefined on failure. |
| `parseBool(value)` | Parse `"true"` / `"false"`, returning undefined if absent. |
| `stripUndefined(obj)` | Remove undefined-valued keys from an object. Used to build chunk literals with optional fields. |

## Header merge order

When the [encoder](encoder.md#header-merging) publishes a message, headers are merged in priority order (later wins):

1. **Default extras** — encoder-level defaults from construction
2. **Per-write overrides** — headers passed to individual write calls
3. **Codec headers** — domain-specific headers from the payload

After merging, the `onMessage` hook runs as a post-processing step for transport-level stamping (turn ID, role, parent).

See [Wire protocol](wire-protocol.md) for the complete header specification. See [Encoder](encoder.md#header-merging) for the merge implementation. See [Transport components: buildTransportHeaders](transport-components.md#buildtransportheaders) for the transport header builder.
