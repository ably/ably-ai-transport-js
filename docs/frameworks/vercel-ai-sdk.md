# Vercel AI SDK

The Vercel AI SDK provides model abstraction, streaming primitives, and React hooks (`useChat()`) for building AI applications. AI Transport adds a durable real-time layer underneath - streaming over Ably channels instead of direct HTTP, with persistence, multi-client sync, and cancellation built in.

## What AI Transport adds

| Capability      | Vercel AI SDK alone                               | With AI Transport                                                      |
| --------------- | ------------------------------------------------- | ---------------------------------------------------------------------- |
| Token streaming | HTTP streaming (SSE) - one client, one connection | Ably channel - any number of clients, persistent                       |
| Cancel          | AbortController on the HTTP stream                | Channel-level cancel signal - server receives it, other clients see it |
| History         | None (page refresh = gone)                        | Channel history - new clients hydrate the full conversation            |
| Branching       | None                                              | Conversation tree with regenerate, edit, and sibling navigation        |
| Multi-client    | Not supported                                     | Any client on the channel sees messages in real time                   |
| Reconnection    | Stream breaks on disconnect                       | Ably handles reconnection; `untilAttach` ensures gapless history       |

## Two integration paths

### useChat path (simpler)

Vercel's `useChat()` accepts a custom `transport` that handles message delivery. `ChatTransportProvider` provides one that streams over Ably; pass it to `useChat()` and let it manage message state as usual.

```tsx
import { ChatTransportProvider, useChatTransport, useMessageSync } from '@ably/ai-transport/vercel/react';
import { useChat } from '@ai-sdk/react';

// Wrap your component tree with ChatTransportProvider (no codec needed — UIMessageCodec is pre-bound)
<ChatTransportProvider
  channelName={chatId}
  clientId={clientId}
>
  <ChatInner chatId={chatId} />
</ChatTransportProvider>;

// Inside ChatInner:
const { chatTransport } = useChatTransport();

const { messages, setMessages, sendMessage, stop } = useChat({
  id: chatId,
  transport: chatTransport,
});

// Sync observer messages (from other clients) into useChat's state
useMessageSync({ setMessages });
```

`ChatTransportProvider` creates both a `ClientSession` and a `ChatTransport` and makes them available in context. `useChatTransport()` reads both from context — `chatTransport` is passed to `useChat()`, and `session` is used for `useMessageSync` and `useView`. `useMessageSync()` pushes the session's authoritative message list into `useChat()`'s state — this is how messages from other clients appear.

### Generic hooks path (more control)

Use the generic React hooks directly. You manage message state through the session's conversation tree instead of `useChat()`.

```tsx
import { ClientSessionProvider, useClientSession, useView } from '@ably/ai-transport/react';
import { UIMessageCodec } from '@ably/ai-transport/vercel';
import type * as AI from 'ai';

// Wrap your component tree with ClientSessionProvider
<ClientSessionProvider
  channelName={chatId}
  codec={UIMessageCodec}
  clientId={clientId}
  api="/api/chat"
>
  <ChatInner />
</ClientSessionProvider>;

// Inside ChatInner:
const { session } = useClientSession<AI.UIMessageChunk, AI.UIMessage>();
const {
  nodes,
  hasOlder,
  loading,
  loadOlder,
  send,
  regenerate,
  edit,
  select,
  getSelectedIndex,
  getSiblings,
  hasSiblings,
} = useView({ session, limit: 30 });
```

This path gives you conversation branching UI (sibling navigation), write operations, and direct access to the view state.

### When to use which

| Use useChat when...                                      | Use generic hooks when...                     |
| -------------------------------------------------------- | --------------------------------------------- |
| You want the simplest integration                        | You need conversation branching UI            |
| `useChat()`'s message state management is sufficient     | You need custom message construction          |
| You don't need edit or branch navigation                 | You need `edit()` or `view.select()`          |
| You're already using `useChat()` and adding AI Transport | You're building a custom chat UI from scratch |

## Entry points

| Import                            | What you get                                                                                                               |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `@ably/ai-transport/vercel`       | `UIMessageCodec`, `createAgentSession()`, `createClientSession()`, `createChatTransport()` - all pre-bound to Vercel types |
| `@ably/ai-transport/vercel/react` | `ChatTransportProvider`, `useChatTransport()`, `useMessageSync()`, plus all generic hooks pre-bound to Vercel types        |
| `@ably/ai-transport/react`        | Generic hooks (`useView`, `useTree`, `useClientSession`, etc.) - work with any codec including `UIMessageCodec`            |

The Vercel entry points are convenience wrappers. `createAgentSession()` from `/vercel` is the same as the core `createAgentSession()` with `UIMessageCodec` pre-bound - you don't pass a `codec` option.

## Server side

The server code is the same for both client paths. Use `createAgentSession()` from the Vercel entry point and pipe `streamText()`'s output through a run:

```typescript
import { Invocation } from '@ably/ai-transport';
import { createAgentSession } from '@ably/ai-transport/vercel';
import { streamText, convertToModelMessages } from 'ai';

const session = createAgentSession({ client: ably, channelName });
await session.connect();
const run = session.createRun(Invocation.fromJSON({ runId, clientId, parent, forkOf }));

await run.start();

// Publish user messages to the channel so all clients see them and they persist in history
await run.addMessages(userMessages, { clientId });

const result = streamText({
  model: yourModel,
  messages: await convertToModelMessages(allMessages),
  abortSignal: run.abortSignal,
});

const { reason } = await run.pipe(result.toUIMessageStream());
await run.end(reason);
session.close();
```

`result.toUIMessageStream()` produces a `ReadableStream<UIMessageChunk>` - the codec knows how to encode these chunks as Ably messages (message appends for text/reasoning, discrete messages for lifecycle events).

## Codec details

`UIMessageCodec` maps between Vercel AI SDK types and Ably messages:

| UIMessageChunk type | Ably encoding                                   |
| ------------------- | ----------------------------------------------- |
| `text-delta`        | Message append (text accumulation)              |
| `reasoning-delta`   | Message append (reasoning accumulation)         |
| `finish`            | Discrete message (closes the stream)            |
| `error`             | Discrete message (closes the stream with error) |

The codec handles the full `UIMessageChunk` union. On the decode side, it reconstructs `UIMessage` objects with the correct `parts` array (text, reasoning) from the streamed chunks.

## Status

The Vercel AI SDK is the only supported framework today. The generic session and codec interfaces (`Codec<TEvent, TMessage>`) support custom integrations for other frameworks. See [Client and agent sessions](../concepts/sessions.md) for the architecture.
