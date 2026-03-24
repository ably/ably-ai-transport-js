# Ably AI Transport SDK

A durable transport layer between AI agents and users. Streams AI responses over [Ably](https://ably.com/) channels — responses resume after disconnections, conversations persist across page reloads and devices — with cancellation, branching conversations, and multi-user sync.

`@ably/ably-ai-transport-js` ships as a single package with four entry points: core primitives, React hooks, Vercel AI SDK integration, and Vercel + React hooks.

> **Status:** Pre-release (`0.x`). The API is evolving. Feedback and contributions are welcome.

---

## What it does

Without a durable session layer, AI streaming is fragile. Connections drop mid-response, refreshing the page loses the conversation, switching devices means starting over, and cancellation requires custom plumbing on every project.

This SDK handles the transport between your AI backend and your frontend:

- **Token streaming** — AI responses stream in real time over Ably channels
- **Connection recovery** — Ably automatically reconnects after network blips and delivers any messages the client missed
- **Resumable streams** — Clients that join or rejoin mid-response receive the in-progress stream immediately on subscribing to the channel
- **Cancellation** — Client publishes a cancel signal, server aborts the generation
- **Barge-in** — Users send new messages while the AI is still responding
- **Branching conversations** — Regenerate or edit messages, creating forks in the conversation tree
- **Multi-device sync** — Multiple clients on the same channel see the same conversation in real time
- **History** — Conversations persist on the channel; new clients or returning sessions hydrate from history
- **Turn management** — Concurrent turns, per-turn streams, turn lifecycle events

The SDK is codec-agnostic. A `Codec` translates between your AI framework's types and the Ably wire format. A Vercel AI SDK codec ships built-in.

---

## Getting started

### Installation

```sh
npm install @ably/ably-ai-transport-js ably
```

For Vercel AI SDK projects, also install the `ai` package:

```sh
npm install @ably/ably-ai-transport-js ably ai
```

### Supported platforms

| Platform      | Support                                            |
| ------------- | -------------------------------------------------- |
| Node.js       | 20+                                                |
| Browsers      | All major browsers (Chrome, Firefox, Edge, Safari) |
| TypeScript    | Written in TypeScript, ships with types            |
| React         | 18+ and 19+ via dedicated hooks                    |
| Vercel AI SDK | v6 via dedicated codec and transport adapters      |

---

## Usage with Vercel AI SDK

Use the Vercel entry points with `useChat` for the shortest integration path.

### Server — Next.js API route

```typescript
import { after } from 'next/server';
import { streamText, convertToModelMessages } from 'ai';
import type { UIMessage } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import Ably from 'ably';
import { createServerTransport } from '@ably/ably-ai-transport-js/vercel';
import type { MessageWithHeaders } from '@ably/ably-ai-transport-js';

interface ChatRequestBody {
  turnId: string;
  clientId: string;
  messages: MessageWithHeaders<UIMessage>[];
  history?: MessageWithHeaders<UIMessage>[];
  id: string;
  forkOf?: string;
  parent?: string | null;
}

const ably = new Ably.Realtime({ key: process.env.ABLY_API_KEY });

export async function POST(req: Request) {
  const { messages, history, id, turnId, clientId, forkOf, parent } = (await req.json()) as ChatRequestBody;

  const channel = ably.channels.get(id);
  const transport = createServerTransport({ channel });
  const turn = transport.newTurn({ turnId, clientId, parent, forkOf });

  await turn.start();

  if (messages.length > 0) {
    await turn.addMessages(messages, { clientId });
  }

  const historyMsgs = (history ?? []).map((h) => h.message);
  const newMsgs = messages.map((m) => m.message);

  const result = streamText({
    model: anthropic('claude-sonnet-4-20250514'),
    system: 'You are a helpful assistant.',
    messages: await convertToModelMessages([...historyMsgs, ...newMsgs]),
    abortSignal: turn.abortSignal,
  });

  // Stream the response over Ably in the background
  after(async () => {
    const { reason } = await turn.streamResponse(result.toUIMessageStream());
    await turn.end(reason);
    transport.close();
  });

  return new Response(null, { status: 200 });
}
```

### Client — React with `useChat`

```tsx
'use client';

import { useChat } from '@ai-sdk/react';
import { useChannel } from 'ably/react';
import { useClientTransport, useActiveTurns, useHistory } from '@ably/ably-ai-transport-js/react';
import { useChatTransport, useMessageSync } from '@ably/ably-ai-transport-js/vercel/react';
import { UIMessageCodec } from '@ably/ably-ai-transport-js/vercel';

function Chat({ chatId, clientId }: { chatId: string; clientId?: string }) {
  const { channel } = useChannel({ channelName: chatId });

  const transport = useClientTransport({ channel, codec: UIMessageCodec, clientId });
  const chatTransport = useChatTransport(transport);

  const { messages, setMessages, sendMessage, stop } = useChat({
    id: chatId,
    transport: chatTransport,
  });

  useMessageSync(transport, setMessages);

  const activeTurns = useActiveTurns(transport);
  const history = useHistory(transport, { limit: 30 });

  return (
    <div>
      {messages.map((msg) => (
        <div key={msg.id}>{msg.parts.map((part, i) => (part.type === 'text' ? <p key={i}>{part.text}</p> : null))}</div>
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          sendMessage({ text: 'Hello' });
        }}
      >
        {activeTurns.size > 0 ? (
          <button
            type="button"
            onClick={stop}
          >
            Stop
          </button>
        ) : (
          <button type="submit">Send</button>
        )}
      </form>
    </div>
  );
}
```

### Authentication

The Ably client authenticates via token auth. Create an endpoint that issues token requests:

```typescript
// app/api/auth/ably-token/route.ts
import Ably from 'ably';

const ably = new Ably.Rest({ key: process.env.ABLY_API_KEY });

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const clientId = searchParams.get('clientId') ?? 'anonymous';
  const token = await ably.auth.createTokenRequest({ clientId });
  return Response.json(token);
}
```

```typescript
// Client-side Ably setup
const ably = new Ably.Realtime({
  authCallback: async (_params, callback) => {
    const response = await fetch('/api/auth/ably-token');
    const token = await response.json();
    callback(null, token);
  },
});
```

---

## Usage without Vercel AI SDK

The core entry point is framework-agnostic. Bring your own `Codec` to map between your AI framework's event/message types and the Ably wire format.

### Client

```typescript
import { createClientTransport } from '@ably/ably-ai-transport-js';
import { myCodec } from './my-codec';

const transport = createClientTransport({
  channel, // Ably RealtimeChannel
  codec: myCodec,
  clientId: 'user-123',
  api: '/api/chat',
});

const turn = await transport.send(messages);

// Read the stream
const reader = turn.stream.getReader();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  console.log(value); // Your codec's event type
}
```

### Server

```typescript
import { createServerTransport } from '@ably/ably-ai-transport-js';
import { myCodec } from './my-codec';

const transport = createServerTransport({ channel, codec: myCodec });
const turn = transport.newTurn({ turnId, clientId, parent, forkOf });

await turn.start();
await turn.addMessages(messages, { clientId });

const { reason } = await turn.streamResponse(aiStream);
await turn.end(reason);
transport.close();
```

---

## Package exports

| Export path                               | Purpose                                     | Peer dependencies     |
| ----------------------------------------- | ------------------------------------------- | --------------------- |
| `@ably/ably-ai-transport-js`              | Core transport, codec interfaces, utilities | `ably`                |
| `@ably/ably-ai-transport-js/react`        | React hooks for any codec                   | `ably`, `react`       |
| `@ably/ably-ai-transport-js/vercel`       | Vercel AI SDK codec, transport factories    | `ably`, `ai`          |
| `@ably/ably-ai-transport-js/vercel/react` | React hooks for Vercel's `useChat`          | `ably`, `ai`, `react` |

### React hooks

| Hook                  | Entry point     | Description                                         |
| --------------------- | --------------- | --------------------------------------------------- |
| `useClientTransport`  | `/react`        | Create and memoize a client transport instance      |
| `useMessages`         | `/react`        | Subscribe to decoded messages                       |
| `useSend`             | `/react`        | Stable send callback                                |
| `useRegenerate`       | `/react`        | Regenerate a message (fork the conversation)        |
| `useEdit`             | `/react`        | Edit a message and regenerate from that point       |
| `useActiveTurns`      | `/react`        | Track active turns by client ID                     |
| `useHistory`          | `/react`        | Paginate through conversation history               |
| `useConversationTree` | `/react`        | Navigate branches in a forked conversation          |
| `useAblyMessages`     | `/react`        | Access raw Ably messages                            |
| `useChatTransport`    | `/vercel/react` | Wrap transport for Vercel's `useChat`               |
| `useMessageSync`      | `/vercel/react` | Sync transport state with `useChat`'s `setMessages` |

---

## Key features

### Connection recovery

Two mechanisms cover different failure modes:

- **Network blips** — Ably's connection protocol automatically reconnects and delivers any messages published while the client was disconnected. No application code required.
- **Resumable streams** — A client that joins or rejoins a channel mid-response (after a page refresh, on a new device, or as a second participant) receives the in-progress stream immediately on subscribing. Load previous conversation history from the channel via `history()`, or from your own database.

### Cancellation

```typescript
// Client: cancel your own active turns
await transport.cancel();

// Cancel a specific turn
await transport.cancel({ turnId: 'turn-abc' });

// Server: the turn's abortSignal fires automatically
const result = streamText({
  model: anthropic('claude-sonnet-4-20250514'),
  messages,
  abortSignal: turn.abortSignal, // Aborted when client cancels
});
```

### Branching conversations

Regenerate or edit messages to create forks in the conversation tree. The SDK tracks parent/child relationships and exposes a navigable tree.

```typescript
// Regenerate the last assistant message
const turn = await transport.regenerate(assistantMessageId);

// Edit a user message and regenerate from that point
const turn = await transport.edit(userMessageId, [newMessage]);

// Navigate branches
const tree = transport.getTree();
const siblings = tree.getSiblings(messageId);
tree.select(messageId, 1); // Switch to second branch
```

### History and hydration

Load previous conversation state when a client joins or returns to a session.

```typescript
const page = await transport.history({ limit: 50 });
console.log(page.items); // Decoded messages

if (page.hasNext()) {
  const older = await page.next();
}
```

### Events

```typescript
transport.on('message', () => {
  console.log(transport.getMessages());
});

transport.on('turn', (event) => {
  console.log(event.turnId, event.type); // 'x-ably-turn-start' | 'x-ably-turn-end'
});

transport.on('error', (error) => {
  console.error(error.code, error.message);
});
```

---

## Demo apps

Working demo applications live in the [`demo/`](./demo/) directory:

- **[`demo/vercel/react/use-chat/`](./demo/vercel/react/use-chat/)** — Vercel AI SDK with `useChat` integration
- **[`demo/vercel/react/use-client-transport/`](./demo/vercel/react/use-client-transport/)** — Vercel AI SDK with direct `useClientTransport` hooks

---

## Development

```bash
npm install
npm run typecheck     # Type check
npm run lint          # Lint
npm test              # Unit tests (mocks only)
npm run test:integration  # Integration tests (needs ABLY_API_KEY)
npm run precommit     # format:check + lint + typecheck
```

### Project structure

```
src/
├── core/               # Generic transport and codec (no framework deps)
│   ├── codec/          # Codec interfaces and core encoder/decoder
│   └── transport/      # ClientTransport, ServerTransport, ConversationTree
├── react/              # React hooks for any codec
├── vercel/             # Vercel AI SDK codec and transport adapters
│   ├── codec/          # UIMessageCodec
│   ├── transport/      # Vercel-specific factories, ChatTransport
│   └── react/          # useChatTransport, useMessageSync
└── index.ts            # Core entry point
```

---

## Contributing

[Open an issue](https://github.com/ably/ably-ai-transport-js/issues) to share feedback or request a feature.
