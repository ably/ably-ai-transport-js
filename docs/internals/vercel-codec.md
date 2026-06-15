# Vercel codec

The Vercel codec (`src/vercel/codec/`) implements the [Codec interface](codec-interface.md) for the Vercel AI SDK, mapping between `UIMessageChunk` outputs / `UIMessage` objects and Ably channel operations. `UIMessageCodec` (`index.ts`) is **assembled by `defineCodec`** rather than hand-written — there are no separate encoder/decoder classes. `defineCodec` is given the reducer (`init` / `fold` / `getMessages` from `reducer.ts`), the declarative output and input descriptor tables (`outputs` from `outputs.ts`, `inputs` from `inputs.ts`), and a decode lifecycle factory (`createVercelDecodeLifecycle` from `decode-lifecycle.ts`); it builds the generic encoder/decoder and merges the core's well-known input factories (`createUserMessage`, `createRegenerate`, `createToolResult`, `createToolResultError`, `createToolApprovalResponse`) internally. It is typed `Codec<VercelInput, VercelOutput, VercelProjection, UIMessage>`.

```ts
export const UIMessageCodec = defineCodec<VercelInput, VercelOutput>()({
  adapterTag: 'vercel-ai-sdk-ui-message',
  reducer: { init, fold, getMessages }, // reducer.ts
  output: outputs, // outputs.ts
  input: inputs, // inputs.ts
  decodeLifecycle: createVercelDecodeLifecycle, // decode-lifecycle.ts
});
```

The codec is split into single-concern modules: `reducer.ts` + `reducer-state.ts` and the per-concern `fold-*` modules (fold), `inputs.ts` / `outputs.ts` (descriptor tables), `fields.ts` (header-field bindings), `decode-lifecycle.ts` (mid-stream-join repair), `wire-data.ts` (runtime guards), and `tool-transitions.ts` (shared tool-part state machine).

`VercelInput` and `VercelOutput` (`events.ts`) split along the protocol's `ai-input` / `ai-output` wire seam:

- **`VercelOutput`** = `AI.UIMessageChunk` — the agent's streamed output, published on `ai-output`.
- **`VercelInput`** = a discriminated union of the SDK's well-known input variants (`UserMessage`, `Regenerate`, `ToolResult`, `ToolResultError`, `ToolApprovalResponse`), published by the client on `ai-input`. The tool variants are parameterized by Vercel domain payloads (`VercelToolResultPayload`, `VercelToolResultErrorPayload`, `VercelToolApprovalResponsePayload`); the Vercel codec has no codec-local input variants.

## Encode / decode via descriptor tables

`UIMessageCodec` has no hand-written encoder or decoder. Instead it declares two descriptor tables that `defineCodec` runs in both directions:

- **`outputs.ts`** — the `ai-output` table, built from the injected `{ event, stream }` builder. `stream(...)` declares a streamed family (start / delta / end); `event(...)` declares a discrete output.
- **`inputs.ts`** — the `ai-input` table, built from the injected `{ event, batch }` builder. `event(...)` declares a single discrete input (payload-nested or `wireOnly`); `batch(...)` declares a multi-part input that fans out into one wire event per part.

Dispatch is by the SDK-controlled codec `kind` [header](headers.md) (`KIND_HEADER = 'kind'`), never by message shape. Each descriptor stamps its `kind`; the decoder routes first on the Ably message **name** (`ai-input` vs `ai-output`), then on the `kind` header value within that direction. Header fields are bound once via the shared [field bindings](#field-bindings) so a key cannot drift between encode and decode.

### Outputs (`outputs.ts`)

Streamed families and discrete events:

| Family / event                                                                                                  | Kind on the wire | Mechanism                                                                                                    |
| --------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `text` (`text-start` / `-delta` / `-end`)                                                                       | `text`           | `stream(...)` — `startStream` / `appendStream` / `closeStream`                                               |
| `reasoning` (`reasoning-start` / `-delta` / `-end`)                                                             | `reasoning`      | `stream(...)`                                                                                                |
| `tool-input` (`tool-input-start` / `-delta` / `tool-input-available`)                                           | `tool-input`     | `stream(...)` with `onEnd` / `decodeEnd` / `decodeDiscrete` hatches                                          |
| `start`, `start-step`, `finish-step`, `finish`, `message-metadata`, `error`, `abort`                            | the chunk `type` | `event(...)` — discrete publish                                                                              |
| `file`, `source-url`, `source-document`                                                                         | the chunk `type` | `event(...)`                                                                                                 |
| `tool-input-error`, `tool-output-available`, `tool-output-error`, `tool-approval-request`, `tool-output-denied` | the chunk `type` | `event(...)`                                                                                                 |
| `data-*`                                                                                                        | the chunk `type` | `event('data-*', { ephemeral })` — wildcard (predicate derived from the `-*` literal), transient → ephemeral |

The `tool-input` family's `onEnd` hatch closes the matching stream; if no stream is open (the input was never streamed) it catches the core's `InvalidArgument` and falls back to a `publishDiscrete()` carrying the full input. Its `decodeDiscrete` hatch rebuilds the `tool-input-start` + `tool-input-available` pair from a non-streamed publish.

The `start` event uses an `encode` hatch to inject the encoder's configured `messageId` as a fallback when the chunk omits one. For streamed messages, the descriptor's `fields` become persistent start headers the core repeats on every append; the family's `onEnd` headers are merged on top so changed values (e.g. updated `providerMetadata`) are picked up.

### Inputs (`inputs.ts`)

| `kind`                   | Mechanism                                 | Notes                                                                                                                                     |
| ------------------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `tool-result`            | `event(...)`                              | Nested `payload` (`{ toolCallId, output }`); addressed by the transport `codec-message-id`                                                |
| `tool-result-error`      | `event(...)`                              | Nested `payload` (`{ toolCallId, message }`)                                                                                              |
| `tool-approval-response` | `event(...)`                              | Nested `payload` (`{ toolCallId, approved, reason }`)                                                                                     |
| `regenerate`             | `event('regenerate', { wireOnly: true })` | Wire-only signal; stamps only the `kind` header, no payload; `parent` / `target` ride transport headers from the session; decodes to `[]` |
| `user-message`           | `batch(...)`                              | Fans each `UIMessage` part into one wire event sharing the `user-message` kind + codec-message-id                                         |

For all single-event inputs, the `fields` / `data` callbacks operate on the member's **nested `payload`** — the driver wraps and unwraps the `{ kind, codecMessageId, payload }` envelope. (`via` no longer exists; input payloads are always nested.)

A `user-message` batch explodes each part into its own `ai-input` wire event. Every part carries the `partType` codec header (its sub-discriminator); the message id rides the `messageId` codec header and the role rides the `role` transport header, both stamped on every part:

| Part type | `partType`             | Data        |
| --------- | ---------------------- | ----------- |
| `text`    | `text`                 | `part.text` |
| `file`    | `file`                 | `part.url`  |
| `data-*`  | The part's type string | `part.data` |

If a message has no encodable parts, a single empty `text` part is published as a placeholder so the codec-message-id and role survive a round-trip. The reducer reassembles the parts sharing a codec-message-id back into one `UserMessage`.

### Decode

`defineCodec` runs the same tables in reverse, producing a `DecodedMessage<VercelInput, VercelOutput>` (a `{ inputs, outputs }` tagged result) split by the wire message name. `ai-input` messages decode to `VercelInput` variants (`regenerate` decodes to `[]`); `ai-output` messages decode to `UIMessageChunk` outputs. Streamed families reconstruct their start / delta / end chunks from the [stream tracker](decoder.md), resolving the family from the tracker's `kind` header.

### Run cancellation

Run cancellation is a **transport-tier** concern, not a codec one — the codec no longer terminates runs. The agent's `pipeStream` (`src/core/transport/pipe-stream.ts`) races the stream against the run's `AbortSignal`; on cancellation it calls the encoder's `cancelStreams()` to close in-flight streamed messages as `status: cancelled` and relies on the transport `ai-run-end` event as the run terminator. The Vercel `abort` output is an ordinary discrete chunk carrying its reason — it is content the agent's own stream may emit, **not** the run terminator. See [Agent session](agent-session.md) for cancel routing.

## Reducer

`src/vercel/codec/reducer.ts` - a pure `(init, fold)` pair that folds the **direction-tagged** `CodecEvent<VercelInput, VercelOutput>` union into a `VercelProjection` holding `UIMessage[]`. `fold` dispatches on `event.direction` (`'input'` switches on `input.kind`; `'output'` routes the chunk by `chunk.type` through the per-concern `fold-*` modules) — it never re-infers direction from event shape. `getMessages(projection)` returns those messages, each paired with its `codec-message-id`, for the [conversation tree](conversation-tree.md) to consume. There is no separate accumulator object; the reducer is the assembly logic. See [Codec interface § Reducer and projection](codec-interface.md#reducer-and-projection) for the generic contract.

`reducer.ts` is the public facade and dispatch only. The projection shape, tracker types, `init`, and the message/tracker lookup helpers live in `reducer-state.ts`; the per-concern fold logic lives in sibling `fold-*` modules over that shared base (an acyclic DAG rooted at `reducer.ts`):

| Module                | Role                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `fold-lifecycle.ts`   | `start` / `start-step` / `finish-step` / `finish` / `abort` / `error` / `message-metadata`                       |
| `fold-text.ts`        | shared `start` / `delta` / `end` for `text-*` and `reasoning-*`                                                  |
| `fold-tool-input.ts`  | `tool-input-start` / `-delta` / `-available` / `-error`; accumulates JSON delta fragments in `tracker.inputText` |
| `fold-tool-output.ts` | agent `tool-output-available` / `-error` / `-denied` + `tool-approval-request`                                   |
| `fold-content.ts`     | `file` / `source-url` / `source-document` — independent attachment parts                                         |
| `fold-data.ts`        | `data-*` — append or replace in place by `id`; transient chunks dropped                                          |
| `fold-input.ts`       | client inputs (`user-message`, tool-result(-error), approval-response) + `retryPendingResolutions`               |

The reducer holds no instance state — every `fold(state, event, meta)` returns the (possibly mutated) projection. The projection carries all per-node state:

- **`messages`** - `CodecMessage<UIMessage>[]` in publication order; correlated strictly on `codecMessageId` (never on `message.id`).
- **`trackers`** - per-`codecMessageId` stream tracker state (`text` / `reasoning` stream-id → part index, plus per-tool-call `tools` trackers with an accumulated `inputText` buffer).
- **`pendingToolResolutions`** - client tool resolutions buffered until their target assistant arrives.

### No reducer-level dedup

The reducer folds every event unconditionally. Ordering, deduplication, and replay are the [transport's](conversation-tree.md) job: it delivers each event exactly once, in canonical serial order, refolding a node from a fresh `init()` when a late wire would land out of order. So competing events (e.g. a client `tool-result` and an agent `tool-output-available` for the same `toolCallId`) resolve by fold order — the highest-serial write folds last and wins — with no conflict-key high-water-mark in the codec. Optimistic (serial-less) seeds need no replacement logic either: the transport refolds the node on the echo's serial, rebuilding the projection without the seed.

### Event processing

| Event                                                                 | Reducer action                                                                                                                    |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `user-message` input                                                  | Append a new entry for its `codecMessageId`, or merge its parts into the existing entry                                           |
| `regenerate` input                                                    | No-op (wire-only signal)                                                                                                          |
| `tool-result` / `tool-result-error` / `tool-approval-response` inputs | Transition the target assistant's `dynamic-tool` part, or buffer in `pendingToolResolutions` if the assistant has not yet arrived |
| `start`                                                               | Ensure the message; set `message.id` from the stream `messageId` and metadata                                                     |
| `start-step`                                                          | Push a `step-start` part                                                                                                          |
| `text-start` / `reasoning-start`                                      | Push an empty `text` / `reasoning` part, register the stream                                                                      |
| `text-delta` / `reasoning-delta`                                      | Append the delta to the registered part                                                                                           |
| `text-end` / `reasoning-end`                                          | Deregister the stream                                                                                                             |
| `tool-input-start` / `-delta` / `-available` / `-error`               | Create or transition the `dynamic-tool` part; deltas accumulate JSON and parse incrementally                                      |
| `tool-output-available` / `tool-output-error`                         | Resolve the owning `dynamic-tool` part by `toolCallId` across the whole projection (drop on miss)                                 |
| `tool-approval-request` / `tool-output-denied`                        | Transition the part on the stamped `messageId`                                                                                    |
| `finish-step`                                                         | Clear text/reasoning stream trackers so the next step can reuse stream ids                                                        |
| `finish` / `message-metadata`                                         | Set final `message.metadata`                                                                                                      |
| `abort` / `error`                                                     | No projection mutation — run termination is observed via the wire run-end event                                                   |
| `file` / `source-url` / `source-document`                             | Push the corresponding content part                                                                                               |
| `data-*`                                                              | Push or replace a data part (by `id`); transient chunks are skipped                                                               |

After every fold, `retryPendingResolutions` (`fold-input.ts`) re-evaluates buffered tool resolutions in case the just-folded event produced the assistant they were waiting on.

### Tool part transitions

`src/vercel/codec/tool-transitions.ts` holds the shared `dynamic-tool` part state machine, used by both the chunk fold (`foldToolOutput`, `fold-tool-output.ts`) and the client-input folds (`fold-input.ts`). `toolBase()` extracts the state-independent identity fields; `transitionToolPart()` produces the next part shape for a `tool-output-available` / `tool-output-error` / `tool-output-denied` / `tool-approval-request` chunk. Approval responses are handled in `fold-input.ts`'s `approvalTransition`: `approved=true` synthesizes an `approval-responded` part (so the AI SDK auto-runs the tool on the next step), `approved=false` delegates to `transitionToolPart` with a synthetic `tool-output-denied`.

### Field bindings

`fields.ts` binds each codec header key to its value type once (via core's `strField` / `boolField` / `jsonField` / `enumField` over the [`HeaderField`](headers.md) contract). The output/input descriptors and escape hatches read and write through these shared bindings (`fToolCallId`, `fToolName`, `fMeta`, `fMessageId`, `fFinishReason`, …), so a header key cannot drift between the encode and decode side. Domain field names live in the Vercel layer, not core, per the header-discipline rule.

### Wire-data guards

`wire-data.ts` holds runtime guards for the tool payloads whose `data` envelope is JSON-parsed from the network (a trust boundary): `isToolInputErrorWireData`, `isToolOutputAvailableWireData`, `isAgentToolOutputErrorWireData`, and `isClientToolResultErrorWireData`. Each validates only the typed envelope fields (e.g. `errorText` / `message` are `string` or absent); tool-defined `output` / `input` stay unconstrained. On rejection the descriptor `decode` callbacks fall back to field defaults. Used by both `outputs.ts` and `inputs.ts`.

See [Codec interface](codec-interface.md) for how `defineCodec` wires the descriptor tables and reducer into the generic transport. See [Encoder core](encoder.md) and [Decoder core](decoder.md) for the generic machinery the descriptors drive. See [Lifecycle tracker](lifecycle-tracker.md) for mid-stream join handling (`decode-lifecycle.ts` builds a fresh `LifecyclePolicy` per decoder). See [Headers](headers.md) for the header field bindings.
