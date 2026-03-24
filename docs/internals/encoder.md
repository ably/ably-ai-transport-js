# Encoder core

The encoder core (`src/core/codec/encoder.ts`) translates domain events into Ably publish operations. It implements the [message append](glossary.md#message-actions-ably) lifecycle — creating, appending to, closing, and aborting streamed messages — and handles recovery when appends fail.

Domain codecs don't interact with Ably directly. They call encoder core methods (`startStream`, `appendStream`, `closeStream`) and the core handles serialization, header merging, and error recovery.

## Two message modes

### Discrete messages

`publishDiscrete(payload)` publishes a single, immutable Ably message with `x-ably-stream: "false"`. Used for user messages, tool output, lifecycle events — anything that arrives as a complete unit.

`publishDiscreteBatch(payloads)` publishes multiple discrete messages atomically in a single channel publish call.

### Streamed messages

Streamed messages use Ably's [message append lifecycle](wire-protocol.md#streamed-messages). A single Ably message is created, then progressively appended to as data arrives:

```
startStream(streamId, payload)   →  channel.publish()        x-ably-status: streaming
appendStream(streamId, data)     →  channel.appendMessage()   (delta)
appendStream(streamId, data)     →  channel.appendMessage()   (delta)
closeStream(streamId, payload)   →  channel.appendMessage()   x-ably-status: finished
```

## Stream lifecycle

### startStream

Creates a new message on the channel. Captures the [serial](glossary.md#serial-ably) returned by `publish()` — this serial identifies the message for all subsequent appends.

Initializes a tracker that stores:
- `serial` — the Ably-assigned message serial
- `accumulated` — full text content so far (for recovery)
- `persistentHeaders` — all headers from the initial publish (repeated on every append)

### appendStream

Appends a text delta to the in-flight message. This is [fire-and-forget](glossary.md#fire-and-forget) — the promise is collected but not awaited. Errors are batched and handled during flush.

The accumulated text grows with each append: `tracker.accumulated += data`. This running total is used for recovery if an append fails.

### closeStream

Sends a final append with `x-ably-status: "finished"` and any closing headers (e.g. finish reason, provider metadata). Then flushes all pending appends to detect and recover from failures.

The closing append carries the closing `data` payload (which is also accumulated for recovery) and repeats all persistent headers.

### abortStream / abortAllStreams

Sends an append with `x-ably-status: "aborted"` and empty data. Marks the tracker as aborted so recovery uses the correct status. Then flushes pending appends.

`abortAllStreams()` aborts every active stream — used when a turn is [cancelled](stream-router.md#cancel-routing-server-transport).

## Recovery mechanism

Appends are fire-and-forget for performance — each token-level delta doesn't wait for the previous one to be acknowledged. But appends can fail (network issues, rate limits). The encoder handles this through batched flush and recovery.

When `closeStream` or `abortStream` is called, `_flushPending()` awaits all collected append promises via `Promise.allSettled`. For any failed stream:

1. Build a recovery message with the **full accumulated text** (not just the failed delta)
2. Call `channel.updateMessage()` to replace the message content entirely
3. Set the status to `finished` or `aborted` based on the tracker state

This means: even if intermediate appends are lost, the final message content is correct. The [decoder](decoder.md#known-serial-prefix-match) handles the update action through its prefix-match logic — if the data is a prefix extension of what it's already accumulated, it extracts the delta. If not, it treats it as a [full replacement](decoder.md#known-serial-prefix-match).

### Re-entrancy guard

`_flushPending()` uses a promise guard (`_flushPromise`) to prevent concurrent flushes. If a flush is already in progress, subsequent calls await it instead of starting a new one. This prevents race conditions when multiple streams close simultaneously.

## Header merging

Headers are merged in priority order (later wins):

1. `defaultExtras` — encoder-level defaults passed at construction
2. Per-write overrides — headers passed to individual write calls
3. Codec headers — domain-specific headers from the payload

If `WriteOptions.messageId` is set, the encoder stamps it as [`x-ably-msg-id`](wire-protocol.md#message-identity-x-ably-msg-id) during header merging. For streamed messages, this header is included in `persistentHeaders` — so every append and the closing append carry the same msg-id, giving the entire message append lifecycle a single identity.

After the headers are merged, the `onMessage` hook runs as a post-processing step — it receives the fully constructed `Ably.Message` object and can mutate it in place. The transport uses this hook to stamp [transport-level headers](wire-protocol.md#transport-headers-x-ably) (turn ID, role, parent, fork-of) onto every message without the codec needing to know about them.

### Closing appends repeat all headers

Ably replaces the entire `extras` object on each append. The encoder builds closing headers by starting from `persistentHeaders` (captured at `startStream`) and layering caller and codec overrides on top. This ensures the final message state has all necessary headers.

## ChannelWriter interface

The encoder writes through a `ChannelWriter` interface rather than directly to `Ably.RealtimeChannel`. This enables testing with mock writers and allows decorators (batching, logging) without changing the encoder.

```typescript
interface ChannelWriter {
  publish(message): Promise<PublishResult>;
  appendMessage(message): Promise<UpdateDeleteResult>;
  updateMessage(message): Promise<UpdateDeleteResult>;
}
```

`Ably.RealtimeChannel` satisfies this interface directly.

See [Wire protocol](wire-protocol.md) for the full header specification. See [Decoder](decoder.md) for how the decoder handles encoder output, including recovery via `message.update`. See [Codec interface](codec-interface.md) for how domain encoders compose the encoder core.
