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

// Wrap your component tree with ChatTransportProvider (no codec needed — the Vercel codec is pre-bound)
<ChatTransportProvider channelName={chatId}>
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
import { createUIMessageCodec } from '@ably/ai-transport/vercel';
import type { VercelInput, VercelProjection } from '@ably/ai-transport/vercel';
import type * as AI from 'ai';

// A stable codec instance (hold it at module scope or via useMemo).
const uiMessageCodec = createUIMessageCodec();

// Wrap your component tree with ClientSessionProvider
<ClientSessionProvider
  channelName={chatId}
  codec={uiMessageCodec}
>
  <ChatInner />
</ClientSessionProvider>;

// Inside ChatInner:
const { session } = useClientSession<VercelInput, AI.UIMessageChunk, VercelProjection, AI.UIMessage>();
const { messages, hasOlder, loading, loadOlder, send, regenerate, edit, branchSelection } = useView({
  session,
  limit: 30,
});
```

This path gives you conversation branching UI (sibling navigation via `branchSelection(id).select(index)`), write operations, and direct access to the view state. Unlike the `useChat` path, `ClientSessionProvider` does not POST anything — the session only publishes on the channel. Wake the agent yourself by POSTing `run.toInvocation().toJSON()` to your endpoint from the `ClientRun` that `send`/`regenerate`/`edit` returns.

### When to use which

| Use useChat when...                                      | Use generic hooks when...                     |
| -------------------------------------------------------- | --------------------------------------------- |
| You want the simplest integration                        | You need conversation branching UI            |
| `useChat()`'s message state management is sufficient     | You need custom message construction          |
| You don't need edit or branch navigation                 | You need `edit()` or branch navigation        |
| You're already using `useChat()` and adding AI Transport | You're building a custom chat UI from scratch |

## Typed messages (metadata, data parts, tools)

`createUIMessageCodec`, `createClientSession`, `createAgentSession`, and `createChatTransport` are generic over the AI SDK's three `UIMessage` type parameters — message metadata, custom data parts, and tools. Supply them once and your typed message flows through the session, so `view.getMessages()` returns messages whose `metadata`, data parts, and tool parts carry your types instead of the SDK defaults. Omit them and inference is unchanged.

```tsx
import { createClientSession } from '@ably/ai-transport/vercel';
import type * as AI from 'ai';

type Metadata = { userId: string };
type DataParts = AI.UIDataTypes & { chart: { points: number[] } };
type Tools = AI.UITools & { getWeather: { input: { city: string }; output: { tempC: number } } };

const session = createClientSession<Metadata, DataParts, Tools>({ client, channelName: 'ai:demo' });
const [{ message }] = session.view.getMessages();
message.metadata; // typed `Metadata | undefined` — not `unknown`
```

Under the module-scope React constraint, the `ChatTransportProvider` / `createSessionHooks` path stays at the SDK defaults; thread concrete types through the imperative path (`createClientSession<…>` + `createChatTransport<…>` + `useMessageSync<…>`).

## Entry points

| Import                            | What you get                                                                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ably/ai-transport/vercel`       | `createUIMessageCodec()`, `createAgentSession()`, `createClientSession()`, `createChatTransport()`, `vercelRunOutcome()` - all pre-bound to Vercel types |
| `@ably/ai-transport/vercel/react` | `ChatTransportProvider`, `useChatTransport()`, `useMessageSync()`, plus all generic hooks pre-bound to Vercel types                                      |
| `@ably/ai-transport/react`        | Generic hooks (`useView`, `useTree`, `useClientSession`, etc.) - work with any codec including the Vercel codec                                          |

The Vercel entry points are convenience wrappers. `createAgentSession()` from `/vercel` is the same as the core `createAgentSession()` with the Vercel codec pre-bound - you don't pass a `codec` option.

## Server side

The server code is the same for both client paths. Use `createAgentSession()` from the Vercel entry point and pipe `streamText()`'s output through a run:

```typescript
import { Invocation } from '@ably/ai-transport';
import type { InvocationData } from '@ably/ai-transport';
import { createAgentSession, vercelRunOutcome } from '@ably/ai-transport/vercel';
import { streamText, convertToModelMessages } from 'ai';

// The client POSTs `run.toInvocation().toJSON()` — an { inputEventId, sessionName }
// pointer. Rehydrate it into an Invocation.
const data = (await req.json()) as InvocationData;
const invocation = Invocation.fromJSON(data);

const session = createAgentSession({ client: ably, channelName: invocation.sessionName });
await session.connect();
const run = session.createRun(invocation, { signal: req.signal });

// Replay the conversation from the channel — the user messages were already
// published by the client, so the agent reads them back rather than republishing.
// Draining run.view yields the full multi-turn conversation and folds in the
// triggering input start() waits for; run.messages is only this run, not the whole conversation.
while (run.view.hasOlder()) await run.view.loadOlder();
const conversation = run.view.getMessages().map((m) => m.message);
await run.start();

const result = streamText({
  model: yourModel,
  messages: await convertToModelMessages(conversation),
  abortSignal: run.abortSignal,
});

const pipeResult = await run.pipe(result.toUIMessageStream());
const outcome = await vercelRunOutcome(pipeResult, result.finishReason);
if (outcome.reason === 'suspend') {
  await run.suspend();
} else {
  await run.end(outcome);
}
session.close();
```

`result.toUIMessageStream()` produces a `ReadableStream<UIMessageChunk>` - the codec knows how to encode these chunks as Ably messages (message appends for text/reasoning, discrete messages for lifecycle events). `vercelRunOutcome()` maps the pipe result and Vercel's `finishReason` to a `VercelRunOutcome`. A `'suspend'` reason means the LLM requested tools that need client input - call `run.suspend()`; otherwise pass the outcome to `run.end()`, which forwards an `'error'` outcome's `error` to clients.

## Codec details

The Vercel codec maps between Vercel AI SDK types and Ably messages. It is assembled by `defineCodec` from declarative descriptor tables rather than hand-written encoder/decoder classes — `inputs.ts` declares the `ai-input` events, `outputs.ts` declares the `ai-output` events, and the reducer (`init`/`fold`/`getMessages`) folds decoded events into `UIMessage` objects.

Each output descriptor is either a **streamed family** (start / delta / end chunks accumulated into one Ably message) or a **discrete event** (one Ably message):

| UIMessageChunk type(s)                                                                      | Ably encoding                                             |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `text-start` / `text-delta` / `text-end`                                                    | Streamed family — message appends, text accumulation      |
| `reasoning-start` / `reasoning-delta` / `reasoning-end`                                     | Streamed family — message appends, reasoning accumulation |
| `tool-input-start` / `tool-input-delta` / `tool-input-available`                            | Streamed family — input-text deltas accumulated           |
| `finish`, `start`, `start-step`, `finish-step`                                              | Discrete message (lifecycle event)                        |
| `error`, `abort`                                                                            | Discrete message (content event)                          |
| `file`, `source-url`, `source-document`                                                     | Discrete message (content part)                           |
| `tool-output-available`, `tool-output-error`, `tool-approval-request`, `tool-output-denied` | Discrete message (tool lifecycle)                         |
| `data-*`                                                                                    | Discrete message (matched by wildcard)                    |

Each output message carries an SDK-controlled `kind` codec header (the dispatch discriminator / stream-family id); the decoder routes on that header, never on message shape. The codec handles the full `UIMessageChunk` union. On the decode side, the reducer reconstructs `UIMessage` objects with the correct `parts` array (text, reasoning, tool calls, files, sources, data parts) from the streamed and discrete chunks.

## Status

The Vercel AI SDK is the only supported framework today. The generic session and codec interfaces (`Codec<TInput, TOutput, TProjection, TMessage>`) support custom integrations for other frameworks. See [Client and agent sessions](../concepts/sessions.md) for the architecture.
