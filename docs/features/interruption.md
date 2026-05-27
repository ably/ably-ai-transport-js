# Interruption

Interruption is when a user sends a new message while the AI is still streaming a response. The new message starts a new concurrent run - the previous response can continue streaming or be cancelled first.

Without interruption support, users must wait for the AI to finish before sending another message. With AI Transport, calling `send()` during an active run creates a new independent run immediately.

## How it works

Each `send()` call creates a new run with its own stream and lifecycle. There's no queue or lock - if the AI is mid-response, the new run runs alongside it.

Two patterns:

1. **Cancel and send** - stop the current response, then send. The user gets a clean break.
2. **Send alongside** - let the current response continue while starting a new one. Both runs stream concurrently.

## Cancel first, then send

The most common pattern: cancel the run that's currently streaming before sending the new message. The latest visible message node carries the runId you need.

```typescript
import { useView } from '@ably/ai-transport/react';

const { nodes, send } = useView({ session });

async function handleSend(text: string) {
  // If the latest node is mid-run, cancel it before sending a new message
  const latest = nodes.at(-1);
  const latestRunId = latest?.headers['x-ably-run-id'];
  const latestStatus = latest?.headers['x-ably-status'];
  if (latestRunId && latestStatus !== 'complete' && latestStatus !== 'cancelled') {
    await session.cancel(latestRunId);
  }
  const msg = { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }], createdAt: new Date() };
  await send([msg]);
}
```

The cancel publishes a signal to the channel (see [Cancel](cancel.md)), the server cancels the current run, and the new run starts cleanly.

## Send alongside (concurrent runs)

If you want both responses to continue, just call `send()` without cancelling:

```typescript
// New run starts immediately - old run keeps streaming
const run = await send([newMessage]);
```

Both runs produce independent event streams. The message list grows with responses from both. See [Concurrent runs](concurrent-runs.md) for details.

## Detecting whether a run is streaming

Read the streaming state from the message you're rendering. The latest visible node carries `x-ably-status`, which is `'streaming'` while the run is producing chunks and `'complete'` / `'cancelled'` once it terminates. Users' own freshly-sent messages don't yet have a status header — treat "non-terminal" as "in progress":

```typescript
const latest = nodes.at(-1);
const status = latest?.headers['x-ably-status'];
const isStreaming = latest?.headers['x-ably-run-id'] !== undefined && status !== 'complete' && status !== 'cancelled';
```

Use this to toggle between "Send" and "Stop" buttons, or to queue messages for later delivery.

## UI pattern: queue while streaming

A simple queue pattern — messages typed during streaming are queued and sent after the current run ends:

```typescript
if (isStreaming) {
  queue.add(text); // queued locally
} else {
  send([userMessage(text)]); // sent immediately
}
```

This avoids concurrent runs while still letting the user type freely. The queue drains automatically when the current run finishes.
