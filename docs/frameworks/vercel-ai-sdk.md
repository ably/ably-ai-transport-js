# Vercel AI SDK

The Vercel AI SDK provides model abstraction, streaming primitives, and React hooks (`useChat`) for building AI applications. AI Transport adds a durable real-time layer underneath — streaming over Ably channels instead of direct HTTP, with persistence, multi-client sync, and cancellation built in.

## What AI Transport adds

| Capability | Vercel AI SDK alone | With AI Transport |
|---|---|---|
| Token streaming | HTTP streaming (SSE) — one client, one connection | Ably channel — any number of clients, persistent |
| Cancel | AbortController on the HTTP stream | Channel-level cancel signal — server receives it, other clients see it |
| History | None (page refresh = gone) | Channel history — new clients hydrate the full conversation |
| Branching | None | Conversation tree with regenerate, edit, and sibling navigation |
| Multi-client | Not supported | Any client on the channel sees messages in real time |
| Reconnection | Stream breaks on disconnect | Ably handles reconnection; `untilAttach` ensures gapless history |

## Two integration paths

### useChat path (simpler)

Wrap the transport in a `ChatTransport` adapter and pass it to Vercel's `useChat`. Message state is managed by `useChat` — the transport delivers messages over Ably instead of HTTP.

```typescript
import { useClientTransport } from '@ably/ably-ai-transport-js/react';
import { useChatTransport, useMessageSync } from '@ably/ably-ai-transport-js/vercel/react';
import { UIMessageCodec } from '@ably/ably-ai-transport-js/vercel';
import { useChat } from '@ai-sdk/react';

const transport = useClientTransport({ channel, codec: UIMessageCodec, clientId });
const chatTransport = useChatTransport(transport);

const { messages, setMessages, sendMessage, stop } = useChat({
  id: chatId,
  transport: chatTransport,
});

// Sync observer messages (from other clients) into useChat's state
useMessageSync(transport, setMessages);
```

`useChatTransport` wraps the core transport into the `ChatTransport` interface that `useChat` expects. `useMessageSync` pushes the transport's authoritative message list into `useChat`'s state — this is how messages from other clients appear.

### Generic hooks path (more control)

Use the generic React hooks directly. You manage message state through the transport's conversation tree instead of `useChat`.

```typescript
import {
  useClientTransport,
  useConversationTree,
  useSend,
  useRegenerate,
  useEdit,
  useActiveTurns,
  useHistory,
} from '@ably/ably-ai-transport-js/react';
import { UIMessageCodec } from '@ably/ably-ai-transport-js/vercel';

const transport = useClientTransport({ channel, codec: UIMessageCodec, clientId });
const tree = useConversationTree(transport);
const send = useSend(transport);
const regenerate = useRegenerate(transport);
const edit = useEdit(transport);
const activeTurns = useActiveTurns(transport);
const history = useHistory(transport, { limit: 30 });
```

This path gives you conversation branching UI (sibling navigation), per-operation hooks, and direct access to the tree state.

### When to use which

| Use useChat when... | Use generic hooks when... |
|---|---|
| You want the simplest integration | You need conversation branching UI |
| `useChat`'s message state management is sufficient | You need custom message construction |
| You don't need edit or branch navigation | You need `edit()` or `tree.selectSibling()` |
| You're already using `useChat` and adding AI Transport | You're building a custom chat UI from scratch |

## Entry points

| Import | What you get |
|---|---|
| `@ably/ably-ai-transport-js/vercel` | `UIMessageCodec`, `createServerTransport`, `createClientTransport`, `createChatTransport` — all pre-bound to Vercel types |
| `@ably/ably-ai-transport-js/vercel/react` | `useChatTransport`, `useMessageSync` — hooks for the useChat path |
| `@ably/ably-ai-transport-js/react` | Generic hooks — work with any codec including `UIMessageCodec` |

The Vercel entry points are convenience wrappers. `createServerTransport` from `/vercel` is the same as the core `createServerTransport` with `UIMessageCodec` pre-bound — you don't pass a `codec` option.

## Server side

The server code is the same for both client paths. Use `createServerTransport` from the Vercel entry point and pipe `streamText`'s output through a turn:

```typescript
import { createServerTransport } from '@ably/ably-ai-transport-js/vercel';
import { streamText, convertToModelMessages } from 'ai';

const transport = createServerTransport({ channel });
const turn = transport.newTurn({ turnId, clientId, parent, forkOf });

await turn.start();

// Publish user messages to the channel so all clients see them and they persist in history
await turn.addMessages(userMessages, { clientId });

const result = streamText({
  model: yourModel,
  messages: await convertToModelMessages(allMessages),
  abortSignal: turn.abortSignal,
});

const { reason } = await turn.streamResponse(result.toUIMessageStream());
await turn.end(reason);
transport.close();
```

`result.toUIMessageStream()` produces a `ReadableStream<UIMessageChunk>` — the codec knows how to encode these chunks as Ably messages (message appends for text/reasoning, discrete messages for tool calls and lifecycle events).

## Codec details

`UIMessageCodec` maps between Vercel AI SDK types and Ably messages:

| UIMessageChunk type | Ably encoding |
|---|---|
| `text-delta` | Message append (text accumulation) |
| `reasoning-delta` | Message append (reasoning accumulation) |
| `tool-input-start/delta/available` | Message append (tool input accumulation) |
| `tool-output-available` | Discrete message |
| `finish` | Discrete message (closes the stream) |
| `error` | Discrete message (closes the stream with error) |

The codec handles the full `UIMessageChunk` union. On the decode side, it reconstructs `UIMessage` objects with the correct `parts` array (text, reasoning, tool invocations) from the streamed chunks.

## Status

The Vercel AI SDK is the only supported framework today. The generic transport and codec interfaces (`Codec<TEvent, TMessage>`) support custom integrations for other frameworks. See [Client and server transport](../concepts/transport.md) for the architecture.
