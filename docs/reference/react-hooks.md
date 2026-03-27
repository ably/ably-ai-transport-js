# React hooks

API reference for all React hooks in the SDK. Generic hooks work with any codec; Vercel hooks are specific to the `useChat()` integration path.

## Generic hooks

Import from `@ably/ai-transport/react`.

---

### useClientTransport

Create and memoize a `ClientTransport` instance across renders.

```typescript
const transport = useClientTransport<TEvent, TMessage>(options: ClientTransportOptions<TEvent, TMessage>);
```

| Parameter | Type | Description |
|---|---|---|
| `options.channel` | `Ably.RealtimeChannel` | The Ably channel to subscribe to |
| `options.codec` | `Codec<TEvent, TMessage>` | The codec for encoding/decoding |
| `options.clientId` | `string?` | Client identity, sent to the server in POST body |
| `options.api` | `string?` | Server endpoint URL. Default: `"/api/chat"` |
| `options.headers` | `Record<string, string> \| (() => Record<string, string>)?` | HTTP POST headers. Function form for dynamic values |
| `options.body` | `Record<string, unknown> \| (() => Record<string, unknown>)?` | Additional POST body fields. Function form for dynamic values |
| `options.credentials` | `RequestCredentials?` | Fetch credentials mode |
| `options.fetch` | `typeof fetch?` | Custom fetch implementation |
| `options.messages` | `TMessage[]?` | Initial messages to seed the conversation tree |
| `options.logger` | `Logger?` | Logger instance |

**Returns:** `ClientTransport<TEvent, TMessage>` - the memoized transport (same instance on every render).

The transport subscribes to the Ably channel immediately on creation. It does not auto-close on unmount - channel lifecycle is managed by Ably's `ChannelProvider`.

---

### useMessages

Subscribe to transport message updates and return the current message list.

```typescript
const messages = useMessages<TEvent, TMessage>(transport: ClientTransport<TEvent, TMessage>);
```

| Parameter | Type | Description |
|---|---|---|
| `transport` | `ClientTransport<TEvent, TMessage>` | The transport to observe |

**Returns:** `TMessage[]` - the current decoded message list. Updates on every message change (including streaming deltas).

---

### useSend

Return a stable send callback bound to the transport.

```typescript
const send = useSend<TEvent, TMessage>(transport: ClientTransport<TEvent, TMessage>);

const turn = await send(messages, options?);
```

| Parameter | Type | Description |
|---|---|---|
| `transport` | `ClientTransport<TEvent, TMessage>` | The transport to send through |

**Returns:** `(messages: TMessage[], options?: SendOptions) => Promise<ActiveTurn<TEvent>>`

The returned function sends one or more messages in a new turn. Returns an `ActiveTurn` with:
- `turn.stream` - `ReadableStream<TEvent>` of decoded events
- `turn.turnId` - the turn's unique ID
- `turn.cancel()` - cancel this specific turn

---

### useRegenerate

Return a stable regenerate callback. Forks an assistant message with no new user input.

```typescript
const regenerate = useRegenerate<TEvent, TMessage>(transport: ClientTransport<TEvent, TMessage>);

const turn = await regenerate(messageId, options?);
```

| Parameter | Type | Description |
|---|---|---|
| `transport` | `ClientTransport<TEvent, TMessage>` | The transport to regenerate through |

**Returns:** `(messageId: string, options?: SendOptions) => Promise<ActiveTurn<TEvent>>`

Automatically computes `forkOf`, `parent`, and truncated history from the conversation tree.

---

### useEdit

Return a stable edit callback. Forks a user message with replacement content.

```typescript
const edit = useEdit<TEvent, TMessage>(transport: ClientTransport<TEvent, TMessage>);

const turn = await edit(messageId, newMessages, options?);
```

| Parameter | Type | Description |
|---|---|---|
| `transport` | `ClientTransport<TEvent, TMessage>` | The transport to edit through |

**Returns:** `(messageId: string, newMessages: TMessage | TMessage[], options?: SendOptions) => Promise<ActiveTurn<TEvent>>`

Automatically computes `forkOf`, `parent`, and history from the conversation tree.

---

### useActiveTurns

Return a reactive map of all active turns on the channel, keyed by clientId.

```typescript
const activeTurns = useActiveTurns<TEvent, TMessage>(transport: ClientTransport<TEvent, TMessage> | null | undefined);
```

| Parameter | Type | Description |
|---|---|---|
| `transport` | `ClientTransport \| null \| undefined` | The transport to observe. Pass null/undefined if not yet available |

**Returns:** `Map<string, Set<string>>` - keys are clientIds, values are sets of active turnIds. Empty map if transport is null.

Updates on every turn start/end event. Includes turns from all clients on the channel.

---

### useHistory

Return a paginated history handle.

```typescript
const history = useHistory<TEvent, TMessage>(
  transport: ClientTransport<TEvent, TMessage> | null | undefined,
  options?: LoadHistoryOptions | null,
);
```

| Parameter | Type | Description |
|---|---|---|
| `transport` | `ClientTransport \| null \| undefined` | The transport to load history from |
| `options` | `LoadHistoryOptions \| null?` | When provided, auto-loads first page on mount. Omit or pass null for manual load |
| `options.limit` | `number?` | Max messages per page. Default: 100 |

**Returns:** `HistoryHandle`

| Property/Method | Type | Description |
|---|---|---|
| `hasNext` | `boolean` | Are there older pages? False until `load()` has been called |
| `loading` | `boolean` | Is a page being fetched? |
| `load(options?)` | `(options?: LoadHistoryOptions) => Promise<void>` | Load the first page (or re-load) |
| `next()` | `() => Promise<void>` | Fetch the next older page. No-op if loading or no more pages |

History messages are inserted into the conversation tree and trigger `'message'` notifications.

---

### useConversationTree

Subscribe to message updates and provide branch navigation.

```typescript
const tree = useConversationTree<TEvent, TMessage>(transport: ClientTransport<TEvent, TMessage>);
```

| Parameter | Type | Description |
|---|---|---|
| `transport` | `ClientTransport<TEvent, TMessage>` | The transport whose tree to navigate |

**Returns:** `ConversationTreeHandle<TMessage>`

| Property/Method | Type | Description |
|---|---|---|
| `messages` | `TMessage[]` | Linear message list for the current branch |
| `getSiblings(msgId)` | `(msgId: string) => TMessage[]` | All alternatives at a fork point |
| `hasSiblings(msgId)` | `(msgId: string) => boolean` | Whether to show navigation arrows |
| `getSelectedIndex(msgId)` | `(msgId: string) => number` | Index of the currently selected sibling |
| `selectSibling(msgId, index)` | `(msgId: string, index: number) => void` | Switch to a sibling. Triggers re-render |

---

### useAblyMessages

Subscribe to raw Ably message updates. Useful for debugging.

```typescript
const messages = useAblyMessages<TEvent, TMessage>(transport: ClientTransport<TEvent, TMessage>);
```

| Parameter | Type | Description |
|---|---|---|
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

| Parameter | Type | Description |
|---|---|---|
| `transportOrOptions` | `ClientTransport \| VercelClientTransportOptions` | An existing transport, or options to create one |
| `chatOptions` | `ChatTransportOptions?` | Optional hooks for customizing request construction |

**Returns:** `ChatTransport` - compatible with `useChat()`'s `transport` option.

Two usage patterns:
1. **Wrap an existing transport** - pass a `ClientTransport` created by `useClientTransport()`
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

| Parameter | Type | Description |
|---|---|---|
| `transport` | `ClientTransport \| null \| undefined` | The transport to observe |
| `setMessages` | `(updater: ...) => void` | The `setMessages` function from `useChat()` |

**Returns:** `void`

Subscribes to the transport's `'message'` event and replaces `useChat()`'s message state with the transport's authoritative list on every update. This is how messages from other clients (observer messages) appear in `useChat()`.

Required when using the `useChat()` path with multi-client sync. Without it, `useChat()` only shows messages from its own sends.
