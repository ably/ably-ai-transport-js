# Concurrent runs

Multiple runs can be active simultaneously on the same Ably channel. Each run has its own stream, its own cancel handle, and its own lifecycle - they don't interfere with one other.

Without concurrent run support, a transport must serialize interactions: one request finishes before the next starts. AI Transport allows parallel runs, enabling multi-agent patterns, interruption without cancelling, and multi-user conversations where multiple people interact at once.

## How it works

Each call to `view.send()`, `view.regenerate()`, or `view.edit()` on the client creates a new run. On the server, each incoming request calls `createRun()`. Runs are identified by `runId` and tracked by `clientId`.

```typescript
// Client: two sends in quick succession create two concurrent runs
const runA = await view.send(messageA);
const runB = await view.send(messageB);

// Each has its own stream
const readerA = runA.stream.getReader();
const readerB = runB.stream.getReader();

// Cancel one without affecting the other
await runA.cancel();
```

## Server side

The server handles each run independently:

```typescript
import { Invocation } from '@ably/ai-transport';

// Each HTTP POST creates its own run
const run = session.createRun(Invocation.fromJSON({ runId, clientId }));
await run.start();

// Publish user messages to the channel so all clients see them and they persist in history
await run.addMessages(userMessages, { clientId });

const result = streamText({ model, messages, abortSignal: run.abortSignal });
const { reason } = await run.pipe(result.toUIMessageStream());
await run.end(reason);
```

Multiple runs can stream on the same channel at the same time. The transport routes cancel signals to the correct run based on the filter headers.

## Tracking active runs

The client session tracks all active runs across all clients on the channel:

```typescript
// Returns Map<clientId, Set<runId>>
const activeRuns = session.tree.getActiveRunIds();
```

In React:

```typescript
import { useActiveRuns } from '@ably/ai-transport/react';

const activeRuns = useActiveRuns(session);

// Check if any client has active runs
const isAnythingStreaming = activeRuns.size > 0;

// Check a specific client
const userRuns = activeRuns.get('user-123');
const userIsStreaming = userRuns !== undefined && userRuns.size > 0;
```

Run lifecycle events are visible to all clients:

```typescript
session.tree.on('run', (event) => {
  if (event.type === 'x-ably-run-start') {
    console.log(`${event.clientId} started run ${event.runId}`);
  }
  if (event.type === 'x-ably-run-end') {
    console.log(`${event.clientId} ended run ${event.runId}: ${event.reason}`);
  }
});
```

## Cancel scoping

Cancel filters let you target specific runs without affecting others:

| Filter                   | What gets cancelled             |
| ------------------------ | ------------------------------- |
| `{ runId: "abc" }`       | Only that one run               |
| `{ own: true }`          | All runs started by this client |
| `{ clientId: "user-2" }` | All runs started by that client |
| `{ all: true }`          | Every run on the channel        |

See [Cancel](cancel.md) for the full cancel protocol.

## When runs run concurrently

Concurrent runs happen in these scenarios:

- **Interruption without cancel** - user sends a new message without stopping the current response (see [Interruption](interruption.md))
- **Multi-user** - two users on the same channel both send messages (see [Multi-client sync](multi-client.md))
- **Multi-agent** - a server creates multiple runs for different agents responding to the same prompt
