# Interruption

Interruption is when a user sends a new message while the AI is still streaming a response. The new message starts a new concurrent run - the previous response can continue streaming or be cancelled first.

Without interruption support, users must wait for the AI to finish before sending another message. With AI Transport, calling `view.send()` during an active run creates a new independent run immediately.

## How it works

Each `view.send()` call creates a new run with its own stream and lifecycle. There's no queue or lock - if the AI is mid-response, the new run runs alongside it.

Two patterns:

1. **Cancel and send** - stop the current response, then send. The user gets a clean break.
2. **Send alongside** - let the current response continue while starting a new one. Both runs stream concurrently.

## Cancel first, then send

The most common pattern: cancel the run that's currently streaming before sending the new message. The latest visible run carries the runId you need — read it from `session.view.runs()`, which returns a `RunInfo` per visible run with its `runId` and lifecycle `status`.

```typescript
import { useView } from '@ably/ai-transport/react';

const { send } = useView({ session });

async function handleSend(text: string) {
  // If the latest run is still live, cancel it before sending a new message.
  // RunInfo.status is 'active' while streaming and 'suspended' while paused
  // awaiting input; both are live. Terminal statuses are 'complete',
  // 'cancelled', and 'error'.
  const latest = session.view.runs().at(-1);
  if (latest && (latest.status === 'active' || latest.status === 'suspended')) {
    await session.cancel(latest.runId);
  }
  await send(codec.createUserMessage(message));
}
```

The cancel publishes a signal to the channel (see [Cancel](cancel.md)), the server cancels the current run, and the new run starts cleanly.

`send` takes a single codec input message — build a user-message input with the codec's `createUserMessage(message)` rather than passing a raw domain message.

## Send alongside (concurrent runs)

If you want both responses to continue, just call `send()` without cancelling:

```typescript
// New run starts immediately - old run keeps streaming
const run = await send(codec.createUserMessage(newMessage));
```

Both runs produce independent event streams. The message list grows with responses from both. See [Concurrent runs](concurrent-runs.md) for details.

## Detecting whether a run is streaming

Read the lifecycle status from the latest visible run. `RunInfo.status` is `'active'` while the run is producing chunks, `'suspended'` while it is paused awaiting input (still live), and one of the terminal `RunEndReason` values — `'complete'`, `'cancelled'`, or `'error'` — once it ends. When the status is `'error'`, `RunInfo.error` carries the `Ably.ErrorInfo` describing the failure. Treat `'active'` and `'suspended'` as "in progress":

```typescript
const latest = session.view.runs().at(-1);
const isStreaming = latest?.status === 'active' || latest?.status === 'suspended';
```

Use this to toggle between "Send" and "Stop" buttons, or to queue messages for later delivery.

## UI pattern: queue while streaming

A simple queue pattern — messages typed during streaming are queued and sent after the current run ends:

```typescript
if (isStreaming) {
  queue.add(text); // queued locally
} else {
  send(codec.createUserMessage(message)); // sent immediately
}
```

This avoids concurrent runs while still letting the user type freely. The queue drains automatically when the current run finishes.
