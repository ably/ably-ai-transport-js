# Vercel codec

The Vercel codec (`src/vercel/codec/`) implements the [Codec interface](codec-interface.md) for the Vercel AI SDK, mapping between `UIMessageChunk` events / `UIMessage` objects and Ably channel operations. It consists of three components: an encoder, a decoder, and an accumulator.

## Encoder

`src/vercel/codec/encoder.ts` - maps `UIMessageChunk` events and `UIMessage` objects to Ably operations via the [encoder core](encoder.md).

The encoder handles two distinct write paths:

### Streaming events (appendEvent)

Each `UIMessageChunk` type maps to exactly one encoder core operation:

| Chunk category | Examples | Core operation |
|---|---|---|
| Stream start | `text-start`, `reasoning-start`, `tool-input-start` | `startStream` - opens a message stream |
| Stream delta | `text-delta`, `reasoning-delta`, `tool-input-delta` | `appendStream` - appends text to in-flight message |
| Stream end | `text-end`, `reasoning-end`, `tool-input-available` | `closeStream` - closes the stream |
| Lifecycle | `start`, `start-step`, `finish-step`, `finish`, `error`, `abort` | `publishDiscrete` - standalone message |
| Tool lifecycle | `tool-input-error`, `tool-output-available`, `tool-output-error`, `tool-approval-request`, `tool-output-denied` | `publishDiscrete` |
| Content | `file`, `source-url`, `source-document`, `message-metadata` | `publishDiscrete` |
| Custom data | `data-*` | `publishDiscrete` (with `ephemeral` flag for transient chunks) |

[Domain headers](headers.md) are passed to every operation. For streamed messages, start headers become "persistent headers" that the core repeats on every append. Closing headers are merged on top, so changed values (e.g. updated `providerMetadata`) are picked up.

### Complete messages (writeMessages)

`writeMessages()` encodes `UIMessage[]` for discrete publishing (e.g. user messages via `addMessages`). Each message is split into per-part Ably messages with a shared `x-domain-messageId`:

| Part type | Ably message name | Data |
|---|---|---|
| `text` | `text` | `part.text` |
| `file` | `file` | `part.url` |
| `data-*` | The part's type string | `part.data` |

If a message has no encodable parts, a single `text` message with empty data is published as a placeholder.

### Abort handling

On `abort` chunks, the encoder aborts all in-progress streams (via `abortAllStreams`), then publishes a discrete `abort` event with `x-ably-status: aborted`. The `_aborted` flag prevents double-abort.

## Decoder

`src/vercel/codec/decoder.ts` - maps inbound Ably messages to `DecoderOutput<UIMessageChunk, UIMessage>[]` via the [decoder core](decoder.md).

The decoder provides four hooks to the core:

### buildStartEvents / buildDeltaEvents / buildEndEvents

These hooks reconstruct `UIMessageChunk` events from stream tracker state. The decoder reads [domain headers](headers.md) to populate chunk fields:

- **Start** → `text-start`, `reasoning-start`, or `tool-input-start` (based on Ably message name)
- **Delta** → `text-delta`, `reasoning-delta`, or `tool-input-delta`
- **End** → `text-end`, `reasoning-end`, or `tool-input-available` (tool input parses accumulated JSON)

Start hooks also call `ensurePhases` on the [lifecycle tracker](lifecycle-tracker.md) to synthesize missing `start` / `start-step` events for mid-stream joins.

### decodeDiscrete

Handles non-streamed messages. Two categories:

**Discrete message parts** (from `writeMessages`) are identified by the presence of `x-ably-role` in headers. These are reconstructed into single-part `UIMessage` objects - the [conversation tree](conversation-tree.md) merges parts sharing the same `x-ably-msg-id`.

**Lifecycle events** are dispatched by Ably message name:

| Name | Produces | Notes |
|---|---|---|
| `start` | `start` chunk | Marks phase emitted on lifecycle tracker |
| `start-step` | `start-step` chunk | Marks phase emitted |
| `finish-step` | `finish-step` chunk | Resets `start-step` phase for next step |
| `finish` | `finish` chunk | Clears lifecycle tracker scope |
| `error` | `error` chunk | |
| `abort` | `abort` chunk | Clears lifecycle tracker scope |
| `tool-input` (discrete) | `tool-input-start` + `tool-input-available` | Non-streaming tool call |
| `file`, `source-url`, `source-document` | Corresponding chunks | |
| Tool lifecycle events | Corresponding chunks | |
| `data-*` | `data-*` chunk | Custom data events |

### Non-streaming tool calls

When `tool-input-available` arrives but no stream tracker exists for the `toolCallId`, the encoder falls back to publishing a discrete `tool-input` message. The decoder handles this by emitting both `tool-input-start` and `tool-input-available` in sequence, preceded by any missing lifecycle phases.

## Accumulator

`src/vercel/codec/accumulator.ts` - builds and maintains a `UIMessage[]` list from decoder outputs.

The accumulator consumes `DecoderOutput[]` and groups streaming events into `UIMessage` objects using lifecycle boundaries (`start` / `finish`). Multiple messages can be in-progress concurrently - each identified by the `messageId` field on decoder output (read from `x-ably-msg-id`).

### Message state management

Each active message tracks:

- **textStreams** / **reasoningStreams** - `DeltaStreamTracker` instances that map stream IDs to part indices
- **toolTrackers** - per-toolCallId trackers with accumulated input text and part index
- **streamStatus** - per-stream status (`streaming` / `finished` / `aborted`)

### Event processing

| Event type | Accumulator action |
|---|---|
| `start` | Create or locate message, set `messageId` and `metadata` |
| `start-step` | Push `step-start` part |
| `text-start` / `reasoning-start` | Push empty text/reasoning part, register stream |
| `text-delta` / `reasoning-delta` | Append to registered part's text |
| `text-end` / `reasoning-end` | Mark stream finished |
| `tool-input-start` | Push `dynamic-tool` part in `input-streaming` state |
| `tool-input-delta` | Accumulate JSON fragment, attempt parse, update part |
| `tool-input-available` | Set final parsed input, transition to `input-available` |
| `tool-output-available` | Transition tool part to `output-available` |
| `finish-step` | Reset text/reasoning stream trackers for next step |
| `finish` | Set final metadata, remove from active messages |
| `abort` | Mark all streaming parts as aborted, remove from active |
| `message` (complete) | Push directly into message list |

### Accessors

| Property | Returns |
|---|---|
| `messages` | All messages (active + completed) |
| `completedMessages` | Only messages no longer being streamed |
| `hasActiveStream` | Whether any stream is still in `streaming` status |

See [Codec interface](codec-interface.md) for how the encoder, decoder, and accumulator fit into the generic transport. See [Encoder core](encoder.md) and [Decoder core](decoder.md) for the generic machinery. See [Lifecycle tracker](lifecycle-tracker.md) for mid-stream join handling. See [Headers](headers.md) for the domain header reader/writer utilities.
