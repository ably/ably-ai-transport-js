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

Read the lifecycle status from the latest visible run. `RunInfo.status` is `'active'` while the run is producing chunks, `'suspended'` while it is paused awaiting input (still live), and one of the terminal `RunEndReason` values — `'complete'`, `'cancelled'`, or `'error'` — once it ends. When the status is `'error'`, `RunInfo.error` carries the `Ably.ErrorInfo` describing the failure.

Two different questions read the same status, and they have different answers for a suspended run:

```typescript
const { runs } = useView({ session });

const latest = runs().at(-1);

// Live — the run still exists on the wire, so it is worth cancelling.
const isLive = latest?.status === 'active' || latest?.status === 'suspended';

// Streaming — chunks are arriving. A suspended run is paused awaiting input,
// so there is no stream to abort: gate a Stop button on 'active' alone and let
// the user proceed via the approval or tool-result affordance.
const isStreaming = latest?.status === 'active';
```

Use `isStreaming` to toggle between "Send" and "Stop" buttons, or to queue messages for later delivery; use `isLive` to decide whether there is a run to cancel.

Take the status from the `runs()` the hook returns rather than reading `session.view` in the render body: the hook re-renders on run lifecycle transitions, so the derivation is current the moment the run ends. Outside React, subscribe to the view's `run` event for the same reason — a status change leaves the message list untouched, so `update` does not fire:

```typescript
view.on('run', () => {
  const latest = view.runs().at(-1);
  // re-render from latest.status
});
```

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
