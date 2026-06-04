# Runs

A run is the agent's reply to a user prompt: the user sends a message, the agent streams a response. Each turn is two nodes in the conversation tree — a client-owned **input node** (the user prompt, keyed by its `codec-message-id`, with no run id) and an agent-owned **reply run** (the streamed response, keyed by an agent-minted `runId`, parented to the input node).

Runs are the unit of cancellation, lifecycle tracking, and concurrent interaction. Each reply run has a unique `runId` minted by the agent, an owning `clientId`, and a lifecycle that progresses from start to end. The client no longer mints the run id — it owns the input node's `codec-message-id` at send time and learns the agent-minted `runId` once the agent's `ai-run-start` arrives on the channel.

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

`createRun()` is synchronous - it creates the run and registers it for cancel routing, but doesn't touch the channel. This means a cancel signal that arrives before `start()` still fires the run's `AbortSignal`.

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

// run.key    - the triggering input's codec-message-id; the synchronous routing
//              handle the client owns the moment it publishes
// run.runId  - a promise; resolves to the agent-minted run id once ai-run-start
//              is observed on the channel
// run.cancel() - cancel this specific run
// run.toInvocation() - the pointer to POST to your agent endpoint
```

The returned `ActiveRun` gives you the run's identity and a cancel handle. The agent mints the run id now, so it is not known synchronously: `run.runId` is a promise that resolves once the agent's `ai-run-start` is observed. The synchronous handle is `run.key` — the triggering input's `codec-message-id`, which the client owns the instant it publishes and which keys stream routing and cancellation. `send()` resolves as soon as your input is published to the channel — it does **not** send HTTP or block on the agent. Decoded outputs are observed on the conversation tree's `output` event (or, more usually, via the view) — see [Token streaming](../features/streaming.md). To wake a serverless agent, POST the run's invocation pointer to your endpoint yourself:

```typescript
const run = await view.send(userMessage);
await fetch('/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(run.toInvocation().toJSON()),
});
```

`run.toInvocation()` carries only identifiers (`inputEventId`, `sessionName`, and `runId` only for a continuation) — a fresh run omits `runId`, leaving the agent to mint it. The agent reads the conversation from the channel and mints both the `runId` (for a fresh run) and the `invocationId`, returning them on the response. The streamed output is available immediately from the channel subscription, not from the HTTP response. (With the Vercel `useChat` integration the chat transport issues this POST for you.)

If you need the agent-minted run id, or to know when the agent has actually picked up the run, await `run.runId`: it resolves to the run id when the agent's `ai-run-start` for this send is observed, and rejects only if the session is closed first. There is no built-in deadline — race it against your own timeout if you want to bound the wait:

```typescript
const run = await view.send(userMessage);
const runId = await Promise.race([
  run.runId,
  new Promise<string>((_, reject) => setTimeout(() => reject(new Error('agent did not start in time')), 30_000)),
]);
```

## Run lifecycle events

All clients on the channel receive run lifecycle events, regardless of who started the run:

```typescript
session.tree.on('run', (event) => {
  if (event.type === 'start') {
    // A run started: event.runId, event.clientId
  }
  if (event.type === 'suspend') {
    // A run paused awaiting input (e.g. a tool result): event.runId. The run
    // stays live — a continuation reusing the runId resumes it.
  }
  if (event.type === 'resume') {
    // A subsequent invocation re-entered the run (a continuation): event.runId.
  }
  if (event.type === 'end') {
    // A run ended (terminal): event.runId, event.clientId, event.reason
  }
});
```

Use these events to drive your own UI state. The SDK does not summarise channel events into a "set of active runs" — a session that hydrates partial history, paginates lazily, or comes online mid-conversation has not seen every run-start / run-end and cannot honestly answer "what is alive right now?" globally. Track only what you need from `tree.on('run', ...)` since the subscription was attached, or read the streaming state of a specific message off its `status` header.

## Concurrent runs

Multiple runs can be active simultaneously on the same channel. Each run has its own cancel handle and its own lifecycle events, and its outputs are routed by `inputCodecMessageId` on the tree's `output` event (the triggering input's `codec-message-id`, which the client owns from send time before the agent mints the `runId`). The server creates independent runs:

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

## The cancel signal

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
  onCancelled: async (write) => {
    // Called after abortSignal fires, before the stream closes.
    // Use write() to publish final events before the encoder closes, e.g.:
    // await write({ type: 'text-delta', textDelta: '[generation cancelled]' });
  },
});

// Pass to LLM or other async operations
const result = streamText({ model, messages, abortSignal: run.abortSignal });
```

The `onCancel` hook lets you authorize cancellation - useful for preventing one user from cancelling another user's run. It only fires for Ably cancel messages, not for the external signal. The `onCancelled` hook runs after the signal fires from either source, giving you a chance to write final data before the stream closes.

See [Platform-level cancellation](../features/cancel.md#platform-level-cancellation) for details on the `signal` option.

For the internal mechanics, see [RunManager](../internals/transport-components.md#runmanager) and [pipeStream](../internals/transport-components.md#pipestream) for how cancel signals flow through the system, and [Wire protocol](../internals/wire-protocol.md#run-lifecycle-over-the-wire) for the message sequence on the channel.
