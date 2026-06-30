# Get Started: Vercel AI SDK with useChat

Build a streaming chat app using Vercel AI SDK's `useChat()` hook and AI Transport. This is the simplest integration path - `useChat()` manages message state, and AI Transport handles real-time delivery over Ably.

## Prerequisites

- Node.js 22+
- An [Ably account](https://ably.com) with an API key
- An LLM API key (this guide uses Anthropic, but any Vercel AI SDK provider works)

## Install dependencies

```bash
npm install @ably/ai-transport ably ai @ai-sdk/react @ai-sdk/anthropic react react-dom next jsonwebtoken
```

The token endpoint in step 1 signs JWTs with `jsonwebtoken`. If you're using TypeScript, also install its types: `npm install --save-dev @types/jsonwebtoken`.

## 1. Create the Ably token endpoint

The client authenticates with Ably using short-lived JWTs. Create a server endpoint that signs tokens with your Ably API key:

```typescript
// app/api/auth/ably-token/route.ts
import jwt from 'jsonwebtoken';
import { NextResponse } from 'next/server';

export async function GET(req: Request) {
  const apiKey = process.env.ABLY_API_KEY!;
  const [keyName, keySecret] = apiKey.split(':');

  const url = new URL(req.url);
  const clientId = url.searchParams.get('clientId') ?? `user-${crypto.randomUUID().slice(0, 8)}`;

  const token = jwt.sign(
    {
      'x-ably-clientId': clientId,
      'x-ably-capability': JSON.stringify({ '*': ['publish', 'subscribe', 'history'] }),
    },
    keySecret,
    { algorithm: 'HS256', keyid: keyName, expiresIn: '1h' },
  );

  return new NextResponse(token, {
    headers: { 'Content-Type': 'application/jwt' },
  });
}
```

## 2. Set up the Ably provider

Wrap your app in Ably's React provider. The `authCallback` fetches tokens from the endpoint above:

```typescript
// app/providers.tsx
'use client';

import { useEffect, useState, type ReactNode } from 'react';
import * as Ably from 'ably';
import { AblyProvider } from 'ably/react';

export function Providers({ clientId, children }: { clientId?: string; children: ReactNode }) {
  const [client, setClient] = useState<Ably.Realtime | null>(null);

  useEffect(() => {
    const ably = new Ably.Realtime({
      authCallback: async (_tokenParams, callback) => {
        try {
          const response = await fetch(`/api/auth/ably-token?clientId=${encodeURIComponent(clientId ?? '')}`);
          const jwt = await response.text();
          callback(null, jwt);
        } catch (err) {
          callback(err instanceof Error ? err.message : String(err), null);
        }
      },
    });
    setClient(ably);
    return () => ably.close();
  }, [clientId]);

  if (!client) return null;

  return <AblyProvider client={client}>{children}</AblyProvider>;
}
```

## 3. Create the API route

The server endpoint receives the invocation POST from the chat transport, calls the LLM, and streams the response over Ably:

```typescript
// app/api/chat/route.ts
import { after } from 'next/server';
import { streamText, convertToModelMessages } from 'ai';
import Ably from 'ably';
import type { InvocationData } from '@ably/ai-transport';
import { Invocation } from '@ably/ai-transport';
import { createAgentSession, vercelRunOutcome } from '@ably/ai-transport/vercel';
import { anthropic } from '@ai-sdk/anthropic';

export async function POST(req: Request) {
  // The chat transport POSTs an invocation pointer: { inputEventId, sessionName }.
  const data = (await req.json()) as InvocationData;
  const invocation = Invocation.fromJSON(data);

  // A fresh Ably client per request (trusted environment, API key direct).
  // The agent is ephemeral: it attaches the channel with rewind, replays the
  // just-published input event, streams the response, and closes.
  const ably = new Ably.Realtime({ key: process.env.ABLY_API_KEY! });

  const session = createAgentSession({ client: ably, channelName: invocation.sessionName });
  await session.connect();
  const run = session.createRun(invocation, { signal: req.signal });

  await run.start();

  // Drain run.view to read the conversation from the channel (the just-published
  // user input plus prior history). run.messages is only this run's own turn.
  while (run.view.hasOlder()) await run.view.loadOlder();
  const conversation = run.view.getMessages().map((m) => m.message);

  const result = streamText({
    model: anthropic('claude-sonnet-4-6'),
    system: 'You are a helpful assistant.',
    messages: await convertToModelMessages(conversation),
    abortSignal: run.abortSignal,
  });

  // Stream in the background - don't block the HTTP response.
  // The client receives tokens from the Ably channel subscription, not the HTTP response.
  after(async () => {
    const pipeResult = await run.pipe(result.toUIMessageStream());
    const outcome = await vercelRunOutcome(pipeResult, result.finishReason);
    await run.end(outcome.reason === 'suspend' ? { reason: 'complete' } : outcome);
    session.close();
    ably.close();
  });

  // Return the agent-minted ids. The chat transport routes the response over
  // the Ably channel, so it ignores the body — but the contract is honoured.
  return Response.json({ runId: run.runId, invocationId: run.invocationId });
}
```

The `after()` call is a Next.js API that runs work after the HTTP response is sent. The client receives tokens from the Ably channel subscription, not from the HTTP response body.

## 4. Create the chat component

Wire up `useChat()` with the AI Transport hooks. `ChatTransportProvider` creates both the `ClientSession` and `ChatTransport`. The Ably Realtime client is read from the surrounding `<AblyProvider>`; the session is bound to the supplied `channelName`.

```typescript
// app/chat.tsx
'use client';

import { useChat } from '@ai-sdk/react';
import { useView } from '@ably/ai-transport/react';
import { ChatTransportProvider, useChatTransport, useMessageSync } from '@ably/ai-transport/vercel/react';
import { useState } from 'react';

function ChatInner({ chatId }: { chatId: string }) {
  const [input, setInput] = useState('');

  // 1. Read the chat transport adapter and underlying session created by ChatTransportProvider
  const { chatTransport, session } = useChatTransport();

  // 2. Use Vercel's useChat with the chat transport adapter
  const { messages, setMessages, sendMessage, stop, status } = useChat({
    id: chatId,
    transport: chatTransport,
  });

  // 3. Sync session messages into useChat's state (for observer messages)
  useMessageSync({ setMessages });

  // 4. useChat's status drives the Stop / Send toggle. useChat.stop() targets
  //    the run it owns, so a global active-runs view isn't needed here.
  const isStreaming = status === 'submitted' || status === 'streaming';

  // 5. Load history on mount
  useView({ limit: 30 });

  return (
    <div>
      {messages.map((msg) => (
        <div key={msg.id}>
          <strong>{msg.role}:</strong> {msg.parts.map((part, i) => (
            part.type === 'text' ? <span key={i}>{part.text}</span> : null
          ))}
        </div>
      ))}
      <form onSubmit={(e) => { e.preventDefault(); sendMessage({ text: input }); setInput(''); }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Type a message..." />
        {isStreaming ? (
          <button type="button" onClick={stop}>Stop</button>
        ) : (
          <button type="submit">Send</button>
        )}
      </form>
    </div>
  );
}

export function Chat({ chatId }: { chatId: string }) {
  return (
    // ChatTransportProvider creates both ClientSession and ChatTransport.
    // The Realtime client is read from the surrounding <AblyProvider>; the
    // session resolves the channel from channelName itself, and takes its
    // identity from the client's clientId (set via the token below). No codec
    // argument needed.
    <ChatTransportProvider channelName={chatId}>
      <ChatInner chatId={chatId} />
    </ChatTransportProvider>
  );
}
```

## 5. Wire up the page

```typescript
// app/page.tsx
import { Providers } from './providers';
import { Chat } from './chat';

export default function Home() {
  return (
    <Providers>
      <Chat chatId="ai:demo" />
    </Providers>
  );
}
```

## 6. Set environment variables and run

```bash
export ABLY_API_KEY="your-ably-api-key"
export ANTHROPIC_API_KEY="your-anthropic-api-key"
npm run dev
```

Open `http://localhost:3000`. Type a message - you'll see tokens stream in real time over Ably.

## What's happening

1. `ChatTransportProvider` creates a `ClientSession` (subscribed to the Ably channel before attach — no messages lost) and wraps it in a `ChatTransport`. Both are stored in `ChatTransportContext` for descendants.
2. `useChatTransport()` reads both from `ChatTransportContext` — no arguments needed for the nearest provider.
3. `chatTransport` satisfies Vercel's `ChatTransport` interface; `session` is the underlying `ClientSession` used for `useMessageSync` and `useView`.
4. When you send a message, `useChat()` calls the chat transport's `sendMessages`, which publishes your message on the Ably channel and POSTs the run's invocation pointer (`{ inputEventId, sessionName }`) to `/api/chat` to wake the agent.
5. The server creates a run, reads the conversation by draining `run.view` (paging `loadOlder()` until `hasOlder()` is false), streams the LLM response through the encoder to the channel, and publishes a run-end event.
6. The client session decodes incoming Ably messages through `UIMessageCodec` and routes them to the stream.
7. `useMessageSync()` syncs messages from the session (including messages from other clients) into `useChat`'s state.

For the conceptual details, see [Client and agent sessions](../concepts/sessions.md) and [Runs](../concepts/runs.md).

## Next steps

- [Cancel](../features/cancel.md) - add a stop button that cancels in-progress generation
- [History](../features/history.md) - load conversation history on page refresh
- [Conversation branching](../features/branching.md) - add regenerate and edit
- [Multi-client sync](../features/multi-client.md) - open two browser windows to the same chat
