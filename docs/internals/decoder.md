# Decoder core

The decoder core (`src/core/codec/decoder.ts`) converts inbound Ably messages into domain events. It handles all four Ably [message actions](wire-protocol.md#streamed-messages) (create, append, update, delete), tracks stream state via serials, and delegates to [codec-provided hooks](codec-interface.md#decoder-architecture) for domain-specific event building.

Domain codecs provide hooks that know how to build events from stream state. The decoder core handles the Ably-specific machinery - action dispatch, serial tracking, prefix-match accumulation - so codecs don't need to.

## Action dispatch

The decoder's `decode()` method switches on `message.action`:

| Action | What it means | How the decoder handles it |
|---|---|---|
| `message.create` | New message published | Check `x-ably-stream` header: if `"true"`, start tracking a new stream. If `"false"`, delegate to `decodeDiscrete()` |
| `message.append` | Delta appended to existing message | Look up stream tracker by serial, accumulate delta, check for terminal status |
| `message.update` | Message content replaced | Either first-contact (create tracker + synthesize events) or prefix-match/replacement on existing tracker |
| `message.delete` | Message deleted | Fire `onStreamDelete` callback, mark tracker closed |

## Stream tracker

For each streamed message, the decoder maintains a `StreamTrackerState` keyed by the Ably [serial](glossary.md#serial-ably):

```typescript
interface StreamTrackerState {
  name: string;           // Ably message name (e.g. "text", "tool-input")
  streamId: string;       // From x-ably-stream-id header
  accumulated: string;    // Full text accumulated so far
  headers: Record<string, string>;  // Current headers
  closed: boolean;        // Whether stream has finished or aborted
}
```

The tracker is created on the first `message.create` with `x-ably-stream: "true"` and keyed by the message's serial. All subsequent appends and updates for that serial are routed to the same tracker.

## Domain hooks

The decoder core delegates event building to four hooks provided by the domain codec:

| Hook | Called when | Returns |
|---|---|---|
| `buildStartEvents(tracker)` | A new stream starts | Events for stream start (e.g. `text-start` chunk) |
| `buildDeltaEvents(tracker, delta)` | Text delta received | Events for the delta (e.g. `text-delta` chunk) |
| `buildEndEvents(tracker, closingHeaders)` | Stream finishes (status: `finished`) | Events for stream end (e.g. `text-end`, `finish` chunks) |
| `decodeDiscrete(payload)` | Discrete message received | Events or complete messages |

The hooks receive the tracker state and return arrays of `DecoderOutput<TEvent, TMessage>` - either `{ kind: 'event', event }` or `{ kind: 'message', message }`.

## Append handling

When a `message.append` arrives:

1. Look up the tracker by serial
2. If no tracker exists, fall through to update handling (first-contact path)
3. Extract the string delta from `message.data`
4. Accumulate: `tracker.accumulated += delta`
5. Call `buildDeltaEvents()` to emit domain events
6. Check `x-ably-status`: if `"finished"`, call `buildEndEvents()` and mark closed - the event is [terminal](glossary.md#terminal-event). If `"aborted"`, mark closed (no end events for aborts)

## Update handling: first-contact vs prefix-match

The `message.update` action handles two scenarios:

### First-contact

The decoder has no tracker for this serial - the stream started before the subscription (history, reconnect). The decoder:

1. Creates a new tracker with the full `data` as accumulated text
2. Emits start events via `buildStartEvents()`
3. If data is non-empty, emits delta events via `buildDeltaEvents()`
4. If status is `"finished"`, emits end events via `buildEndEvents()`

This allows clients that join mid-stream or load from [history](history.md) to reconstruct the full event sequence. The [lifecycle tracker](codec-interface.md#lifecycle-tracker) builds on this by synthesizing any missing phases (e.g. a `start` chunk) that the first-contact path doesn't cover.

### Known serial: prefix-match

The decoder has an existing tracker. It checks whether the incoming data starts with the already-accumulated text:

**Prefix match** (data starts with `tracker.accumulated`):
- Extract the delta: `data.slice(tracker.accumulated.length)`
- Emit delta events for the new content
- Check for terminal status

**Not a prefix match** (data doesn't start with accumulated):
- The message was replaced entirely (e.g. [encoder recovery](encoder.md#recovery-mechanism) via `updateMessage`)
- Replace `tracker.accumulated` and `tracker.headers`
- Fire `onStreamUpdate` callback
- Emit no events (the full content will be visible when the decoder consumer reads the tracker)

## Delete handling

On `message.delete`:

1. Fire `onStreamDelete` callback with the serial and tracker (if one exists)
2. Mark the tracker as closed and clear accumulated text
3. Emit no events - deletion is handled by the transport layer (e.g. removing the message from the [conversation tree](conversation-tree.md#delete))

## Message ID tagging

After decoding, the decoder tags every event output with the [`x-ably-msg-id`](wire-protocol.md#message-identity-x-ably-msg-id) from the message headers. This ID is used by the [accumulator](codec-interface.md#accumulator) to route events to the correct in-progress domain message - for example, correlating a `text-delta` event to the `UIMessage` it belongs to.

## Decoder output types

The decoder returns an array of `DecoderOutput<TEvent, TMessage>`:

```typescript
type DecoderOutput<TEvent, TMessage> =
  | { kind: 'event'; event: TEvent; messageId?: string }
  | { kind: 'message'; message: TMessage };
```

- `kind: 'event'` - a streaming event that should be routed to a stream (own turn) or accumulated (observer turn)
- `kind: 'message'` - a complete domain message (e.g. a user message from `decodeDiscrete()`)

The transport layer processes these differently: events go to the [stream router](transport-components.md) or accumulator, messages go directly to the [conversation tree](conversation-tree.md).

See [Wire protocol](wire-protocol.md) for the message actions and header specification. See [Encoder](encoder.md) for the encoding side, including the recovery mechanism that produces `message.update` actions. See [Codec interface](codec-interface.md) for how domain codecs provide decoder hooks.
