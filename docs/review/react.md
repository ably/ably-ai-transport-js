# React Layer Review

I think the main problem with the React layer is how we handle client transport lifecycle,
I think we should align it with Ably channel lifecycle and also make it more explicit for users.

## `useClientTransport` — Transport Lifecycle Mismatch

### Problem

`ClientTransport` is a stateful, long-lived object. It holds the conversation tree, the message store, active turn tracking, history pagination state, and all Ably channel subscriptions. Every other hook (`useMessages`, `useActiveTurns`, `useHistory`, `useConversationTree`, etc.) derives its state from the transport — it is the single source of truth for the entire conversation.

The current `useClientTransport` hook stores the transport in a `useRef` and never closes it on unmount.
The transport's lifetime is tied to React component with this hook.
If this host component unmounts (e.g. navigating away and back), the ref is lost. The next mount creates a **new** transport, discarding all accumulated conversation state.

We also never close the transport anywhere. This can lead to memory leaks.

### Options

**Option 1 — Transport Provider (preferred)**

Introduce a `TransportProvider` that manages the transport's lifetime at the application level. The transport is created once, stored in React context, and survives child component unmounts. All hooks read from context instead of accepting a transport prop.

It can replace `ChannelProvider` (basically it will create `ChannelProvider` itself) - Preffered option:

```tsx
<TransportProvider channelName={channelName}>
  <ChatUI />
</TransportProvider>
```

or used as an additional provider:

```tsx
<ChannelProvider channelName={channelName}>
  <TransportProvider channelName={channelName}>
    <ChatUI />
  </TransportProvider>
</ChannelProvider>
```

`TransportProvider` can also be used to close the transport when the provider unmounts.

**Option 2 — User-managed transport**

Delete `useClientTransport` and require users to create the transport outside the React tree, passing it as a prop or via context they manage themselves. This makes the lifetime contract explicit — the user is responsible for creating and, eventually, closing the transport.

```ts
// Outside React
const transport = createClientTransport({ channel, codec: UIMessageCodec });

// Inside React
function ChatUI() {
  const messages = useMessages(transport);
  ...
}
```

This is simple and honest about the ownership model, but pushes complexity onto users.

**Option 3 — SDK-managed transport cache**

Maintain a `Map` keyed by channel name outside React. `useClientTransport` looks up an existing transport from the cache before creating a new one, and never creates two transports for the same channel. The cache is module-level, surviving React tree remounts.

```ts
const transportCache = new Map<string, ClientTransport<...>>();
```

This is pragmatic but has awkward implications: cache invalidation, memory leaks if the cache is never pruned, and surprising behaviour when options change (stale cached instance with old options). Not recommended without a clear eviction strategy.

### Recommendation

Implement Option 1. Define a `TransportProvider` that owns both the channel and transport lifetimes, and expose a `useClientTransport()` context hook.

---

## `useHistory` — Silent No-Op on Missing Transport

The hook accepts `null` / `undefined` transport and silently does nothing: `load()` and `next()` return immediately, `hasNext` stays `false`. This is inconsistent with `useMessages` and `useAblyMessages` which require a transport. The silent no-op makes it hard to debug situations where the transport was not wired up correctly.

**Recommendation:** Either align all hooks to require a transport (fail loudly at the call site) or align all hooks to accept optional transport (consistent null-safe API).

---

## `useActiveTurns` — Map

Small thing, but it's a bit odd looking how we handle map and set updates, maybe it will be easier to return object literals (`Record<string, string[]>`) instead?
