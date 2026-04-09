# React hooks

API reference for all React hooks and providers in the SDK. Generic hooks work with any codec; Vercel hooks are specific to the `useChat()` integration path.

## Generic hooks and providers

Import from `@ably/ai-transport/react`.

---

### TransportProvider

Create a `ClientTransport` and make it available to descendant components. Wraps children with Ably's `ChannelProvider` internally.

```tsx
<TransportProvider channelName="ai:demo" codec={UIMessageCodec} clientId={clientId}>
  <Chat />
</TransportProvider>
```

| Prop | Type | Description |
|---|---|---|
| `channelName` | `string` | The Ably channel name to subscribe to |
| `codec` | `Codec<TEvent, TMessage>` | The codec for encoding/decoding |
| `name` | `string?` | Transport name for multi-transport scenarios. Default: `"default"` |
| `clientId` | `string?` | Client identity, sent to the server in POST body |
| `api` | `string?` | Server endpoint URL. Default: `"/api/chat"` |
| `headers` | `Record<string, string> \| (() => Record<string, string>)?` | HTTP POST headers. Function form for dynamic values |
| `body` | `Record<string, unknown> \| (() => Record<string, unknown>)?` | Additional POST body fields. Function form for dynamic values |
| `credentials` | `RequestCredentials?` | Fetch credentials mode |
| `fetch` | `typeof fetch?` | Custom fetch implementation |
| `messages` | `TMessage[]?` | Initial messages to seed the conversation tree |
| `logger` | `Logger?` | Logger instance |
| `children` | `ReactNode?` | Child components that will have access to this transport |

The transport subscribes to the Ably channel immediately on creation. It does not auto-close on unmount — channel lifecycle is managed by the internal `ChannelProvider`.

For multiple transports, nest providers with distinct `name` values:

```tsx
<TransportProvider name="main" channelName="ai:main" codec={UIMessageCodec}>
  <TransportProvider name="aux" channelName="ai:aux" codec={UIMessageCodec}>
    <App />
  </TransportProvider>
</TransportProvider>
```

---

### useClientTransport

Access the `ClientTransport` from the nearest `TransportProvider`.

```typescript
const transport = useClientTransport<TEvent, TMessage>(name?: string);
```

| Parameter             | Type                                                          | Description                                                   |
| --------------------- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| `name`    | `string?`                                                     | Transport name to look up. Defaults to `"default"`. Must match the `name` prop on the enclosing `TransportProvider`              |

**Returns:** `ClientTransport<TEvent, TMessage>`                                                 — the transport instance                                               created by the enclosing `TransportProvider`.

**Throws:** `Ably.ErrorInfo` (code `40000`) if no `TransportProvider` with the given name is found in the component tree.

```typescript
// Default transport (most common case)
const transport = useClientTransport<UIMessageChunk, UIMessage>();

// Named transport
const transport = useClientTransport<UIMessageChunk, UIMessage>('main');
```

---

### useView

Subscribe to a view and return nodes with pagination, branch navigation, and write operations. Accepts either a `ClientTransport` (uses its default view) or a `View` directly.

```typescript
const view = useView<TEvent, TMessage>(
  source: ClientTransport<TEvent, TMessage> | View<TEvent, TMessage> | null | undefined,
  options?: UseViewOptions | null,
);
```

| Parameter       | Type                                           | Description                                                                      |
| --------------- | ---------------------------------------------- | -------------------------------------------------------------------------------- |
| `source`        | `ClientTransport \| View \| null \| undefined` | The transport (uses its default view) or a View directly                         |
| `options`       | `UseViewOptions \| null?`                      | When provided, auto-loads first page on mount. Omit or pass null for manual load |
| `options.limit` | `number?`                                      | Max messages per page. Default: 100                                              |

**Returns:** `ViewHandle<TEvent, TMessage>`

| Property/Method                          | Type                                                                                                             | Description                                                                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `nodes`                                  | `MessageNode<TMessage>[]`                                                                                        | Flattened nodes for the current branch. Updates on every message change (including streaming deltas)                              |
| `messages`                               | `TMessage[]`                                                                                                     | The visible domain messages (shorthand for `nodes.map(n => n.message)`)                                                           |
| `hasOlder`                               | `boolean`                                                                                                        | Are there older pages? False until history has been loaded                                                                        |
| `loading`                                | `boolean`                                                                                                        | Is a page being fetched?                                                                                                          |
| `loadOlder()`                            | `() => Promise<void>`                                                                                            | Load more older messages                                                                                                          |
| `select(msgId, index)`                   | `(msgId: string, index: number) => void`                                                                         | Switch to a sibling branch. Triggers re-render                                                                                    |
| `getSelectedIndex(msgId)`                | `(msgId: string) => number`                                                                                      | Index of the currently selected sibling                                                                                           |
| `getSiblings(msgId)`                     | `(msgId: string) => TMessage[]`                                                                                  | All alternatives at a fork point                                                                                                  |
| `hasSiblings(msgId)`                     | `(msgId: string) => boolean`                                                                                     | Whether to show navigation arrows                                                                                                 |
| `getNode(msgId)`                         | `(msgId: string) => MessageNode<TMessage> \| undefined`                                                          | Look up a node by msgId                                                                                                           |
| `send(messages, options?)`               | `(messages: TMessage \| TMessage[], options?: SendOptions) => Promise<ActiveTurn<TEvent>>`                       | Send messages in this view's branch context                                                                                       |
| `regenerate(messageId, options?)`        | `(messageId: string, options?: SendOptions) => Promise<ActiveTurn<TEvent>>`                                      | Fork an assistant message with no new user input                                                                                  |
| `edit(messageId, newMessages, options?)` | `(messageId: string, newMessages: TMessage \| TMessage[], options?: SendOptions) => Promise<ActiveTurn<TEvent>>` | Fork a user message with replacement content                                                                                      |
| `update(msgId, events, options?)`        | `(msgId: string, events: TEvent[], options?: SendOptions) => Promise<ActiveTurn<TEvent>>`                        | Update an existing message and start a continuation turn (e.g. [tool results](../features/tool-calling.md#client-executed-tools)) |

Each view has independent branch selections and pagination state. When you pass a transport, the hook uses its default view. For [split-pane UIs](../features/branching.md#multiple-views) where each pane needs its own branch and message history, use [`useCreateView()`](#usecreateview) to create independent views with the same API.

Write operations (`send`, `regenerate`, `edit`) automatically derive the parent message and conversation history from this view's selected branch.

`update` amends an existing message and starts a continuation turn. The tree updates optimistically before sending. Used for [client-executed tool results](../features/tool-calling.md#client-executed-tools) - the tool output is sent to the server in the POST body, published to the channel, and the model streams a follow-up response in the same turn.

---

### useCreateView

Create an independent view with the same API as [`useView()`](#useview). The view is created via `transport.createView()` and closed automatically on unmount or when the transport changes.

```typescript
const handle = useCreateView<TEvent, TMessage>(
  transport: ClientTransport<TEvent, TMessage> | null | undefined,
  options?: UseViewOptions | null,
);
```

| Parameter       | Type                                   | Description                                                                      |
| --------------- | -------------------------------------- | -------------------------------------------------------------------------------- |
| `transport`     | `ClientTransport \| null \| undefined` | The transport to create a view from. Pass null/undefined to defer creation       |
| `options`       | `UseViewOptions \| null?`              | When provided, auto-loads first page on mount. Omit or pass null for manual load |
| `options.limit` | `number?`                              | Max messages per page. Default: 100                                              |

**Returns:** `ViewHandle<TEvent, TMessage>` - the same handle type as `useView()`, with nodes, pagination, navigation, and write operations. Returns an empty handle (no nodes, no messages) when no transport is provided.

```typescript
import { useView, useCreateView } from '@ably/ai-transport/react';

const view = useView(transport, { limit: 50 }); // default view
const splitView = useCreateView(split ? transport : undefined, { limit: 50 }); // independent view
```

Each view has its own branch selections and pagination state - selecting a sibling in one view does not affect any other view. Both views share the same underlying conversation tree, so new messages appear in both.

See [Multiple views](../features/branching.md#multiple-views) for the full split-pane pattern.

---

### useSend

Return a stable send callback bound to a view.

```typescript
const send = useSend<TEvent, TMessage>(view: View<TEvent, TMessage>);

const turn = await send(messages, options?);
```

| Parameter | Type                     | Description              |
| --------- | ------------------------ | ------------------------ |
| `view`    | `View<TEvent, TMessage>` | The view to send through |

**Returns:** `(messages: TMessage[], options?: SendOptions) => Promise<ActiveTurn<TEvent>>`

The returned function sends one or more messages in a new turn, using the view's branch for parent and history computation. Returns an `ActiveTurn` with:

- `turn.stream` - `ReadableStream<TEvent>` of decoded events
- `turn.turnId` - the turn's unique ID
- `turn.cancel()` - cancel this specific turn

`ViewHandle` from `useView()` already includes `send()` - use `useSend()` separately when you need a standalone stable callback without the full view subscription.

---

### useRegenerate

Return a stable regenerate callback. Forks an assistant message with no new user input.

```typescript
const regenerate = useRegenerate<TEvent, TMessage>(view: View<TEvent, TMessage>);

const turn = await regenerate(messageId, options?);
```

| Parameter | Type                     | Description                    |
| --------- | ------------------------ | ------------------------------ |
| `view`    | `View<TEvent, TMessage>` | The view to regenerate through |

**Returns:** `(messageId: string, options?: SendOptions) => Promise<ActiveTurn<TEvent>>`

Automatically computes `forkOf`, `parent`, and truncated history from the view's selected branch. Throws `Ably.ErrorInfo` if the target message doesn't exist in the tree.

---

### useEdit

Return a stable edit callback. Forks a user message with replacement content.

```typescript
const edit = useEdit<TEvent, TMessage>(view: View<TEvent, TMessage>);

const turn = await edit(messageId, newMessages, options?);
```

| Parameter | Type                     | Description              |
| --------- | ------------------------ | ------------------------ |
| `view`    | `View<TEvent, TMessage>` | The view to edit through |

**Returns:** `(messageId: string, newMessages: TMessage | TMessage[], options?: SendOptions) => Promise<ActiveTurn<TEvent>>`

Automatically computes `forkOf`, `parent`, and history from the view's selected branch. Throws `Ably.ErrorInfo` if the target message doesn't exist in the tree.

---

### useActiveTurns

Return a reactive map of all active turns on the channel, keyed by clientId.

```typescript
const activeTurns = useActiveTurns<TEvent, TMessage>(transport: ClientTransport<TEvent, TMessage> | null | undefined);
```

| Parameter   | Type                                   | Description                                                        |
| ----------- | -------------------------------------- | ------------------------------------------------------------------ |
| `transport` | `ClientTransport \| null \| undefined` | The transport to observe. Pass null/undefined if not yet available |

**Returns:** `Map<string, Set<string>>` - keys are clientIds, values are sets of active turnIds. Empty map if transport is null.

Updates on every turn start/end event. Includes turns from all clients on the channel.

---

### useTree

Provide stable structural query callbacks for the conversation tree.

```typescript
const tree = useTree<TEvent, TMessage>(transport: ClientTransport<TEvent, TMessage>);
```

| Parameter   | Type                                | Description                       |
| ----------- | ----------------------------------- | --------------------------------- |
| `transport` | `ClientTransport<TEvent, TMessage>` | The transport whose tree to query |

**Returns:** `TreeHandle<TMessage>`

| Property/Method      | Type                                                    | Description                       |
| -------------------- | ------------------------------------------------------- | --------------------------------- |
| `getSiblings(msgId)` | `(msgId: string) => TMessage[]`                         | All alternatives at a fork point  |
| `hasSiblings(msgId)` | `(msgId: string) => boolean`                            | Whether to show navigation arrows |
| `getNode(msgId)`     | `(msgId: string) => MessageNode<TMessage> \| undefined` | Look up a node by msgId           |

Branch navigation (`select()`, `getSelectedIndex()`) and write operations (`send()`, `regenerate()`, `edit()`) are on `ViewHandle` from `useView()`, not `TreeHandle`. The tree provides structural queries that are the same regardless of which branch is selected.

---

### useAblyMessages

Subscribe to raw Ably message updates. Useful for debugging.

```typescript
const messages = useAblyMessages<TEvent, TMessage>(transport: ClientTransport<TEvent, TMessage>);
```

| Parameter   | Type                                | Description              |
| ----------- | ----------------------------------- | ------------------------ |
| `transport` | `ClientTransport<TEvent, TMessage>` | The transport to observe |

**Returns:** `Ably.InboundMessage[]` - raw Ably messages in chronological order. Includes live and history-loaded messages.

---

## Vercel hooks

Import from `@ably/ai-transport/vercel/react`.

---

### useChatTransport

Create and memoize a `ChatTransport` for Vercel's `useChat()` hook.

```typescript
const chatTransport = useChatTransport(
  transportOrOptions: ClientTransport<UIMessageChunk, UIMessage> | VercelClientTransportOptions,
  chatOptions?: ChatTransportOptions,
);
```

| Parameter            | Type                                              | Description                                         |
| -------------------- | ------------------------------------------------- | --------------------------------------------------- |
| `transportOrOptions` | `ClientTransport \| VercelClientTransportOptions` | An existing transport, or options to create one     |
| `chatOptions`        | `ChatTransportOptions?`                           | Optional hooks for customizing request construction |

**Returns:** `ChatTransport` - compatible with `useChat()`'s `transport` option.

Two usage patterns:

1. **Wrap an existing transport** - pass a `ClientTransport` created by `useClientTransport`
2. **Create internally** - pass `VercelClientTransportOptions` and the hook creates the transport with `UIMessageCodec`

`ChatTransportOptions.prepareSendMessagesRequest` lets you customize the HTTP POST body and headers:

```typescript
const chatTransport = useChatTransport(transport, {
  prepareSendMessagesRequest: (context) => ({
    body: { history: context.history, sessionId: mySessionId },
    headers: { 'x-custom': 'value' },
  }),
});
```

---

### useMessageSync

Wire transport message updates into `useChat()`'s `setMessages` updater.

```typescript
useMessageSync(
  transport: ClientTransport<unknown, UIMessage> | null | undefined,
  setMessages: (updater: (prev: UIMessage[]) => UIMessage[]) => void,
);
```

| Parameter     | Type                                   | Description                                 |
| ------------- | -------------------------------------- | ------------------------------------------- |
| `transport`   | `ClientTransport \| null \| undefined` | The transport to observe                    |
| `setMessages` | `(updater: ...) => void`               | The `setMessages` function from `useChat()` |

**Returns:** `void`

Subscribes to the transport's view `'update'` event and replaces `useChat()`'s message state with the transport's authoritative list on every update. This is how messages from other clients (observer messages) appear in `useChat()`.

Required when using the useChat path with multi-client sync. Without it, `useChat()` only shows messages from its own sends.
