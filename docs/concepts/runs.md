# Runs

A run is one request-response cycle: the user sends a message, the server streams a response. Every interaction flows through a run, and every message on the channel belongs to exactly one run.

Runs are the unit of cancellation, lifecycle tracking, and concurrent interaction. Each run has a unique `runId`, an owning `clientId`, and a lifecycle that progresses from start to end.

## Run lifecycle

### Server side

The server controls the run lifecycle explicitly:

```typescript
import { Invocation } from '@ably/ai-transport';

const run = session.createRun(Invocation.fromJSON({ runId, clientId }));

// 1. Publish run-start event (visible to all clients)
await run.start();

// 2. Publish user messages to the channel so all clients see them and they persist in history
await run.addMessages(userMessages);

// 3. Pipe the LLM response stream through the encoder
const { reason } = await run.pipe(llmStream);

// 4. Publish run-end event with the completion reason
await run.end(reason);
```

`createRun()` is synchronous - it creates the run and registers it for cancel routing, but doesn't touch the channel. This means a cancel signal that arrives before `start()` still fires the run's abort signal.

`pipe()` returns a `StreamResult` with a `reason` field:

| Reason        | What happened                                            |
| ------------- | -------------------------------------------------------- |
| `'complete'`  | The stream finished normally                             |
| `'cancelled'` | A client published a cancel signal that matched this run |
| `'error'`     | The stream or encoder encountered an error               |

Pass `reason` to `end()` so all clients see why the run ended.

### Client side

The client creates runs implicitly when you call `view.send()`, `view.regenerate()`, or `view.edit()`:

```typescript
const run = await view.send(userMessage);

// run.runId - the unique run identifier
// run.stream - a ReadableStream of decoded events
// run.cancel() - cancel this specific run
```

The returned `ActiveRun` gives you a decoded event stream and a cancel handle. The HTTP POST to your server is fire-and-forget - the stream is available immediately from the channel subscription, not from the HTTP response.

## Run lifecycle events

All clients on the channel receive run lifecycle events, regardless of who started the run:

```typescript
session.tree.on('run', (event) => {
  if (event.type === 'ai-run-start') {
    // A run started: event.runId, event.clientId
  }
  if (event.type === 'ai-run-end') {
    // A run ended: event.runId, event.clientId, event.reason
  }
});
```

Use these events to show loading indicators, track which clients are active, or coordinate multi-client interactions.

## Active runs

The client session tracks all active runs across all clients:

```typescript
// Returns Map<clientId, Set<runId>>
const activeRuns = session.tree.getActiveRunIds();
```

In React, `useActiveRuns()` provides this as reactive state:

```typescript
import { useActiveRuns } from '@ably/ai-transport/react';

const activeRuns = useActiveRuns({ session });
const isStreaming = activeRuns.size > 0;
```

## Concurrent runs

Multiple runs can be active simultaneously on the same channel. Each run has its own stream, its own cancel handle, and its own lifecycle events. The server creates independent runs:

```typescript
// Two runs can stream at the same time
const runA = session.createRun(Invocation.fromJSON({ runId: 'a', clientId: 'user-1' }));
const runB = session.createRun(Invocation.fromJSON({ runId: 'b', clientId: 'user-2' }));

await runA.start();
await runB.start();

// Each streams independently
await Promise.all([
  runA.pipe(streamA).then(({ reason }) => runA.end(reason)),
  runB.pipe(streamB).then(({ reason }) => runB.end(reason)),
]);
```

On the client, each `send()` call returns its own `ActiveRun`. Cancellation is scoped - you can cancel one run without affecting others. See [Concurrent runs](../features/concurrent-runs.md) for patterns.

## The abort signal

Each server-side run exposes an `AbortSignal` that fires when the run is cancelled. The signal has two sources: Ably cancel messages from clients, and an optional external signal (typically `req.signal`) for platform-level cancellation like request cancellation or serverless function timeout.

```typescript
import { Invocation } from '@ably/ai-transport';

const run = session.createRun(Invocation.fromJSON({ runId, clientId }), {
  signal: req.signal, // platform-level cancellation (optional)
  onCancel: async (request) => {
    // Return false to reject the cancel (run continues)
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
const result = streamText({ model, messages, abortSignal: run.abortSignal });
```

The `onCancel` hook lets you authorize cancellation - useful for preventing one user from cancelling another user's run. It only fires for Ably cancel messages, not for the external signal. The `onAbort` hook runs after the signal fires from either source, giving you a chance to write final data before the stream closes.

See [Platform-level cancellation](../features/cancel.md#platform-level-cancellation) for details on the `signal` option.

For the internal mechanics, see [RunManager](../internals/transport-components.md#runmanager) and [pipeStream](../internals/transport-components.md#pipestream) for how abort signals flow through the system, and [Wire protocol](../internals/wire-protocol.md#run-lifecycle-over-the-wire) for the message sequence on the channel.
