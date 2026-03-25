# Custom Codec Example

This example shows how to build a custom codec that streams structured AI agent responses — text **and** tool calls — over a real Ably channel.

## The problem

Ably's message appends are great for streaming text tokens, but AI agent responses are more than just text. A single response might contain:

- Streamed text content (delivered incrementally as the model generates it)
- One or more tool calls (delivered as complete objects)
- Lifecycle signals (start, finish)

You need all of these to land in a single structured message on the client, not as disconnected fragments.

## Background: message appends

Ably [message updates, deletes, and appends](https://ably.com/docs/messages/updates-deletes) let you create a message on a channel and then extend its content with subsequent append operations. Subscribers see each append as it arrives in real time, and the final message contains the full accumulated content. This is the primitive the codec uses for streaming text — each token is an append to the same message, so subscribers see the text grow incrementally.

Message appends must be enabled on a per-namespace basis in your Ably app settings. The channel name must be prefixed with the namespace (e.g. `mutable:my-channel` or `ai:my-channel`).

## How the codec solves it

A codec sits between your domain events and Ably's message primitives. It decides **how** each event type maps to Ably operations:

| Domain event | Ably operation | Why |
|---|---|---|
| `text-delta` | Message **append** | Incremental delivery — each token extends the same message |
| `tool-call` | Discrete **publish** | Complete on arrival — no streaming needed |
| `start`, `finish` | Discrete **publish** | Lifecycle signals |

On the receiving side, the decoder reverses this mapping, and the accumulator assembles everything into a single `AgentMessage`:

```ts
interface AgentMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;           // ← accumulated from text-delta appends
  toolCalls: ToolCall[];  // ← collected from discrete tool-call publishes
}
```

## Files

| File | Purpose |
|---|---|
| `types.ts` | Domain types — `AgentEvent` (streaming chunks) and `AgentMessage` (assembled result) |
| `codec.ts` | The `AgentCodec` implementation — encoder, decoder, and accumulator |
| `simulate.ts` | Live roundtrip over a real Ably channel |

## Prerequisites

Set `ABLY_API_KEY` in `.env.local` at the project root (see `.env.local.example`). The Ably app must have a channel namespace with message appends enabled. Set `ABLY_NAMESPACE` to match (default: `mutable`).

## Run it

```bash
npx tsx examples/custom-codec/simulate.ts
```

## Output

```
=== Custom Codec — Live Ably Roundtrip ===

  Channel: ai:custom-codec-example-07551543

--- PUBLISH: Encoding domain events ---

  → start
  → text-delta ("Let me ")
  → text-delta ("check the ")
  → text-delta ("weather for you.")
  → text-end
  → tool-call
  → finish

--- SUBSCRIBE: Waiting for events ---

  ← start
  ← text-delta ("Let me ")
  ← text-delta ("check the weather for you.")
  ← text-end
  ← tool-call → get_weather({"city":"London","units":"celsius"})
  ← finish

--- RESULT: Assembled AgentMessage ---

  Message ID: msg-49551b4b
  Role:       assistant
  Text:       "Let me check the weather for you."
  Tool Calls: 1
    - get_weather({"city":"London","units":"celsius"})
```

Text was streamed via message appends over the wire. The tool call arrived as a discrete publish. Both were decoded and assembled into a single structured `AgentMessage` by the subscriber.

Note: text deltas may be coalesced by Ably during delivery (e.g. three published deltas arriving as two), but the accumulated result is always the full text.

## Using the codec with a transport

The `AgentCodec` implements the same `Codec<TEvent, TMessage>` interface used by the transport layer. To use it with a real Ably channel:

```ts
import { createServerTransport, createClientTransport } from '@ably/ai-transport';
import { AgentCodec } from './codec.js';

// Server side
const serverTransport = createServerTransport(channel, { codec: AgentCodec });

// Client side
const clientTransport = createClientTransport(channel, {
  codec: AgentCodec,
  sendUrl: '/api/chat',
});
```

## How the encoder works

The encoder implements `StreamEncoder<TEvent, TMessage>` (which extends `DiscreteEncoder`). It has five methods — three are called by the transport:

| Method | Called by | Purpose |
|---|---|---|
| `appendEvent(event)` | Server transport | The hot path — called for each chunk from the model's streaming response. Map events to streamed or discrete core operations. |
| `writeMessages(messages)` | Server transport | Publish one or more `TMessage`s atomically (user prompts, history entries). All messages share one `x-ably-msg-id` and form one node in the conversation tree. |
| `abort(reason?)` | Transport | Close open streams as "aborted" and publish an abort signal. |
| `writeEvent(event)` | Consumer code | Publish a standalone discrete event outside the streaming flow. Not called by the transport. Throw for streaming-only types. |
| `close()` | Transport | Flush pending appends and run recovery. Always call this. |

Inside `appendEvent`, you delegate to two encoder core primitives:

- **`startStream` / `appendStream` / `closeStream`** — for streamed content. Opens a message stream, appends each token as a delta, and closes when done. The core handles recovery automatically if any append fails.

- **`publishDiscrete`** — for discrete events. Publishes a complete, standalone message.

```ts
case 'text-delta': {
  if (!this._textStreamOpen) {
    await this._core.startStream('text', { name: 'text', data: '' });
    this._textStreamOpen = true;
  }
  this._core.appendStream('text', event.delta);  // fire-and-forget
  break;
}

case 'tool-call': {
  const h = headerWriter()
    .str('toolCallId', event.toolCallId)
    .str('toolName', event.toolName)
    .build();
  await this._core.publishDiscrete({
    name: 'tool-call',
    data: event.args,
    headers: h,
  });
  break;
}
```

## How the decoder works

The decoder provides four hooks to the decoder core:

- **`buildStartEvents(tracker)`** — called when a new message stream is created (stream opened)
- **`buildDeltaEvents(tracker, delta)`** — called on each append (text token arrived)
- **`buildEndEvents(tracker, closingHeaders)`** — called when the stream finishes
- **`decodeDiscrete(payload)`** — called for non-streaming messages (tool calls, lifecycle)

The decoder core handles all the Ably action dispatch (`message.create`, `message.append`, `message.update`) and serial tracking. Your hooks only deal with domain types.

The `tracker` parameter gives you the running state of the message stream: `name`, `streamId`, `accumulated` (all text so far), `headers`, and `closed`. This is useful when your codec has multiple stream types and needs to dispatch on `tracker.name`.

## How the accumulator works

The accumulator receives decoded events and builds `AgentMessage` objects:

- `start` → creates a new message with empty `text` and `toolCalls`
- `text-delta` → appends `delta` to the current message's `text`
- `tool-call` → pushes a new entry to the current message's `toolCalls`
- `finish` → marks the message as complete

## Building your own codec — checklist

1. **Define your `TEvent` union** — what streaming chunks does your server produce? For each event type, decide: is it a fragment of something larger (stream it) or a complete unit (publish it discretely)?

2. **Define your `TMessage` type** — what structured object does your UI consume? This is what the accumulator builds incrementally.

3. **Implement the encoder** — map each event type to encoder core operations in `appendEvent`. Implement `writeMessages` (serialize complete messages into payloads for atomic publish), `writeEvent` (standalone discrete publish — throw for streaming-only types), `abort`, and `close`.

4. **Implement the decoder** — provide four hooks to `createDecoderCore`: `buildStartEvents`, `buildDeltaEvents`, `buildEndEvents` for streamed content, and `decodeDiscrete` for everything else.

5. **Implement the accumulator** — consume `DecoderOutput` in `processOutputs` and build your `TMessage` incrementally. Handle both `kind: 'event'` (from streaming) and `kind: 'message'` (from `writeMessages`).

6. **Wire it together** — export a `Codec` object with factory methods plus `isTerminal` (when is a response done?) and `getMessageKey` (stable ID for dedup).
