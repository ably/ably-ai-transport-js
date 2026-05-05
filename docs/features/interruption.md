# Interruption

Interruption is when a user sends a new message while the AI is still streaming a response. The new message starts a new concurrent run - the previous response can continue streaming or be cancelled first.

Without interruption support, users must wait for the AI to finish before sending another message. With AI Transport, calling `send()` during an active run creates a new independent run immediately.

## How it works

Each `send()` call creates a new run with its own stream and lifecycle. There's no queue or lock - if the AI is mid-response, the new run runs alongside it.

Two patterns:

1. **Cancel and send** - stop the current response, then send. The user gets a clean break.
2. **Send alongside** - let the current response continue while starting a new one. Both runs stream concurrently.

## Cancel first, then send

The most common pattern: cancel active runs before sending the new message.

```typescript
import { useActiveRuns, useView } from '@ably/ai-transport/react';

const activeRuns = useActiveRuns({ session });
const { send } = useView({ session });
const isStreaming = activeRuns.size > 0;

async function handleSend(text: string) {
  // Cancel the active response before sending a new message
  if (isStreaming) {
    await session.cancel({ own: true });
  }
  const msg = { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }], createdAt: new Date() };
  await send([msg]);
}
```

The cancel publishes a signal to the channel (see [Cancel](cancel.md)), the server aborts the current run, and the new run starts cleanly.

## Send alongside (concurrent runs)

If you want both responses to continue, just call `send()` without cancelling:

```typescript
// New run starts immediately - old run keeps streaming
const run = await send([newMessage]);
```

Both runs produce independent event streams. The message list grows with responses from both. See [Concurrent runs](concurrent-runs.md) for details.

## Detecting active runs

Use `useActiveRuns()` to know whether any run is streaming:

```typescript
import { useActiveRuns } from '@ably/ai-transport/react';

const activeRuns = useActiveRuns({ session });

// Any run active on the channel (any client)
const isAnyoneStreaming = activeRuns.size > 0;

// Only this client's runs
const myRuns = clientId ? activeRuns.get(clientId) : undefined;
const amIStreaming = myRuns !== undefined && myRuns.size > 0;
```

Use this to toggle between "Send" and "Stop" buttons, or to queue messages for later delivery.

## UI pattern: queue while streaming

The use-client-session demo shows a queue pattern - messages typed during streaming are queued and sent after the current run ends:

```typescript
// Simplified queue pattern
if (isStreaming) {
  queue.add(text); // queued locally
} else {
  send([userMessage(text)]); // sent immediately
}
```

This avoids concurrent runs while still letting the user type freely. The queue drains automatically when the current run finishes.
