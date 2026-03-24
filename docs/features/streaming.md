# Token streaming

AI Transport streams LLM tokens over Ably using message appends — each token is appended to a persistent message on the channel, so the response builds up incrementally and survives disconnection.

Without a durable transport, streaming responses are ephemeral: if the connection drops, the partial response is lost. Ably's message appends persist the accumulated text, so a reconnecting or late-joining client sees the full response from channel history.

## How it works

The server encoder creates an Ably message for each content stream (text, reasoning, tool input) and appends token deltas as they arrive. The client decoder accumulates these appends into complete messages.

```
Server Encoder                   Ably Channel                    Client Decoder
  |                                  |                                |
  |-- publish (create, status:streaming)->|                                |
  |-- append "Hello" --------------->|                                |
  |                                  |-- deliver append ------------->|
  |                                  |                                |-- accumulate "Hello"
  |-- append " world" -------------->|                                |
  |                                  |-- deliver append ------------->|
  |                                  |                                |-- accumulate "Hello world"
  |-- append (status:finished) ----->|                                |
  |                                  |-- deliver append ------------->|
  |                                  |                                |-- stream complete
```

Each stream has a lifecycle tracked by the `x-ably-status` header:

| Status | Meaning |
|---|---|
| `streaming` | Stream is open, more appends expected |
| `finished` | Stream completed normally |
| `aborted` | Stream was cancelled or errored |

## Server

Pipe any `ReadableStream` of codec events through the turn's `streamResponse`:

```typescript
import { streamText } from 'ai';
import { createServerTransport } from '@ably/ably-ai-transport-js/vercel';

const transport = createServerTransport({ channel });
const turn = transport.newTurn({ turnId, clientId });

await turn.start();

// Publish user messages to the channel so all clients see them and they persist in history
await turn.addMessages(userMessages, { clientId });

const result = streamText({ model, messages: conversationHistory, abortSignal: turn.abortSignal });
const { reason } = await turn.streamResponse(result.toUIMessageStream());
await turn.end(reason);

transport.close();
```

`streamResponse` reads events from the stream and routes them through the encoder. Text deltas become message appends; lifecycle events (finish, error) become discrete messages that close the stream.

## Client

On the client, decoded events arrive via the `ActiveTurn`'s stream, or as accumulated messages via `getMessages()`:

```typescript
// Option 1: consume the raw event stream
const turn = await transport.send(userMessage);
const reader = turn.stream.getReader();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  // value is a UIMessageChunk (text-delta, finish, etc.)
}

// Option 2: subscribe to accumulated messages
const unsubscribe = transport.on('message', () => {
  const messages = transport.getMessages();
  // messages updates on every append — the last assistant message grows as tokens arrive
});
```

## Recovery

Appends are pipelined — the encoder fires each append without waiting for acknowledgement, so tokens flow with minimal latency. If an append fails (e.g. during a brief network interruption), the message on the channel is now missing a chunk. Continuing to append deltas would build on incomplete text. The encoder recovers by issuing an `updateMessage` that replaces the entire message content with the full accumulated text it has been tracking locally, then resumes appending from that corrected state.

Late-joining clients receive the final message from channel history, which contains the fully accumulated text regardless of whether individual appends were missed.

## What streams through

The transport streams whatever events the codec produces. For the Vercel AI SDK codec (`UIMessageCodec`), these are `UIMessageChunk` events:

| Chunk type | Ably encoding |
|---|---|
| `text-delta` | Message append |
| `reasoning-delta` | Message append (separate stream) |
| `tool-input-delta` | Message append (per tool call) |
| `tool-output-available` | Discrete message |
| `finish` | Discrete message (terminal — closes the stream) |
| `error` | Discrete message (terminal — closes the stream with error) |

Multiple content streams can be active within a single turn (e.g., reasoning + text, or multiple tool calls). Each gets its own message with its own stream ID.

See [React hooks reference](../reference/react-hooks.md) for the full `useMessages` and `useClientTransport` API. See [Cancel](cancel.md) for how streams are aborted. For the internal mechanics of message encoding, decoding, and recovery, see the [Encoder](../internals/encoder.md), [Decoder](../internals/decoder.md), and [Wire protocol](../internals/wire-protocol.md) internals pages.
