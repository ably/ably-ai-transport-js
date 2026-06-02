# Concurrent runs

Multiple runs can be active simultaneously on the same Ably channel. Each run has its own cancel handle and its own lifecycle, and its outputs are keyed by `runId` - they don't interfere with one other.

Without concurrent run support, a session must serialize interactions: one request finishes before the next starts. AI Transport allows parallel runs, enabling multi-agent patterns, interruption without cancelling, and multi-user conversations where multiple people interact at once.

## How it works

Each call to `view.send()`, `view.regenerate()`, or `view.edit()` on the client creates a new run. On the server, each incoming request calls `createRun()`. Runs are identified by `runId` and tracked by `clientId`.

```typescript
// Client: two sends in quick succession create two concurrent runs
const runA = await view.send(messageA);
const runB = await view.send(messageB);

// Outputs for each run are keyed by runId on the tree's output event
session.tree.on('output', (event) => {
  if (event.runId === runA.runId) {
    /* run A's chunks */
  }
});

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

Multiple runs can stream on the same channel at the same time. Each `ai-cancel` carries `run-id` and the session routes it to that one run.

## Observing run lifecycle

Run lifecycle events are visible to all clients on the channel:

```typescript
session.tree.on('run', (event) => {
  if (event.type === 'start') {
    console.log(`${event.clientId} started run ${event.runId}`);
  }
  if (event.type === 'end') {
    console.log(`${event.clientId} ended run ${event.runId}: ${event.reason}`);
  }
});
```

This event is the raw signal — each `run-start` and `run-end` is emitted once, as it arrives. The SDK does not summarise these into a "set of active runs", because a session that hydrates partial history or comes online mid-conversation cannot honestly compute that set. Accumulate state yourself from your subscription if your UI needs it, treating it as a "since I subscribed" view.

For the "is this rendered message still streaming?" question, read `node.headers['status']` on the node itself — it's intrinsic to the node and unaffected by what older history the session has hydrated.

## Cancelling individual runs

`session.cancel(runId)` cancels exactly one run, leaving its siblings alone. Use a runId you obtained directly — from `run.runId` on the handle returned by `view.send()`, or from `node.headers['run-id']` on the message node you want to stop.

See [Cancel](cancel.md) for the full cancel protocol.

## When runs run concurrently

Concurrent runs happen in these scenarios:

- **Interruption without cancel** - user sends a new message without stopping the current response (see [Interruption](interruption.md))
- **Multi-user** - two users on the same channel both send messages (see [Multi-client sync](multi-client.md))
- **Multi-agent** - a server creates multiple runs for different agents responding to the same prompt
