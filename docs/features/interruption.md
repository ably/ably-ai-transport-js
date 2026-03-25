# Interruption

Interruption is when a user sends a new message while the AI is still streaming a response. The new message starts a new concurrent turn - the previous response can continue streaming or be cancelled first.

Without interruption support, users must wait for the AI to finish before sending another message. With AI Transport, calling `send()` during an active turn creates a new independent turn immediately.

## How it works

Each `send()` call creates a new turn with its own stream and lifecycle. There's no queue or lock - if the AI is mid-response, the new turn runs alongside it.

Two patterns:

1. **Cancel and send** - stop the current response, then send. The user gets a clean break.
2. **Send alongside** - let the current response continue while starting a new one. Both turns stream concurrently.

## Cancel first, then send

The most common pattern: cancel active turns before sending the new message.

```typescript
import { useActiveTurns, useSend } from '@ably/ai-transport/react';

const activeTurns = useActiveTurns(transport);
const send = useSend(transport);
const isStreaming = activeTurns.size > 0;

async function handleSend(text: string) {
  // Cancel the active response before sending a new message
  if (isStreaming) {
    await transport.cancel({ own: true });
  }
  const msg = { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }], createdAt: new Date() };
  await send([msg]);
}
```

The cancel publishes a signal to the channel (see [Cancel](cancel.md)), the server aborts the current turn, and the new turn starts cleanly.

## Send alongside (concurrent turns)

If you want both responses to continue, just call `send()` without cancelling:

```typescript
// New turn starts immediately - old turn keeps streaming
const turn = await send([newMessage]);
```

Both turns produce independent event streams. The message list grows with responses from both. See [Concurrent turns](concurrent-turns.md) for details.

## Detecting active turns

Use `useActiveTurns` to know whether any turn is streaming:

```typescript
import { useActiveTurns } from '@ably/ai-transport/react';

const activeTurns = useActiveTurns(transport);

// Any turn active on the channel (any client)
const isAnyoneStreaming = activeTurns.size > 0;

// Only this client's turns
const myTurns = clientId ? activeTurns.get(clientId) : undefined;
const amIStreaming = myTurns !== undefined && myTurns.size > 0;
```

Use this to toggle between "Send" and "Stop" buttons, or to queue messages for later delivery.

## UI pattern: queue while streaming

The use-client-transport demo shows a queue pattern - messages typed during streaming are queued and sent after the current turn ends:

```typescript
// Simplified queue pattern
if (isStreaming) {
  queue.add(text);  // queued locally
} else {
  send([userMessage(text)]);  // sent immediately
}
```

This avoids concurrent turns while still letting the user type freely. The queue drains automatically when the current turn finishes.
