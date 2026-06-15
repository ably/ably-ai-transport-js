# Vercel codec

The Vercel codec (`src/vercel/codec/`) implements the [Codec interface](codec-interface.md) for the Vercel AI SDK, mapping between `UIMessageChunk` outputs / `UIMessage` objects and Ably channel operations. `UIMessageCodec` (`index.ts`) is a single object that combines the reducer (`init` / `fold` / `getMessages` from `reducer.ts`) with encoder and decoder factories (`encoder.ts`, `decoder.ts`) and the input-construction helpers (`createUserMessage`, `createRegenerate`, `createToolResult`, `createToolResultError`, `createToolApprovalResponse`). It is typed `Codec<VercelInput, VercelOutput, VercelProjection, UIMessage>`.

`VercelInput` and `VercelOutput` (`events.ts`) split along the protocol's `ai-input` / `ai-output` wire seam:

- **`VercelOutput`** = `AI.UIMessageChunk` — the agent's streamed output, published on `ai-output`.
- **`VercelInput`** = a discriminated union of the SDK's well-known input variants (`UserMessage`, `Regenerate`, `ToolResult`, `ToolResultError`, `ToolApprovalResponse`), published by the client on `ai-input`. The tool variants are parameterized by Vercel domain payloads (`VercelToolResultPayload`, `VercelToolResultErrorPayload`, `VercelToolApprovalResponsePayload`); the Vercel codec has no codec-local input variants.

## Encoder

`src/vercel/codec/encoder.ts` - maps `VercelInput` and `VercelOutput` to Ably operations via the [encoder core](encoder.md). Two publish methods enforce direction at the call site:

- `publishOutput(output)` encodes a `VercelOutput` (`UIMessageChunk`) and publishes it on the `ai-output` wire.
- `publishInput(input)` encodes a `VercelInput` variant and publishes it on the `ai-input` wire.

The codec event's discriminator (`type` for outputs, `kind` for inputs) is carried in the codec tier's `type` [header](headers.md) so the decoder can dispatch.

### Outputs (publishOutput)

Each `UIMessageChunk` type maps to exactly one encoder core operation:

| Chunk category | Examples                                                                                                        | Core operation                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Stream start   | `text-start`, `reasoning-start`, `tool-input-start`                                                             | `startStream()` - opens a message stream                         |
| Stream delta   | `text-delta`, `reasoning-delta`, `tool-input-delta`                                                             | `appendStream()` - appends to the in-flight stream               |
| Stream end     | `text-end`, `reasoning-end`, `tool-input-available`                                                             | `closeStream()` - closes the stream                              |
| Lifecycle      | `start`, `start-step`, `finish-step`, `finish`, `error`, `abort`, `message-metadata`                            | `publishDiscrete()` - standalone message                         |
| Tool lifecycle | `tool-input-error`, `tool-output-available`, `tool-output-error`, `tool-approval-request`, `tool-output-denied` | `publishDiscrete()`                                              |
| Content        | `file`, `source-url`, `source-document`                                                                         | `publishDiscrete()`                                              |
| Custom data    | `data-*`                                                                                                        | `publishDiscrete()` (with `ephemeral` flag for transient chunks) |

`tool-input-available` closes the matching `tool-input` stream. If no stream is open (e.g. the input was never streamed), the encoder catches the core's `InvalidArgument` and falls back to a `publishDiscrete()` carrying the full input. An unsupported chunk type throws `InvalidArgument`.

For streamed messages, start headers become persistent headers that the core repeats on every append. Closing headers are merged on top, so changed values (e.g. updated `providerMetadata`) are picked up.

### Inputs (publishInput)

`publishInput` dispatches on the input's `kind`:

| `kind`                   | Wire name  | Core operation           | Notes                                                                         |
| ------------------------ | ---------- | ------------------------ | ----------------------------------------------------------------------------- |
| `user-message`           | `ai-input` | `publishDiscreteBatch()` | One Ably message per `UIMessage` part; `role` stamped on every part           |
| `regenerate`             | `ai-input` | `publishDiscrete()`      | Wire-only signal; `parent` / `target` ride transport headers from the session |
| `tool-result`            | `ai-input` | `publishDiscrete()`      | Targets the assistant addressed by the wire `codec-message-id`                |
| `tool-result-error`      | `ai-input` | `publishDiscrete()`      | Targets the assistant addressed by the wire `codec-message-id`                |
| `tool-approval-response` | `ai-input` | `publishDiscrete()`      | Targets the assistant addressed by the wire `codec-message-id`                |

A `user-message` is split into per-part discrete messages sharing a `messageId`. Each part publishes under the `ai-input` wire name; the part type is carried in the codec `type` header (the decoder dispatches on it):

| Part type | `type`                 | Data        |
| --------- | ---------------------- | ----------- |
| `text`    | `text`                 | `part.text` |
| `file`    | `file`                 | `part.url`  |
| `data-*`  | The part's type string | `part.data` |

If a message has no encodable parts, a single `ai-input` part (`type: text`) with empty data is published as a placeholder. The `role` transport header is stamped on every part so the decoder can reconstruct the `UIMessage` role.

### Cancel handling

`cancel(reason?)` cancels all in-progress streams (via `cancelAllStreams()`), then publishes a discrete event on the `ai-output` wire with codec `type: abort` and the transport `status` header set to `cancelled`. A `_cancelled` flag prevents double-cancel. An `abort` chunk passed to `publishOutput` follows the same path (and also sets `_cancelled`).

## Decoder

`src/vercel/codec/decoder.ts` - maps each inbound Ably message to a `DecodedMessage<VercelInput, VercelOutput>` (a `{ inputs, outputs }` tagged result) via the [decoder core](decoder.md). The decoder runs the core to produce a flat event list, then partitions it: events carrying a `kind` field are `VercelInput`s, the rest are `VercelOutput`s.

The decoder provides four hooks to the core:

### buildStartEvents / buildDeltaEvents / buildEndEvents

These hooks reconstruct streamed `UIMessageChunk` outputs from stream tracker state. The decoder reads codec [headers](headers.md) — specifically the codec `type` header — to pick the chunk family:

- **Start** → `text-start`, `reasoning-start`, or `tool-input-start` (based on `type`)
- **Delta** → `text-delta`, `reasoning-delta`, or `tool-input-delta`
- **End** → `text-end`, `reasoning-end`, or `tool-input-available`

`buildStartEvents` also calls `ensurePhases()` on the [lifecycle tracker](lifecycle-tracker.md) to synthesize missing `start` / `start-step` chunks for mid-stream joins.

### decodeDiscrete

Handles non-streamed messages. It first routes on the wire `name` (`ai-input` vs `ai-output`), then on the codec `type` header.

**`ai-input` messages** decode to `VercelInput` variants. Multi-part user-message parts (`text` / `file` / `data-*`, which ride `publishDiscreteBatch` and so carry the `discrete` transport header) are reconstructed into single-part `UserMessage` inputs — the reducer merges parts sharing the same `codec-message-id`. The remaining input kinds decode by `type`:

| `type`                   | Produces                                       |
| ------------------------ | ---------------------------------------------- |
| `tool-result`            | `tool-result` input                            |
| `tool-result-error`      | `tool-result-error` input                      |
| `tool-approval-response` | `tool-approval-response` input                 |
| `regenerate`             | nothing (wire-only signal; no projection fold) |

**`ai-output` messages** decode to `UIMessageChunk` outputs, dispatched by `type`:

| `type`                                                                                      | Produces                                           | Notes                                                                 |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------- |
| `start`                                                                                     | `start` chunk                                      | Marks phase emitted on lifecycle tracker                              |
| `start-step`                                                                                | `start-step` chunk                                 | Marks phase emitted                                                   |
| `finish-step`                                                                               | `finish-step` chunk                                | Resets `start-step` phase for next step                               |
| `finish`                                                                                    | `finish` chunk                                     | Clears lifecycle tracker scope                                        |
| `error`                                                                                     | `error` chunk                                      | Clears lifecycle tracker scope                                        |
| `abort`                                                                                     | `abort` chunk                                      | Clears lifecycle tracker scope                                        |
| `message-metadata`                                                                          | `message-metadata` chunk                           |                                                                       |
| `file`, `source-url`, `source-document`                                                     | Corresponding chunks                               |                                                                       |
| `tool-input`                                                                                | `tool-input-start` + `tool-input-available` chunks | Non-streamed tool input; prerolls missing phases via `ensurePhases()` |
| `tool-input-error`                                                                          | `tool-input-error` chunk                           |                                                                       |
| `tool-output-available`, `tool-output-error`, `tool-approval-request`, `tool-output-denied` | Corresponding chunks                               |                                                                       |
| `data-*`                                                                                    | `data-*` chunk                                     | Custom data events                                                    |

## Reducer

`src/vercel/codec/reducer.ts` - a pure `(init, fold)` pair over the `VercelInput | VercelOutput` union that builds a `VercelProjection` holding `UIMessage[]`. `getMessages(projection)` returns those messages, each paired with its `codec-message-id`, for the [conversation tree](conversation-tree.md) to consume. There is no separate accumulator object; the reducer is the assembly logic. See [Codec interface § Reducer and projection](codec-interface.md#reducer-and-projection) for the generic contract.

The reducer holds no instance state — every `fold(state, event, meta)` returns the (possibly mutated) projection. The projection carries all per-node state:

- **`messages`** - `CodecMessage<UIMessage>[]` in publication order; correlated strictly on `codecMessageId` (never on `message.id`).
- **`conflictSerials`** - per-conflict-key high-water-marks for idempotency.
- **`trackers`** - per-`codecMessageId` stream tracker state (`text` / `reasoning` stream-id → part index, plus per-tool-call `tools` trackers with an accumulated `inputText` buffer).
- **`pendingToolResolutions`** - client tool resolutions buffered until their target assistant arrives.

### Idempotency by conflict key

Idempotency is **per conflict key**, not stream-wide. `_conflictKeyOf` derives a key for events that compete for the same logical state; for those, the higher-serial event wins and earlier or equal serials are dropped. Events with no conflict key (additive deltas, lifecycle markers, independent attachments) fold unconditionally.

| Event(s)                                                                                                                        | Conflict key                                     |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `user-message`                                                                                                                  | `user-msg:<codecMessageId>` (none without an id) |
| `tool-result`, `tool-result-error`, `tool-output-available`, `tool-output-error`, `tool-output-denied`, `tool-approval-request` | `tool-output:<toolCallId>` (shared namespace)    |
| `tool-approval-response`                                                                                                        | `tool-approval:<toolCallId>`                     |
| `tool-input-start` / `tool-input-available` / `tool-input-error`                                                                | `<type>:<toolCallId>`                            |
| `text-start` / `text-end` / `reasoning-start` / `reasoning-end`                                                                 | `<type>:<codecMessageId>:<id>`                   |
| `finish` / `message-metadata`                                                                                                   | `<type>:<codecMessageId>`                        |

### Event processing

| Event                                                                 | Reducer action                                                                                                                    |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `user-message` input                                                  | Append or replace the entry for its `codecMessageId`                                                                              |
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

After every fold, `_retryPendingResolutions` re-evaluates buffered tool resolutions in case the just-folded event produced the assistant they were waiting on.

### Tool part transitions

`src/vercel/codec/tool-transitions.ts` holds the shared `dynamic-tool` part state machine, used by both the chunk fold (`_foldToolOutput`) and the client-input folds. `toolBase()` extracts the state-independent identity fields; `transitionToolPart()` produces the next part shape for a `tool-output-available` / `tool-output-error` / `tool-output-denied` / `tool-approval-request` chunk. Approval responses are handled in the reducer's `_approvalTransition`: `approved=true` synthesizes an `approval-responded` part (so the AI SDK auto-runs the tool on the next step), `approved=false` delegates to `transitionToolPart` with a synthetic `tool-output-denied`.

See [Codec interface](codec-interface.md) for how the encoder, decoder, and reducer fit into the generic transport. See [Encoder core](encoder.md) and [Decoder core](decoder.md) for the generic machinery. See [Lifecycle tracker](lifecycle-tracker.md) for mid-stream join handling. See [Headers](headers.md) for the header reader/writer utilities.
