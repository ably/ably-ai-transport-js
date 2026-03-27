# Multi-client sync

Multiple clients connected to the same Ably channel see the same conversation in real time. When one client sends a message and the server streams a response, every other client on the channel receives the same messages - no extra configuration needed.

Without multi-client support, sharing a conversation across browser tabs, devices, or users requires building synchronization infrastructure. With AI Transport, it's built into the channel subscription.

## How it works

All clients subscribe to the same Ably channel. The transport distinguishes between:

- **Own turns** - turns this client initiated via `send()`, `regenerate()`, or `edit()`. Events route to the `ActiveTurn`'s stream.
- **Observer turns** - turns from other clients. Events are decoded, accumulated via the codec's `MessageAccumulator`, and inserted into the conversation tree.

No special API is needed. Connect two clients to the same channel name, and messages sync automatically:

```typescript
// Client A
const transportA = useClientTransport({ channel, codec: UIMessageCodec, clientId: 'user-a' });

// Client B (different browser tab, device, or user)
const transportB = useClientTransport({ channel, codec: UIMessageCodec, clientId: 'user-b' });

// When Client A sends a message and the server streams a response,
// Client B sees both the user message and the assistant response
// through its channel subscription.
```

## Observer message flow

When another client's turn streams a response:

1. The transport receives Ably messages from the channel subscription
2. The decoder produces domain events from the raw Ably messages
3. A per-turn accumulator builds domain messages from the events
4. Accumulated messages are upserted into the conversation tree
5. An `'update'` notification fires on the view, updating React state

This happens for every event - observer messages stream in real time, not just at turn completion.

## Seeing who's active

`useActiveTurns` tracks all active turns from all clients:

```typescript
import { useActiveTurns } from '@ably/ai-transport/react';

const activeTurns = useActiveTurns(transport);

// activeTurns is Map<clientId, Set<turnId>>
// Show which users have active turns:
for (const [clientId, turnIds] of activeTurns) {
  console.log(`${clientId} has ${turnIds.size} active turn(s)`);
}
```

Turn lifecycle events include the `clientId`:

```typescript
transport.tree.on('turn', (event) => {
  // event.clientId tells you who started or ended the turn
  // event.type is 'x-ably-turn-start' or 'x-ably-turn-end'
});
```

## Late joiners

A client that joins mid-conversation loads history from the channel:

```typescript
const { nodes, hasOlder, loadOlder } = useView(transport, { limit: 50 });
```

History contains all messages from all clients, with their full branch structure. The late joiner sees the same conversation state as clients who were present from the start. See [History](history.md) for details.

## Using with useChat

When using the useChat path, `useMessageSync` pushes observer messages into `useChat`'s state:

```typescript
import { useMessageSync } from '@ably/ai-transport/vercel/react';

const { messages, setMessages } = useChat({ id: chatId, transport: chatTransport });
useMessageSync(transport, setMessages);

// messages now includes messages from all clients on the channel
```

Without `useMessageSync`, `useChat` would only show messages from its own sends. The sync hook replaces `useChat`'s message state with the transport's authoritative list on every update.

## Identity

Each client is identified by a `clientId` passed to the transport. The transport stamps this on outgoing messages and turn lifecycle events. Clients can use the `clientId` from message headers or turn events to show who sent what.

Client identity is established through Ably's token authentication - the `clientId` in the JWT token must match. See the [Get Started](../get-started/vercel-use-chat.md) guide for the auth setup.
