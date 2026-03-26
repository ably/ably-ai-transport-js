# Turns

A turn is one request-response cycle: the user sends a message, the server streams a response. Every interaction flows through a turn, and every message on the channel belongs to exactly one turn.

Turns are the unit of cancellation, lifecycle tracking, and concurrent interaction. Each turn has a unique `turnId`, an owning `clientId`, and a lifecycle that progresses from start to end.

## Turn lifecycle

### Server side

The server controls the turn lifecycle explicitly:

```typescript
const turn = transport.newTurn({ turnId, clientId });

// 1. Publish turn-start event (visible to all clients)
await turn.start();

// 2. Publish user messages to the channel so all clients see them and they persist in history
await turn.addMessages(userMessages);

// 3. Pipe the LLM response stream through the encoder
const { reason } = await turn.streamResponse(llmStream);

// 4. Publish turn-end event with the completion reason
await turn.end(reason);
```

`newTurn()` is synchronous - it creates the turn and registers it for cancel routing, but doesn't touch the channel. This means a cancel signal that arrives before `start()` still fires the turn's abort signal.

`streamResponse()` returns a `StreamResult` with a `reason` field:

| Reason | What happened |
|---|---|
| `'complete'` | The stream finished normally |
| `'cancelled'` | A client published a cancel signal that matched this turn |
| `'error'` | The stream or encoder encountered an error |

Pass `reason` to `end()` so all clients see why the turn ended.

### Client side

The client transport creates turns implicitly when you call `send()`, `regenerate()`, or `edit()`:

```typescript
const turn = await transport.send(userMessage);

// turn.turnId - the unique turn identifier
// turn.stream - a ReadableStream of decoded events
// turn.cancel() - cancel this specific turn
```

The returned `ActiveTurn` gives you a decoded event stream and a cancel handle. The HTTP POST to your server is fire-and-forget - the stream is available immediately from the channel subscription, not from the HTTP response.

## Turn lifecycle events

All clients on the channel receive turn lifecycle events, regardless of who started the turn:

```typescript
transport.on('turn', (event) => {
  if (event.type === 'x-ably-turn-start') {
    // A turn started: event.turnId, event.clientId
  }
  if (event.type === 'x-ably-turn-end') {
    // A turn ended: event.turnId, event.clientId, event.reason
  }
});
```

Use these events to show loading indicators, track which clients are active, or coordinate multi-client interactions.

## Active turns

The client transport tracks all active turns across all clients:

```typescript
// Returns Map<clientId, Set<turnId>>
const activeTurns = transport.getActiveTurnIds();
```

In React, `useActiveTurns()` provides this as reactive state:

```typescript
import { useActiveTurns } from '@ably/ai-transport/react';

const activeTurns = useActiveTurns(transport);
const isStreaming = activeTurns.size > 0;
```

## Concurrent turns

Multiple turns can be active simultaneously on the same channel. Each turn has its own stream, its own cancel handle, and its own lifecycle events. The server creates independent turns:

```typescript
// Two turns can stream at the same time
const turnA = transport.newTurn({ turnId: 'a', clientId: 'user-1' });
const turnB = transport.newTurn({ turnId: 'b', clientId: 'user-2' });

await turnA.start();
await turnB.start();

// Each streams independently
await Promise.all([
  turnA.streamResponse(streamA).then(({ reason }) => turnA.end(reason)),
  turnB.streamResponse(streamB).then(({ reason }) => turnB.end(reason)),
]);
```

On the client, each `send()` call returns its own `ActiveTurn`. Cancellation is scoped - you can cancel one turn without affecting others. See [Concurrent turns](../features/concurrent-turns.md) for patterns.

## The abort signal

Each server-side turn exposes an `AbortSignal` that fires when the turn is cancelled:

```typescript
const turn = transport.newTurn({
  turnId,
  clientId,
  onCancel: async (request) => {
    // Return false to reject the cancel (turn continues)
    // Return true to allow it (abortSignal fires)
    return true;
  },
  onAbort: async (write) => {
    // Called after abortSignal fires, before the stream closes.
    // Use write() to publish final events before the encoder closes, e.g.:
    // await write({ type: 'text-delta', textDelta: '[generation cancelled]' });
  },
});

// Pass to LLM or other async operations
const result = streamText({ model, messages, abortSignal: turn.abortSignal });
```

The `onCancel` hook lets you authorize cancellation - useful for preventing one user from cancelling another user's turn. The `onAbort` hook runs after the signal fires, giving you a chance to write final data before the stream closes.

For the internal mechanics, see [TurnManager](../internals/transport-components.md#turnmanager) and [pipeStream](../internals/transport-components.md#pipestream) for how abort signals flow through the system, and [Wire protocol](../internals/wire-protocol.md#turn-lifecycle-over-the-wire) for the message sequence on the channel.
