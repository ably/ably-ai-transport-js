# Vercel codec

The Vercel codec (`src/vercel/codec/`) implements the [Codec interface](codec-interface.md) for the Vercel AI SDK, mapping between `UIMessageChunk` events / `UIMessage` objects and Ably channel operations. It consists of three components: an encoder, a decoder, and an accumulator.

## Encoder

`src/vercel/codec/encoder.ts` - maps `UIMessageChunk` events and `UIMessage` objects to Ably operations via the [encoder core](encoder.md).

The encoder handles two distinct write paths:

### Streaming events (appendEvent)

Each `UIMessageChunk` type maps to exactly one encoder core operation:

| Chunk category | Examples                                                         | Core operation                                                   |
| -------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| Stream start   | `text-start`, `reasoning-start`                                  | `startStream()` - opens a message stream                         |
| Stream delta   | `text-delta`, `reasoning-delta`                                  | `appendStream()` - appends text to in-flight message             |
| Stream end     | `text-end`, `reasoning-end`                                      | `closeStream()` - closes the stream                              |
| Lifecycle      | `start`, `start-step`, `finish-step`, `finish`, `error`, `abort` | `publishDiscrete()` - standalone message                         |
| Content        | `file`, `source-url`, `source-document`, `message-metadata`      | `publishDiscrete()`                                              |
| Custom data    | `data-*`                                                         | `publishDiscrete()` (with `ephemeral` flag for transient chunks) |

[Domain headers](headers.md) are passed to every operation. For streamed messages, start headers become "persistent headers" that the core repeats on every append. Closing headers are merged on top, so changed values (e.g. updated `providerMetadata`) are picked up.

### Complete messages (writeMessages)

`writeMessages()` encodes `UIMessage[]` for discrete publishing (e.g. user messages via `addMessages()`). Each message is split into per-part Ably messages with a shared `messageId`:

Every part publishes under the single `ai-input` wire name; the part type is carried in the `type` header (the decoder dispatches on it).

| Part type | Ably message name | `type`                 | Data        |
| --------- | ----------------- | ---------------------- | ----------- |
| `text`    | `ai-input`        | `text`                 | `part.text` |
| `file`    | `ai-input`        | `file`                 | `part.url`  |
| `data-*`  | `ai-input`        | The part's type string | `part.data` |

If a message has no encodable parts, a single `ai-input` message (`type: text`) with empty data is published as a placeholder.

### Cancel handling

On `abort` chunks (the AI SDK chunk type), the encoder cancels all in-progress streams (via `cancelAllStreams()`), then publishes a discrete event on the `ai-output` wire with `type: abort` and `status: cancelled`. The status header uses the transport's canonical `cancelled` value. The `_cancelled` flag prevents double-cancel.

## Decoder

`src/vercel/codec/decoder.ts` - maps inbound Ably messages to `DecoderOutput<UIMessageChunk, UIMessage>[]` via the [decoder core](decoder.md).

The decoder provides four hooks to the core:

### buildStartEvents / buildDeltaEvents / buildEndEvents

These hooks reconstruct `UIMessageChunk` events from stream tracker state. The decoder reads [domain headers](headers.md) to populate chunk fields:

- **Start** → `text-start` or `reasoning-start` (based on `type`)
- **Delta** → `text-delta` or `reasoning-delta`
- **End** → `text-end` or `reasoning-end`

Start hooks also call `ensurePhases()` on the [lifecycle tracker](lifecycle-tracker.md) to synthesize missing `start` / `start-step` events for mid-stream joins.

### decodeDiscrete

Handles non-streamed messages. Two categories:

**Discrete message parts** (from `writeMessages()`) are identified by the presence of `role` in headers. These are reconstructed into single-part `UIMessage` objects - the [conversation tree](conversation-tree.md) merges parts sharing the same `codec-message-id`.

**Lifecycle events** ride the `ai-output` wire and are dispatched by `type`:

| Name                                    | Produces             | Notes                                    |
| --------------------------------------- | -------------------- | ---------------------------------------- |
| `start`                                 | `start` chunk        | Marks phase emitted on lifecycle tracker |
| `start-step`                            | `start-step` chunk   | Marks phase emitted                      |
| `finish-step`                           | `finish-step` chunk  | Resets `start-step` phase for next step  |
| `finish`                                | `finish` chunk       | Clears lifecycle tracker scope           |
| `error`                                 | `error` chunk        |                                          |
| `abort`                                 | `abort` chunk        | Clears lifecycle tracker scope           |
| `file`, `source-url`, `source-document` | Corresponding chunks |                                          |
| `data-*`                                | `data-*` chunk       | Custom data events                       |

## Accumulator

`src/vercel/codec/accumulator.ts` - builds and maintains a `UIMessage[]` list from decoder outputs.

The accumulator consumes `DecoderOutput[]` and groups streaming events into `UIMessage` objects using lifecycle boundaries (`start` / `finish`). Multiple messages can be in-progress concurrently - each identified by the `messageId` field on decoder output (read from `codec-message-id`).

### Message state management

Each active message tracks:

- **textStreams** / **reasoningStreams** - `DeltaStreamTracker` instances that map stream IDs to part indices
- **streamStatus** - per-stream status (`streaming` / `complete` / `cancelled`)

### Event processing

| Event type                       | Accumulator action                                        |
| -------------------------------- | --------------------------------------------------------- |
| `start`                          | Create or locate message, set `messageId` and `metadata`  |
| `start-step`                     | Push `step-start` part                                    |
| `text-start` / `reasoning-start` | Push empty text/reasoning part, register stream           |
| `text-delta` / `reasoning-delta` | Append to registered part's text                          |
| `text-end` / `reasoning-end`     | Mark stream complete                                      |
| `finish-step`                    | Reset text/reasoning stream trackers for next step        |
| `finish`                         | Set final metadata, remove from active messages           |
| `abort`                          | Mark all streaming parts as cancelled, remove from active |
| `message` (complete)             | Push directly into message list                           |

### Accessors

| Property            | Returns                                           |
| ------------------- | ------------------------------------------------- |
| `messages`          | All messages (active + completed)                 |
| `completedMessages` | Only messages no longer being streamed            |
| `hasActiveStream`   | Whether any stream is still in `streaming` status |

See [Codec interface](codec-interface.md) for how the encoder, decoder, and accumulator fit into the generic transport. See [Encoder core](encoder.md) and [Decoder core](decoder.md) for the generic machinery. See [Lifecycle tracker](lifecycle-tracker.md) for mid-stream join handling. See [Headers](headers.md) for the domain header reader/writer utilities.
