# Multi-client sync

Multiple clients connected to the same Ably channel see the same conversation in real time. When one client sends a message and the server streams a response, every other client on the channel receives the same messages - no extra configuration needed.

Without multi-client support, sharing a conversation across browser tabs, devices, or users requires building synchronization infrastructure. With AI Transport, it's built into the channel subscription.

## How it works

All clients subscribe to the same Ably channel. The session distinguishes between:

- **Own runs** - runs this client initiated via `send()`, `regenerate()`, or `edit()`. Events route to the `ActiveRun`'s stream.
- **Observer runs** - runs from other clients. Events are decoded, accumulated via the codec's `MessageAccumulator`, and inserted into the conversation tree.

No special API is needed. Connect two clients to the same channel name, and messages sync automatically:

```tsx
// Client A — in its own browser tab
<ClientSessionProvider channelName="ai:demo" codec={UIMessageCodec} clientId="user-a" api="/api/chat">
  <Chat />
</ClientSessionProvider>

// Client B — in a different browser tab, device, or user session
<ClientSessionProvider channelName="ai:demo" codec={UIMessageCodec} clientId="user-b" api="/api/chat">
  <Chat />
</ClientSessionProvider>

// When Client A sends a message and the server streams a response,
// Client B sees both the user message and the assistant response
// through its channel subscription.
```

## Observer message flow

When another client's run streams a response:

1. The session receives Ably messages from the channel subscription
2. The decoder produces domain events from the raw Ably messages
3. A per-run accumulator builds domain messages from the events
4. Accumulated messages are upserted into the conversation tree
5. An `'update'` notification fires on the view, updating React state

This happens for every event - observer messages stream in real time, not just at run completion.

## Seeing who's active

`useActiveRuns()` tracks all active runs from all clients:

```typescript
import { useActiveRuns } from '@ably/ai-transport/react';

const activeRuns = useActiveRuns({ session });

// activeRuns is Map<clientId, Set<runId>>
// Show which users have active runs:
for (const [clientId, runIds] of activeRuns) {
  console.log(`${clientId} has ${runIds.size} active run(s)`);
}
```

Run lifecycle events include the `clientId`:

```typescript
session.tree.on('run', (event) => {
  // event.clientId tells you who started or ended the run
  // event.type is 'ai-run-start' or 'ai-run-end'
});
```

## Late joiners

A client that joins mid-conversation loads history from the channel:

```typescript
const { nodes, hasOlder, loadOlder } = useView({ session, limit: 50 });
```

History contains all messages from all clients, with their full branch structure. The late joiner sees the same conversation state as clients who were present from the start. See [History](history.md) for details.

## Using with useChat

When using the useChat path, `useMessageSync()` pushes observer messages into `useChat()`'s state:

```typescript
import { useMessageSync } from '@ably/ai-transport/vercel/react';

const { messages, setMessages } = useChat({ id: chatId, transport: chatTransport });
useMessageSync({ setMessages });

// messages now includes messages from all clients on the channel
```

Without `useMessageSync()`, `useChat()` would only show messages from its own sends. The sync hook replaces `useChat()`'s message state with the session's authoritative list on every update.

## Identity

Each client is identified by a `clientId` passed to the session. The session stamps it on every outgoing message. Two identity tiers ride on every server-published event:

- **`runClientId`** — the client that owns the run (the one whose initiating `ai-input` started it). Constant for the run's lifetime.
- **`inputClientId`** — the clientId of the input event currently driving the agent. The agent reads it from the publisher's Ably `clientId` on the triggering `ai-input` and re-stamps it on its own publishes. May differ from `runClientId` when a continuation invocation is triggered by an input from a non-owner (e.g. another client publishes a tool result for someone else's run).

For a fresh run the two are equal. They diverge on a continuation: imagine Client A starts a run; Client B then publishes a tool-result `ai-input` against that run and POSTs the continuation. The agent's continuation `ai-run-start` carries `runClientId: A` (still A's run) and `inputClientId: B` (B published the input that drove this invocation). Every assistant output published during B's invocation carries the same pair.

UIs that need to attribute work per-invocation can read `x-ably-input-client-id` from message headers; UIs that just need "whose run is this" read `x-ably-run-client-id`. See [Wire protocol: client identity](../internals/wire-protocol.md#client-identity) for the full definition.

Client identity is established through Ably's token authentication - the `clientId` in the JWT token must match. See the [Get Started](../get-started/vercel-use-chat.md) guide for the auth setup.
