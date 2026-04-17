# React hooks

API reference for all React hooks and providers in the SDK. Generic hooks work with any codec; Vercel hooks are specific to the `useChat()` integration path.

## Generic hooks and providers

Import from `@ably/ai-transport/react`.

---

### TransportProvider

Create a `ClientTransport` and make it available to descendant components. Wraps children with Ably's `ChannelProvider` internally.

```tsx
<TransportProvider
  channelName="ai:demo"
  codec={UIMessageCodec}
  clientId={clientId}
>
  <Chat />
</TransportProvider>
```

| Prop          | Type                                                          | Description                                                                  |
| ------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `channelName` | `string`                                                      | The Ably channel name to subscribe to. Also used as the context registry key |
| `codec`       | `Codec<TEvent, TMessage>`                                     | The codec for encoding/decoding                                              |
| `clientId`    | `string?`                                                     | Client identity, sent to the server in POST body                             |
| `api`         | `string?`                                                     | Server endpoint URL. Default: `"/api/chat"`                                  |
| `headers`     | `Record<string, string> \| (() => Record<string, string>)?`   | HTTP POST headers. Function form for dynamic values                          |
| `body`        | `Record<string, unknown> \| (() => Record<string, unknown>)?` | Additional POST body fields. Function form for dynamic values                |
| `credentials` | `RequestCredentials?`                                         | Fetch credentials mode                                                       |
| `fetch`       | `typeof fetch?`                                               | Custom fetch implementation                                                  |
| `messages`    | `TMessage[]?`                                                 | Initial messages to seed the conversation tree                               |
| `logger`      | `Logger?`                                                     | Logger instance                                                              |
| `children`    | `ReactNode?`                                                  | Child components that will have access to this transport                     |

The transport subscribes to the Ably channel immediately on creation. It does not auto-close on unmount — channel lifecycle is managed by the internal `ChannelProvider`.

For multiple transports, nest providers with distinct `channelName` values:

```tsx
<TransportProvider
  channelName="ai:main"
  codec={UIMessageCodec}
>
  <TransportProvider
    channelName="ai:aux"
    codec={UIMessageCodec}
  >
    <App />
  </TransportProvider>
</TransportProvider>
```

---

### useClientTransport

Access the `ClientTransport` from the nearest `TransportProvider`.

```typescript
const { transport } = useClientTransport<TEvent, TMessage>({ channelName?, skip? } = {});
```

| Prop          | Type       | Description                                                                                               |
| ------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| `channelName` | `string?`  | Channel name to look up. Omit to use the nearest `TransportProvider` in the tree                          |
| `skip`        | `boolean?` | When `true`, return a stub transport that throws on any access — safe to hold before conditions are ready |

**Returns:** `ClientTransport<TEvent, TMessage>` — the transport instance, or a stub whose every property/method throws `Ably.ErrorInfo` when `skip` is `true`.

**Throws:** `Ably.ErrorInfo` (code `40000`) if `skip` is falsy and no matching `TransportProvider` is found in the component tree.

```typescript
// Nearest provider (most common)
const { transport } = useClientTransport<UIMessageChunk, UIMessage>();

// Specific channel
const { transport } = useClientTransport<UIMessageChunk, UIMessage>({ channelName: 'ai:main' });

// Deferred until auth resolves — stub throws on any access
const { transport } = useClientTransport<UIMessageChunk, UIMessage>({ skip: !userId });
```

---

### useView

Subscribe to a view and return nodes with pagination, branch navigation, and write operations. Pass `transport` to use its default view, `view` to subscribe to a specific `View` directly, or omit both to use the nearest `TransportProvider`.

```typescript
const view = useView<TEvent, TMessage>({ transport?, view?, limit?, skip? } = {});
```

| Prop        | Type                       | Description                                                                    |
| ----------- | -------------------------- | ------------------------------------------------------------------------------ |
| `transport` | `ClientTransport \| null?` | Transport whose default view to subscribe to; defaults to the nearest provider |
| `view`      | `View \| null?`            | A specific `View` to subscribe to directly; takes priority over `transport`    |
| `limit`     | `number?`                  | When provided, auto-loads the first page on mount. Default: 100                |
| `skip`      | `boolean?`                 | When `true`, skip all subscriptions and return an empty handle                 |

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
const handle = useCreateView<TEvent, TMessage>({ transport?, limit?, skip? } = {});
```

| Prop        | Type                       | Description                                                                                          |
| ----------- | -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `transport` | `ClientTransport \| null?` | The transport to create a view from; defaults to the nearest provider. Pass `null` to defer creation |
| `limit`     | `number?`                  | When provided, auto-loads the first page on mount. Default: 100                                      |
| `skip`      | `boolean?`                 | When `true`, skip view creation and return an empty handle                                           |

**Returns:** `ViewHandle<TEvent, TMessage>` - the same handle type as `useView()`, with nodes, pagination, navigation, and write operations. Returns an empty handle (no nodes, no messages) when no transport is provided or `skip` is `true`.

```typescript
import { useView, useCreateView } from '@ably/ai-transport/react';

const view = useView({ limit: 50 }); // default view, nearest provider
const splitView = useCreateView({ transport: split ? transport : null, limit: 50 }); // independent view
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
const activeTurns = useActiveTurns<TEvent, TMessage>({ transport? } = {});
```

| Prop        | Type                       | Description                                                                                              |
| ----------- | -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `transport` | `ClientTransport \| null?` | The transport to observe; defaults to the nearest provider. Pass `null`/`undefined` if not yet available |

**Returns:** `Map<string, Set<string>>` - keys are clientIds, values are sets of active turnIds. Empty map if no transport is resolved.

Updates on every turn start/end event. Includes turns from all clients on the channel.

---

### useTree

Provide stable structural query callbacks for the conversation tree.

```typescript
const tree = useTree<TEvent, TMessage>({ transport? } = {});
```

| Prop        | Type               | Description                                                         |
| ----------- | ------------------ | ------------------------------------------------------------------- |
| `transport` | `ClientTransport?` | The transport whose tree to query; defaults to the nearest provider |

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
const messages = useAblyMessages<TEvent, TMessage>({ transport?, skip? } = {});
```

| Prop        | Type               | Description                                                   |
| ----------- | ------------------ | ------------------------------------------------------------- |
| `transport` | `ClientTransport?` | The transport to observe; defaults to the nearest provider    |
| `skip`      | `boolean?`         | When `true`, skip all subscriptions and return an empty array |

**Returns:** `Ably.InboundMessage[]` - raw Ably messages in chronological order. Includes live and history-loaded messages.

---

## Vercel hooks

Import from `@ably/ai-transport/vercel/react`.

---

### ChatTransportProvider

Create a `ClientTransport` and `ChatTransport` and make both available to descendant components. A convenience wrapper around `TransportProvider` with `UIMessageCodec` pre-bound — no `codec` prop needed.

```tsx
<ChatTransportProvider
  channelName="ai:demo"
  clientId={clientId}
>
  <Chat />
</ChatTransportProvider>
```

| Prop          | Type                                                          | Description                                                   |
| ------------- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| `channelName` | `string`                                                      | The Ably channel name. Also used as the context registry key  |
| `clientId`    | `string?`                                                     | Client identity, sent to the server in POST body              |
| `api`         | `string?`                                                     | Server endpoint URL. Default: `"/api/chat"`                   |
| `headers`     | `Record<string, string> \| (() => Record<string, string>)?`   | HTTP POST headers. Function form for dynamic values           |
| `body`        | `Record<string, unknown> \| (() => Record<string, unknown>)?` | Additional POST body fields. Function form for dynamic values |
| `credentials` | `RequestCredentials?`                                         | Fetch credentials mode                                        |
| `fetch`       | `typeof fetch?`                                               | Custom fetch implementation                                   |
| `messages`    | `UIMessage[]?`                                                | Initial messages to seed the conversation tree                |
| `logger`      | `Logger?`                                                     | Logger instance                                               |
| `chatOptions` | `ChatTransportOptions?`                                       | Optional hooks for customizing chat request construction      |
| `children`    | `ReactNode?`                                                  | Child components that will have access to both transports     |

Inside the subtree, `useChatTransport()` reads both transports and `useClientTransport()` reads the underlying `ClientTransport`. All generic hooks (`useView`, `useActiveTurns`, `useAblyMessages`) work without explicit transport arguments.

For multiple providers, nest them with distinct `channelName` values:

```tsx
<ChatTransportProvider channelName="ai:primary">
  <ChatTransportProvider channelName="ai:secondary">
    <App />
  </ChatTransportProvider>
</ChatTransportProvider>
```

---

### useChatTransport

Read a `ChatTransport` and the underlying `ClientTransport` from the nearest `ChatTransportProvider`.

```typescript
const { chatTransport, transport, transportError, chatTransportError } = useChatTransport({ channelName?, skip? } = {});
```

| Prop          | Type       | Description                                                                                             |
| ------------- | ---------- | ------------------------------------------------------------------------------------------------------- |
| `channelName` | `string?`  | Channel name to look up. Omit to use the nearest `ChatTransportProvider` in the tree                    |
| `skip`        | `boolean?` | When `true`, return stub transports that throw on any access — safe to hold before conditions are ready |

**Returns:** `ChatTransportHandle`

| Field                | Type                                         | Description                                                                                                                                |
| -------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `chatTransport`      | `ChatTransport`                              | The adapter for `useChat()`'s `transport` option                                                                                           |
| `transport`          | `ClientTransport<UIMessageChunk, UIMessage>` | The underlying transport for `useMessageSync`, `useView`, `useActiveTurns`, etc.                                                           |
| `chatTransportError` | `Ably.ErrorInfo?`                            | Set when no matching `ChatTransportProvider` was found, or when transport construction failed. `chatTransport` is a throwing stub when set |

```typescript
// Nearest provider (most common)
const { chatTransport, transport } = useChatTransport();

// Specific channel — useful when multiple providers are nested
const { chatTransport, transport } = useChatTransport({ channelName: 'ai:secondary' });

// Deferred until auth resolves — stubs throw on any access
const { chatTransport, transport } = useChatTransport({ skip: !userId });
```

`ChatTransportOptions.prepareSendMessagesRequest` lets you customize the HTTP POST body and headers. Pass it to `ChatTransportProvider`:

```typescript
<ChatTransportProvider
  channelName="ai:demo"
  chatOptions={{
    prepareSendMessagesRequest: (context) => ({
      body: { history: context.history, sessionId: mySessionId },
      headers: { 'x-custom': 'value' },
    }),
  }}
>
  <Chat />
</ChatTransportProvider>
```

---

### useMessageSync

Wire transport message updates into `useChat()`'s `setMessages` updater.

```typescript
useMessageSync(options: UseMessageSyncOptions): void;
```

```typescript
interface UseMessageSyncOptions {
  setMessages: (updater: (prev: UIMessage[]) => UIMessage[]) => void; // required
  channelName?: string;
  skip?: boolean;
}
```

| Option        | Type                     | Default          | Description                                                                                         |
| ------------- | ------------------------ | ---------------- | --------------------------------------------------------------------------------------------------- |
| `setMessages` | `(updater: ...) => void` | —                | **Required.** The `setMessages` function from `useChat()`                                           |
| `channelName` | `string?`                | nearest provider | Channel name of the `ChatTransportProvider` to observe. Omit to use the nearest in the tree         |
| `skip`        | `boolean?`               | `false`          | When `true`, skip all subscriptions. Use when dependencies are not yet resolved (e.g. auth pending) |

**Returns:** `void`

Subscribes to the provider's transport view `'update'` event and replaces `useChat()`'s message state with the transport's authoritative list on every update. Also gates `setMessages` during active own-turn streams to prevent ID mismatches. This is how messages from other clients (observer messages) appear in `useChat()`.

```typescript
// Nearest provider (most common)
useMessageSync({ setMessages });

// Specific provider by channel name
useMessageSync({ channelName: 'ai:main', setMessages });
```

Required when using the useChat path with multi-client sync. Without it, `useChat()` only shows messages from its own sends.
