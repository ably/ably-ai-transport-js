# LiveObjects

An AI Transport session channel is an ordinary Ably channel, so it can carry [LiveObjects](https://ably.com/docs/liveobjects) — synchronized shared state (`LiveMap`, `LiveCounter`) — alongside the conversation. Use it for state that lives next to the chat but isn't part of it: a shared document the agent is editing, structured task progress, votes, settings. Both sessions expose the channel's LiveObjects entry point directly as `session.object`.

Unlike presence, LiveObjects is not enabled by default — it requires the LiveObjects plugin on the Realtime client and explicit channel modes on the session.

## Enabling LiveObjects

Two things are required:

**1. Construct the Realtime client with the LiveObjects plugin:**

```typescript
import * as Ably from 'ably';
import { LiveObjects } from 'ably/liveobjects';

const ably = new Ably.Realtime({ authUrl, plugins: { LiveObjects } });
```

**2. Pass the object channel modes when creating the session**, using the `OBJECT_MODES` constant (exported from `@ably/ai-transport` and `@ably/ai-transport/react`):

```typescript
import { OBJECT_MODES } from '@ably/ai-transport';
import { createClientSession } from '@ably/ai-transport/vercel';

const session = createClientSession({
  client: ably,
  channelName,
  clientId,
  channelModes: OBJECT_MODES,
});
```

If either is missing, the underlying Ably SDK throws when you use `session.object` — accessing it without the plugin, or operating on objects without the modes — and the session does not suppress the error.

### Why explicit modes?

Object operations require the `object_subscribe` / `object_publish` channel modes, which are **not** in Ably's default mode set. On a raw Ably channel, setting `modes` _replaces_ the default set — request only the object modes and you silently lose message publish/subscribe. The session handles this for you: `channelModes` is resolved as the union of your extras with the modes AI Transport always needs, so opting into LiveObjects never affects the transport itself. A client that should only read objects can pass `['OBJECT_SUBSCRIBE']` alone — object writes then fail immediately, client-side.

The connection's token or key capability must also permit the object operations (`object-subscribe` / `object-publish`); requested modes outside the capability are simply not granted by the server.

## Using objects on a session

`clientSession.object` and `agentSession.object` return the same `RealtimeObject` instance the session's channel exposes. The session adds no semantics of its own. Like presence, object operations implicitly attach the channel, so you can use them without first awaiting `connect()`.

```typescript
// Describe the structure of the channel's objects with a type parameter.
type SessionState = { status: string };

// The channel's root object — a LiveMap.
const root = await session.object.get<SessionState>();

// Write.
await root.set('status', 'reviewing');

// Read and subscribe.
const { unsubscribe } = root.subscribe(() => {
  console.log(root.get('status').value()); // string | undefined
});
```

The API is symmetric: an agent can publish structured state during a run — progress, partial results, a shared scratchpad — and every client on the session sees it update live. Object state is persisted and synchronized to clients when they attach, so late joiners see the current state without replaying updates.

```typescript
// In the agent endpoint:
const root = await agentSession.object.get<{ progress: { step: number; of: number } }>();
await root.set('progress', { step: 2, of: 5 });
```

## React

Pass `channelModes` to the provider — it forwards all session options, and it seeds its internal ably-js `<ChannelProvider>` with the same resolved modes, so ably-js's channel hooks and the session never conflict over channel options. `channelModes` must stay constant for the provider's lifetime (the session is only recreated when `channelName` changes).

There are no first-party React hooks for LiveObjects — `ably/react` exports none, so unlike presence there is no `usePresence` equivalent to reach for. Read `session.object` from `useClientSession()` (or `useChatTransport().session`) and subscribe imperatively:

```tsx
import { useEffect, useState } from 'react';
import { OBJECT_MODES } from '@ably/ai-transport';
import { ClientSessionProvider, useClientSession } from '@ably/ai-transport/react';
import { UIMessageCodec } from '@ably/ai-transport/vercel';

function App() {
  return (
    <ClientSessionProvider
      channelName="ai:demo"
      codec={UIMessageCodec}
      clientId="user-123"
      channelModes={OBJECT_MODES}
    >
      <AgentProgress />
    </ClientSessionProvider>
  );
}

function AgentProgress() {
  const { session } = useClientSession();
  const [status, setStatus] = useState<string>();

  useEffect(() => {
    let subscription: { unsubscribe: () => void } | undefined;
    let cancelled = false;
    void session.object.get<{ status: string }>().then((root) => {
      if (cancelled) return;
      setStatus(root.get('status').value());
      subscription = root.subscribe(() => {
        setStatus(root.get('status').value());
      });
    });
    return () => {
      cancelled = true;
      subscription?.unsubscribe();
    };
  }, [session]);

  return <p>Agent status: {status ?? 'idle'}</p>;
}
```

For state that _is_ the conversation — messages, runs, branches — use the [view and tree](../concepts/sessions.md) rather than LiveObjects; the transport already syncs those. LiveObjects is for shared state alongside it.
