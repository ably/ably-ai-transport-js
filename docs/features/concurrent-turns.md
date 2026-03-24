# Concurrent turns

Multiple turns can be active simultaneously on the same Ably channel. Each turn has its own stream, its own cancel handle, and its own lifecycle — they don't interfere with each other.

Without concurrent turn support, a transport must serialize interactions: one request finishes before the next starts. AI Transport allows parallel turns, enabling multi-agent patterns, barge-in without cancelling, and multi-user conversations where multiple people interact at once.

## How it works

Each call to `send()`, `regenerate()`, or `edit()` on the client creates a new turn. On the server, each incoming request calls `newTurn()`. Turns are identified by `turnId` and tracked by `clientId`.

```typescript
// Client: two sends in quick succession create two concurrent turns
const turnA = await transport.send(messageA);
const turnB = await transport.send(messageB);

// Each has its own stream
const readerA = turnA.stream.getReader();
const readerB = turnB.stream.getReader();

// Cancel one without affecting the other
await turnA.cancel();
```

## Server side

The server handles each turn independently:

```typescript
// Each HTTP POST creates its own turn
const turn = transport.newTurn({ turnId, clientId });
await turn.start();

// Publish user messages to the channel so all clients see them and they persist in history
await turn.addMessages(userMessages, { clientId });

const result = streamText({ model, messages, abortSignal: turn.abortSignal });
const { reason } = await turn.streamResponse(result.toUIMessageStream());
await turn.end(reason);
```

Multiple turns can stream on the same channel at the same time. The transport routes cancel signals to the correct turn based on the filter headers.

## Tracking active turns

The client transport tracks all active turns across all clients on the channel:

```typescript
// Returns Map<clientId, Set<turnId>>
const activeTurns = transport.getActiveTurnIds();
```

In React:

```typescript
import { useActiveTurns } from '@ably/ably-ai-transport-js/react';

const activeTurns = useActiveTurns(transport);

// Check if any client has active turns
const isAnythingStreaming = activeTurns.size > 0;

// Check a specific client
const userTurns = activeTurns.get('user-123');
const userIsStreaming = userTurns !== undefined && userTurns.size > 0;
```

Turn lifecycle events are visible to all clients:

```typescript
transport.on('turn', (event) => {
  if (event.type === 'x-ably-turn-start') {
    console.log(`${event.clientId} started turn ${event.turnId}`);
  }
  if (event.type === 'x-ably-turn-end') {
    console.log(`${event.clientId} ended turn ${event.turnId}: ${event.reason}`);
  }
});
```

## Cancel scoping

Cancel filters let you target specific turns without affecting others:

| Filter | What gets cancelled |
|---|---|
| `{ turnId: "abc" }` | Only that one turn |
| `{ own: true }` | All turns started by this client |
| `{ clientId: "user-2" }` | All turns started by that client |
| `{ all: true }` | Every turn on the channel |

See [Cancel](cancel.md) for the full cancel protocol.

## When turns run concurrently

Concurrent turns happen in these scenarios:

- **Barge-in without cancel** — user sends a new message without stopping the current response (see [Barge-in](barge-in.md))
- **Multi-user** — two users on the same channel both send messages (see [Multi-client sync](multi-client.md))
- **Multi-agent** — a server creates multiple turns for different agents responding to the same prompt
- **Parallel tool execution** — a server creates separate turns for parallel tool call results
