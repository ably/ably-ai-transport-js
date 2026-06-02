# React hooks

API reference for all React hooks and providers in the SDK. Generic hooks work with any codec; Vercel hooks are specific to the `useChat()` integration path.

## Generic hooks and providers

Import from `@ably/ai-transport/react`.

---

### ClientSessionProvider

Create a `ClientSession` and make it available to descendant components. The Realtime client is read from the surrounding `<AblyProvider>`; the session is bound to the supplied `channelName`.

```tsx
<ClientSessionProvider
  channelName="ai:demo"
  codec={UIMessageCodec}
  clientId={clientId}
>
  <Chat />
</ClientSessionProvider>
```

| Prop          | Type                                            | Description                                                                               |
| ------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `channelName` | `string`                                        | The Ably channel name to subscribe to. Also used as the context registry key              |
| `codec`       | `Codec<TInput, TOutput, TProjection, TMessage>` | The codec for encoding/decoding                                                           |
| `clientId`    | `string?`                                       | Client identity, used as the Ably publisher `clientId` stamped on everything it publishes |
| `messages`    | `TMessage[]?`                                   | Initial messages to seed the conversation tree                                            |
| `logger`      | `Logger?`                                       | Logger instance                                                                           |
| `children`    | `ReactNode?`                                    | Child components that will have access to this session                                    |

The session is a pure Ably-channel transport — it never sends HTTP. To wake a serverless agent, POST `run.toInvocation().toJSON()` to your endpoint from the value `view.send`/`sendInput`/`regenerate`/`edit` returns. (For the `useChat` integration, use `ChatTransportProvider`, which issues this POST for you.)

The session subscribes to the Ably channel immediately on creation and `connect()` is called once on mount. The session is closed when the provider truly unmounts; the close is scheduled as a microtask so that React Strict Mode's synchronous remount cycle can cancel it.

If `createClientSession` throws during construction, the error is surfaced through `useClientSession` as `sessionError` — the component tree does not crash and children are still rendered.

For multiple sessions, nest providers with distinct `channelName` values:

```tsx
<ClientSessionProvider
  channelName="ai:main"
  codec={UIMessageCodec}
>
  <ClientSessionProvider
    channelName="ai:aux"
    codec={UIMessageCodec}
  >
    <App />
  </ClientSessionProvider>
</ClientSessionProvider>
```

---

### useClientSession

Access the `ClientSession` from the nearest `ClientSessionProvider`.

```typescript
const { session, sessionError } = useClientSession<TInput, TOutput, TProjection, TMessage>({ channelName?, skip?, onError? } = {});
```

| Prop          | Type                               | Description                                                                                             |
| ------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `channelName` | `string?`                          | Channel name to look up. Omit to use the nearest `ClientSessionProvider` in the tree                    |
| `skip`        | `boolean?`                         | When `true`, return a stub session that throws on any access — safe to hold before conditions are ready |
| `onError`     | `(error: Ably.ErrorInfo) => void?` | Called whenever the resolved session emits an error event. Subscription is cleaned up on unmount        |

**Returns:** `ClientSessionHandle<TInput, TOutput, TProjection, TMessage>`

| Field          | Type                                                    | Description                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session`      | `ClientSession<TInput, TOutput, TProjection, TMessage>` | The resolved session. A throwing stub when `skip` is `true`, when no matching `ClientSessionProvider` was found in the tree, or when session construction failed                                 |
| `sessionError` | `Ably.ErrorInfo?`                                       | Set when no matching `ClientSessionProvider` was found, or when session construction failed (and `skip` is `false`). `undefined` when the session resolved successfully or when `skip` is `true` |

The hook never throws during render. Check `sessionError` before using `session` to avoid the stub's throws on access.

```typescript
// Nearest provider (most common)
const { session, sessionError } = useClientSession<VercelInput, VercelOutput, VercelProjection, UIMessage>();

// Specific channel
const { session } = useClientSession<VercelInput, VercelOutput, VercelProjection, UIMessage>({
  channelName: 'ai:main',
});

// Deferred until auth resolves — stub throws on any access
const { session } = useClientSession<VercelInput, VercelOutput, VercelProjection, UIMessage>({ skip: !userId });

// Observe post-construction session errors (e.g. send failures, channel continuity loss)
const { session } = useClientSession<VercelInput, VercelOutput, VercelProjection, UIMessage>({
  onError: (err) => console.error('session error', err),
});
```

---

### useView

Subscribe to a view and return nodes with pagination, branch navigation, and write operations. Pass `session` to use its default view, `view` to subscribe to a specific `View` directly, or omit both to use the nearest `ClientSessionProvider`.

```typescript
const view = useView<TInput, TOutput, TProjection, TMessage>({ session?, view?, limit?, skip? } = {});
```

| Prop      | Type                     | Description                                                                  |
| --------- | ------------------------ | ---------------------------------------------------------------------------- |
| `session` | `ClientSession \| null?` | Session whose default view to subscribe to; defaults to the nearest provider |
| `view`    | `View \| null?`          | A specific `View` to subscribe to directly; takes priority over `session`    |
| `limit`   | `number?`                | Max older Runs per page. When provided, auto-loads the first page on mount   |
| `skip`    | `boolean?`               | When `true`, skip all subscriptions and return an empty handle               |

**Returns:** `ViewHandle<TInput, TOutput, TProjection, TMessage>`

| Property/Method                         | Type                                                                                                    | Description                                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nodes`                                 | `RunNode<TProjection>[]`                                                                                | Flattened Run nodes for the current branch (one Run per turn). Updates on Run-level structural changes                                             |
| `messages`                              | `TMessage[]`                                                                                            | The visible domain messages, concatenated across all visible Runs via the codec                                                                    |
| `hasOlder`                              | `boolean`                                                                                               | Are there older pages? False until history has been loaded                                                                                         |
| `loading`                               | `boolean`                                                                                               | Is a page being fetched?                                                                                                                           |
| `loadError`                             | `Ably.ErrorInfo \| undefined`                                                                           | Set when the most recent `loadOlder` call failed. Cleared automatically on the next successful load                                                |
| `loadOlder()`                           | `() => Promise<void>`                                                                                   | Load more older Runs. No-op if already loading                                                                                                     |
| `getMessageMetadata(msgId)`             | `(msgId: string) => MessageMetadata \| undefined`                                                       | Per-message primitives `{ msgId, runId, clientId, status }` for rendering; replaces leaking RunNode                                                |
| `hasMessageSiblings(msgId)`             | `(msgId: string) => boolean`                                                                            | Whether the owning Run has siblings - drives display of navigation arrows on a message bubble                                                      |
| `getMessageSiblings(msgId)`             | `(msgId: string) => TMessage[]`                                                                         | Resolved sibling messages at the branch point (one TMessage per sibling). Use `.length` for the count                                              |
| `getSelectedMessageSiblingIndex(msgId)` | `(msgId: string) => number`                                                                             | Index of the currently selected sibling, addressed by message id                                                                                   |
| `selectMessageSibling(msgId, index)`    | `(msgId: string, index: number) => void`                                                                | Switch to a sibling Run, addressed by message id. Triggers re-render                                                                               |
| `select(runId, index)`                  | `(runId: string, index: number) => void`                                                                | Switch to a sibling Run when you have the runId in hand                                                                                            |
| `getSelectedIndex(runId)`               | `(runId: string) => number`                                                                             | Index of the currently selected sibling Run                                                                                                        |
| `getRunNode(runId)`                     | `(runId: string) => RunNode<TProjection> \| undefined`                                                  | Look up a Run by runId                                                                                                                             |
| `sendMessage(messages, options?)`       | `(messages: TMessage \| TMessage[], options?: SendOptions) => Promise<ActiveRun<TOutput>>`              | Send user messages in this view's branch context                                                                                                   |
| `sendInput(events, options?)`           | `(events: TInput \| TInput[], options?: SendOptions) => Promise<ActiveRun<TOutput>>`                    | Send input events (tool results, approval responses, regenerate signals); routing fields (`parent`, `target`, `codecMessageId`) live on each input |
| `regenerate(messageId, options?)`       | `(messageId: string, options?: SendOptions) => Promise<ActiveRun<TOutput>>`                             | Fork an assistant message with no new user input                                                                                                   |
| `edit(messageId, inputs, options?)`     | `(messageId: string, inputs: TInput \| TInput[], options?: SendOptions) => Promise<ActiveRun<TOutput>>` | Fork a user message with replacement content                                                                                                       |

Each view has independent branch selections and pagination state. When you pass a session, the hook uses its default view. For [split-pane UIs](../features/branching.md#multiple-views) where each pane needs its own branch and message history, use [`useCreateView()`](#usecreateview) to create independent views with the same API.

Write operations (`send`, `regenerate`, `edit`) automatically derive the parent message and conversation history from this view's selected branch.

`update` amends an existing message and starts a continuation run. The tree updates optimistically before sending. Used for [client-executed tool results](../features/tool-calling.md#client-executed-tools) - the tool output is sent to the server in the POST body, published to the channel, and the model streams a follow-up response in the same run.

---

### useCreateView

Create an independent view with the same API as [`useView()`](#useview). The view is created via `session.createView()` and closed automatically on unmount or when the session changes.

```typescript
const handle = useCreateView<TInput, TOutput, TProjection, TMessage>({ session?, limit?, skip? } = {});
```

| Prop      | Type                     | Description                                                                                        |
| --------- | ------------------------ | -------------------------------------------------------------------------------------------------- |
| `session` | `ClientSession \| null?` | The session to create a view from; defaults to the nearest provider. Pass `null` to defer creation |
| `limit`   | `number?`                | When provided, auto-loads the first page on mount. Omit for manual loading                         |
| `skip`    | `boolean?`               | When `true`, skip view creation and return an empty handle                                         |

**Returns:** `ViewHandle<TInput, TOutput, TProjection, TMessage>` - the same handle type as `useView()`, with nodes, pagination, navigation, and write operations. Returns an empty handle (no nodes, no messages) when no session is provided or `skip` is `true`.

```typescript
import { useView, useCreateView, useClientSession } from '@ably/ai-transport/react';

const { session } = useClientSession<VercelInput, VercelOutput, VercelProjection, UIMessage>();
const view = useView({ limit: 50 }); // default view, nearest provider
const splitView = useCreateView({ session: split ? session : null, limit: 50 }); // independent view
```

Each view has its own branch selections and pagination state - selecting a sibling in one view does not affect any other view. Both views share the same underlying conversation tree, so new messages appear in both.

See [Multiple views](../features/branching.md#multiple-views) for the full split-pane pattern.

---

### useTree

Provide stable structural query callbacks for the conversation tree.

```typescript
const tree = useTree<TInput, TOutput, TProjection, TMessage>({ session? } = {});
```

| Prop      | Type             | Description                                                       |
| --------- | ---------------- | ----------------------------------------------------------------- |
| `session` | `ClientSession?` | The session whose tree to query; defaults to the nearest provider |

**Returns:** `TreeHandle<TProjection>`

| Property/Method         | Type                                                   | Description                              |
| ----------------------- | ------------------------------------------------------ | ---------------------------------------- |
| `getRunNode(runId)`     | `(runId: string) => RunNode<TProjection> \| undefined` | Look up a Run by runId                   |
| `getRunByMsgId(msgId)`  | `(msgId: string) => RunNode<TProjection> \| undefined` | Resolve the Run that owns a given msg-id |
| `getSiblingRuns(runId)` | `(runId: string) => RunNode<TProjection>[]`            | All alternative Runs at a fork point     |
| `hasSiblingRuns(runId)` | `(runId: string) => boolean`                           | Whether to show navigation arrows        |

Branch navigation (`select()`, `getSelectedIndex()`) and write operations (`sendMessage()`, `regenerate()`, `edit()`) are on `ViewHandle` from `useView()`, not `TreeHandle`. The tree provides structural queries that are the same regardless of which branch is selected.

---

### useAblyMessages

Subscribe to raw Ably message updates. Useful for debugging.

```typescript
const messages = useAblyMessages<TInput, TOutput, TProjection, TMessage>({ session?, skip? } = {});
```

| Prop      | Type             | Description                                                   |
| --------- | ---------------- | ------------------------------------------------------------- |
| `session` | `ClientSession?` | The session to observe; defaults to the nearest provider      |
| `skip`    | `boolean?`       | When `true`, skip all subscriptions and return an empty array |

**Returns:** `Ably.InboundMessage[]` - raw Ably messages in chronological order. Includes live and history-loaded messages.

---

## Vercel hooks

Import from `@ably/ai-transport/vercel/react`.

---

### ChatTransportProvider

Create a `ClientSession` and `ChatTransport` and make both available to descendant components. A convenience wrapper around `ClientSessionProvider` with `UIMessageCodec` pre-bound — no `codec` prop needed.

```tsx
<ChatTransportProvider
  channelName="ai:demo"
  clientId={clientId}
>
  <Chat />
</ChatTransportProvider>
```

| Prop          | Type                    | Description                                                                                 |
| ------------- | ----------------------- | ------------------------------------------------------------------------------------------- |
| `channelName` | `string`                | The Ably channel name. Also used as the context registry key                                |
| `clientId`    | `string?`               | Client identity, used as the Ably publisher `clientId` stamped on everything it publishes   |
| `api`         | `string?`               | Endpoint the chat transport POSTs the invocation to, to wake the agent. Default `/api/chat` |
| `credentials` | `RequestCredentials?`   | Fetch credentials mode for the invocation POST                                              |
| `fetch`       | `typeof fetch?`         | Custom fetch implementation for the invocation POST                                         |
| `messages`    | `UIMessage[]?`          | Initial messages to seed the conversation tree                                              |
| `logger`      | `Logger?`               | Logger instance                                                                             |
| `chatOptions` | `ChatTransportOptions?` | Optional hooks for customizing the invocation POST (e.g. `prepareSendMessagesRequest`)      |
| `children`    | `ReactNode?`            | Child components that will have access to the chat transport and the session                |

Unlike the generic `ClientSessionProvider`, this provider issues the agent-invocation POST for you (that's what `api`/`credentials`/`fetch` configure) — `useChat`'s transport contract is request-driven. Inside the subtree, `useChatTransport()` reads the chat transport and the session, and `useClientSession()` reads the underlying `ClientSession`. All generic hooks (`useView`, `useTree`, `useAblyMessages`) work without explicit session arguments.

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

Read a `ChatTransport` and the underlying `ClientSession` from the nearest `ChatTransportProvider`.

```typescript
const { chatTransport, session, sessionError, chatTransportError } = useChatTransport({ channelName?, skip? } = {});
```

| Prop          | Type       | Description                                                                                   |
| ------------- | ---------- | --------------------------------------------------------------------------------------------- |
| `channelName` | `string?`  | Channel name to look up. Omit to use the nearest `ChatTransportProvider` in the tree          |
| `skip`        | `boolean?` | When `true`, return stubs that throw on any access — safe to hold before conditions are ready |

**Returns:** `ChatTransportHandle`

| Field                | Type                                                                    | Description                                                                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chatTransport`      | `ChatTransport`                                                         | The adapter for `useChat()`'s `transport` option. A throwing stub when `skip` is `true`, when no matching `ChatTransportProvider` was found, or when session construction failed                 |
| `session`            | `ClientSession<VercelInput, VercelOutput, VercelProjection, UIMessage>` | The underlying client session, also exposed by `useClientSession()`. Used directly with `useMessageSync`, `useView`, `useTree`, etc.                                                             |
| `sessionError`       | `Ably.ErrorInfo?`                                                       | Set when no matching `ClientSessionProvider` was found, or when session construction failed (and `skip` is `false`). `undefined` when the session resolved successfully or when `skip` is `true` |
| `chatTransportError` | `Ably.ErrorInfo?`                                                       | Set when no matching `ChatTransportProvider` was found, or when session construction failed (and `skip` is `false`). `undefined` when the chat transport resolved successfully                   |

```typescript
// Nearest provider (most common)
const { chatTransport, session } = useChatTransport();

// Specific channel — useful when multiple providers are nested
const { chatTransport, session } = useChatTransport({ channelName: 'ai:secondary' });

// Deferred until auth resolves — stubs throw on any access
const { chatTransport, session } = useChatTransport({ skip: !userId });
```

`ChatTransportOptions.prepareSendMessagesRequest` lets you add body fields and headers to the invocation POST (the run's invocation identifiers always take precedence in the body). Pass it to `ChatTransportProvider`:

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

Wire session message updates into `useChat()`'s `setMessages` updater.

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

Subscribes to the session view's `'update'` event and replaces `useChat()`'s message state with the view's authoritative message list on every update. Also gates `setMessages` during active own-run streams (using the `ChatTransport`'s `streaming` state) to prevent ID mismatches in `useChat`'s `write()`. When the stream finishes, the gate opens and an immediate sync fires to pick up any observer messages that arrived during the stream. This is how messages from other clients (observer messages) appear in `useChat()`.

```typescript
// Nearest provider (most common)
useMessageSync({ setMessages });

// Specific provider by channel name
useMessageSync({ channelName: 'ai:main', setMessages });
```

Required when using the useChat path with multi-client sync. Without it, `useChat()` only shows messages from its own sends.
