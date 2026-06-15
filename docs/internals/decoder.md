# Decoder core

The decoder core (`src/core/codec/decoder.ts`) converts inbound Ably messages into domain events. It handles all four Ably [message actions](wire-protocol.md#streamed-messages) (create, append, update, delete), tracks stream state via serials, and delegates to [codec-provided hooks](codec-interface.md#defining-a-codec) for domain-specific event building.

The decoder core handles the Ably-specific machinery - action dispatch, serial tracking, prefix-match accumulation - so codecs don't need to. The hooks it delegates to are not hand-written by each codec: [`defineCodec`](codec-interface.md#defining-a-codec) builds them (`buildHooks` in `src/core/codec/define-codec.ts`) over the codec's declarative descriptor tables. The hooks rebuild events by dispatching on the SDK-controlled [`kind` codec header](wire-protocol.md#codec-headers) and reading the descriptors' declared fields - the decoder never inspects message shape to decide what an event is.

## Action dispatch

The decoder's `decode()` method switches on `message.action`:

| Action           | What it means                      | How the decoder handles it                                                                                                     |
| ---------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `message.create` | New message published              | Check the transport `stream` header: if `"true"`, start tracking a new stream. If `"false"`, delegate to `decodeDiscrete()`    |
| `message.append` | Delta appended to existing message | Look up stream tracker by serial, accumulate delta, check for terminal status. Unknown serial falls through to the update path |
| `message.update` | Message content replaced           | Either first-contact (create tracker + synthesize events) or prefix-match/replacement on existing tracker                      |
| `message.delete` | Message deleted                    | Fire `onStreamDelete` callback, mark tracker closed and clear accumulated text                                                 |

Any other action returns an empty array.

## Stream tracker

For each streamed message, the decoder maintains a `StreamTrackerState` keyed by the Ably [serial](glossary.md#serial-ably):

```typescript
interface StreamTrackerState {
  name: string; // Ably message name (the wire direction — "ai-output" for streamed outputs), not the codec kind / stream family
  streamId: string; // From stream-id header
  accumulated: string; // Full text accumulated so far
  codecHeaders: Record<string, string>; // Current codec-tier headers (extras.ai.codec)
  transportHeaders: Record<string, string>; // Current transport-tier headers (extras.ai.transport)
  closed: boolean; // Whether stream is complete or cancelled
}
```

The tracker is created on the first `message.create` with `stream: "true"` and keyed by the message's serial. All subsequent appends and updates for that serial are routed to the same tracker.

## Domain hooks

The decoder core delegates event building to four hooks provided by the domain codec:

| Hook                                           | Called when                           | Returns                                                  |
| ---------------------------------------------- | ------------------------------------- | -------------------------------------------------------- |
| `buildStartEvents(tracker)`                    | A new stream starts                   | Events for stream start (e.g. `text-start` chunk)        |
| `buildDeltaEvents(tracker, delta)`             | Text delta received                   | Events for the delta (e.g. `text-delta` chunk)           |
| `buildEndEvents(tracker, closingCodecHeaders)` | Stream completes (status: `complete`) | Events for stream end (e.g. `text-end`, `finish` chunks) |
| `decodeDiscrete(payload)`                      | Discrete (non-streamed) message       | Events                                                   |

Every hook returns a flat `TEvent[]` — there is no event-vs-message union. `decodeDiscrete` receives a `MessagePayload` (name, data, and the codec/transport header tiers) rather than a tracker; `buildEndEvents` receives the closing codec-tier headers, which may differ from `tracker.codecHeaders` when the closing append carried updated headers.

The codec-built `decodeDiscrete` (in `define-codec.ts`) first routes on the Ably message `name` — `ai-input` vs `ai-output` (`EVENT_AI_INPUT` / `EVENT_AI_OUTPUT`) — then dispatches on the codec `kind` header (`KIND_HEADER = "kind"`) within that direction. An `ai-input` message goes to the [input descriptor decoder](codec-interface.md#descriptor-tables), which looks the `kind` up in its descriptor table and rebuilds the input; an `ai-output` message goes to the output descriptor decoder's `decodeDiscrete`, which matches the `kind` against discrete descriptors, then a stream family's discrete fallback, then `data-*`-style wildcards. The `buildStart`/`buildDelta`/`buildEnd` hooks likewise resolve the stream family from the tracker's `kind` header. Dispatch is always by header, never by message shape.

## Append handling

When a `message.append` arrives:

1. Look up the tracker by serial
2. If no tracker exists, fall through to update handling (first-contact path)
3. Extract the string delta from `message.data` (empty string if `data` is not a string)
4. If the delta is non-empty, accumulate (`tracker.accumulated += delta`) and call `buildDeltaEvents()` to emit domain events
5. Check the transport `status` header: if `"complete"` and not already closed, call `buildEndEvents()` and mark closed - the end events are [terminal](glossary.md#terminal-event). If `"cancelled"` and not already closed, mark closed (no end events for cancels)

## Update handling: first-contact vs prefix-match

The `message.update` action handles two scenarios:

### First-contact

The decoder has no tracker for this serial - the stream started before the subscription (history, reconnect). The decoder first checks the transport `stream` header:

- If the update is **not** streamed (`stream` is not `"true"`), it is a discrete message and is delegated straight to `decodeDiscrete()`.
- If it is streamed, the decoder:

1. Creates a new tracker with the full `data` as accumulated text, marking it closed when status is `"complete"` or `"cancelled"`
2. Emits start events via `buildStartEvents()`
3. If data is non-empty, emits delta events via `buildDeltaEvents()`
4. If status is `"complete"`, emits end events via `buildEndEvents()`

This allows clients that join mid-stream or load from [history](history.md) to reconstruct the full event sequence. The [lifecycle tracker](codec-interface.md#lifecycle-tracker) builds on this by synthesizing any missing phases (e.g. a `start` chunk) that the first-contact path doesn't cover.

### Known serial: prefix-match

The decoder has an existing tracker. It checks whether the incoming data starts with the already-accumulated text:

**Prefix match** (data starts with `tracker.accumulated`):

- Extract the delta: `data.slice(tracker.accumulated.length)`
- Emit delta events for the new content
- Check for terminal status

**Not a prefix match** (data doesn't start with accumulated):

- The message was replaced entirely (e.g. [encoder recovery](encoder.md#recovery-mechanism) via `updateMessage`)
- Replace `tracker.accumulated`, `tracker.codecHeaders`, and `tracker.transportHeaders`
- Fire the `onStreamUpdate` callback (from `DecoderCoreOptions`)
- Emit no events (the full content will be visible when the decoder consumer reads the tracker)

## Delete handling

On `message.delete`:

1. Fire `onStreamDelete` callback with the serial and tracker (if one exists)
2. Mark the tracker as closed and clear accumulated text
3. Emit no events - deletion is handled by the transport layer (e.g. removing the message from the [conversation tree](conversation-tree.md#delete))

## Decoder output

The decoder core's `decode()` returns a flat `TEvent[]` — a list of domain events for the single inbound message. The core does not distinguish events from messages and does not tag events with any identity: it is purely the action-dispatch and stream-accumulation machinery.

The public codec `Decoder.decode()` (the wrapper built by `defineCodec`) returns a `DecodedMessage<TInput, TOutput>` — `{ inputs, outputs }` — splitting the core's flat list by the inbound message's wire `name`: an `ai-input` message yields only inputs, an `ai-output` message only outputs. The wire name is the authoritative direction signal, never the event's in-memory shape.

Per-message routing is the SDK's job, not the decoder's. The transport's decode-and-apply engine (`src/core/transport/decode-fold.ts`) tags each event with its wire direction via `toCodecEvents` (`src/core/codec/codec-event.ts`), producing a [`CodecEvent`](codec-interface.md#reducer-and-projection) — `{ direction: "input" | "output"; event }` — then folds it into the run's projection via the codec's `fold(state, event, meta)`. The `meta` is a [`ReducerMeta`](codec-interface.md#reducermeta--transport-derived-metadata) carrying the message `serial` and the [`codec-message-id`](wire-protocol.md#message-identity-codec-message-id) read from the inbound message. The reducer dispatches on `event.direction` (rather than inspecting shape) and uses `messageId` to route an event to the correct message within the projection — for example, correlating a `text-delta` to the message it belongs to. It does not dedup by `serial`: the transport delivers each event exactly once, in canonical order. The resulting projection surfaces on the [conversation tree](conversation-tree.md)'s `output` event.

See [Wire protocol](wire-protocol.md) for the message actions and header specification. See [Encoder](encoder.md) for the encoding side, including the recovery mechanism that produces `message.update` actions. See [Codec interface](codec-interface.md) for how domain codecs provide decoder hooks.
