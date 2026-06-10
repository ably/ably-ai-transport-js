# Presence

An AI Transport session channel is an ordinary Ably channel, so it carries [Presence](https://ably.com/docs/presence-occupancy/presence) like any other channel. Use it to see which clients are currently connected to a session. Both sessions expose the channel's presence object directly as `session.presence`, and ably-js's presence hooks work inside the React providers with no extra wiring.

## Presence on a session

`clientSession.presence` and `agentSession.presence` return the same `Ably.RealtimePresence` instance the session's channel exposes. The session adds no semantics of its own: every presence operation (`enter`, `update`, `leave`, `get`, `subscribe`) behaves exactly as it does on a raw Ably channel. Presence operations implicitly attach the channel, so you can call them without first awaiting `connect()`.

## See who is connected

Enter presence to mark a participant as online, and subscribe to track the set as participants come and go:

```typescript
const session = createClientSession({ client: ably, channelName });

await session.presence.enter();

session.presence.subscribe((member) => {
  console.log(member.clientId, member.action); // 'enter' | 'leave' | ...
});

const members = await session.presence.get();
```

Presence is symmetric — agents and users enter the same presence set, distinguished by `clientId`. If a participant's role isn't clear from its `clientId`, pass presence data on `enter` to label it:

```typescript
await session.presence.enter({ role: 'agent' });
```

## React

`ClientSessionProvider` (and `ChatTransportProvider`, which wraps it) renders an ably-js `<ChannelProvider>` for the session's channel. ably-js's channel hooks — [`usePresence`](https://ably.com/docs/getting-started/react#usePresence), [`usePresenceListener`](https://ably.com/docs/getting-started/react#usePresenceListener), and `useChannel` — therefore work for any descendant without wrapping the subtree in your own `<ChannelProvider>`. Pass the same `channelName` you gave the provider:

```tsx
import { usePresence, usePresenceListener } from 'ably/react';
import { ClientSessionProvider } from '@ably/ai-transport/react';
import { UIMessageCodec } from '@ably/ai-transport/vercel';

function App() {
  return (
    <ClientSessionProvider
      channelName="ai:demo"
      codec={UIMessageCodec}
    >
      <OnlineList />
    </ClientSessionProvider>
  );
}

function OnlineList() {
  // Enter presence on the session channel.
  usePresence({ channelName: 'ai:demo' });

  // Read the current presence set.
  const { presenceData } = usePresenceListener({ channelName: 'ai:demo' });

  return (
    <ul>
      {presenceData.map((member) => (
        <li key={member.clientId}>{member.clientId}</li>
      ))}
    </ul>
  );
}
```

To track whether the agent is actively working on a run, read it from the conversation itself — `view.runs()` reflects run lifecycle from the channel — rather than from presence. See [Multi-client sync](multi-client.md).
