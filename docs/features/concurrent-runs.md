# Concurrent runs

Multiple runs can be active simultaneously on the same Ably channel. Each run has its own cancel handle and its own lifecycle, and its outputs are keyed by `runId` - they don't interfere with one other.

Without concurrent run support, a session must serialize interactions: one request finishes before the next starts. AI Transport allows parallel runs, enabling multi-agent patterns, interruption without cancelling, and multi-user conversations where multiple people interact at once.

## How it works

Each call to `view.send()`, `view.regenerate()`, or `view.edit()` on the client creates a new run. On the server, each incoming request calls `createRun()`. Runs are identified by `runId` and tracked by `clientId`.

```typescript
// Client: two sends in quick succession create two concurrent runs
const runA = await view.send(messageA);
const runB = await view.send(messageB);

// runId is minted by the agent, so it resolves asynchronously
const runAId = await runA.runId;

// Outputs for each run are keyed by runId on the tree's output event
session.tree.on('output', (event) => {
  if (event.runId === runAId) {
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

// Each HTTP POST creates its own run from the invocation body
const invocation = Invocation.fromJSON(await req.json());
const run = session.createRun(invocation, { signal: req.signal });
await run.start();

// Drain run.view for the conversation the triggering input produced from the channel
while (run.view.hasOlder()) await run.view.loadOlder();
const messages = run.view.getMessages().map((m) => m.message);

const result = streamText({ model, messages, abortSignal: run.abortSignal });
const { reason } = await run.pipe(result.toUIMessageStream());
await run.end({ reason });
```

Multiple runs can stream on the same channel at the same time. The agent routes each `ai-cancel` to its target run — by `run-id` for a known run, or by the triggering input's `codec-message-id` for a fresh send whose run-id has not yet been minted.

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

`session.cancel(runId)` cancels exactly one run, leaving its siblings alone. The simplest form is `run.cancel()` on the handle returned by `view.send()` — it keys on the input's `codec-message-id`, so it works even before the agent has minted the run id. To cancel by run id directly, use one you hold — `await run.runId` (the agent mints it, so it resolves once `ai-run-start` arrives), or `node.headers['run-id']` on the message node you want to stop.

See [Cancel](cancel.md) for the full cancel protocol.

## When runs run concurrently

Concurrent runs happen in these scenarios:

- **Interruption without cancel** - user sends a new message without stopping the current response (see [Interruption](interruption.md))
- **Multi-user** - two users on the same channel both send messages (see [Multi-client sync](multi-client.md))
- **Multi-agent** - a server creates multiple runs for different agents responding to the same prompt
