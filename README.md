![Ably AI Transport Header](/images/JavaScriptSDK-AITransport-github.png)
[![npm version](https://img.shields.io/npm/v/@ably/ai-transport.svg?style=flat)](https://www.npmjs.com/package/@ably/ai-transport)
[![License](https://img.shields.io/github/license/ably/ably-ai-transport-js.svg)](https://github.com/ably/ably-ai-transport-js/blob/main/LICENSE)

# Ably AI Transport JavaScript SDK

Ably AI Transport is a durable transport for AI applications. Your agent streams tokens onto an Ably channel rather than into an HTTP response, so a client that reconnects picks up where it left off, the same conversation is open on any device the user picks up, and any participant can cancel, interrupt, or steer a response that is still in flight.

AI Transport is not an agent framework. It replaces the transport between your agents and your users and works alongside the stack you already have: Vercel AI SDK, Vercel Workflow Development Kit, Temporal, or your own framework through a custom codec. The transport runs over [Ably](https://ably.com/) channels, so ordering, persistence, history, and presence come from the platform rather than from your application code. The wire carries the provider's own event vocabulary, so the provider's own tooling — Vercel's `useChat` and `readUIMessageStream`, OpenAI's response accumulator — assembles messages on the client; the SDK moves bytes, brackets runs, and pages history.

> [!NOTE]
> This SDK is pre-release (`0.x`). The public API is still changing and minor versions can carry breaking changes. [CHANGELOG.md](./CHANGELOG.md) records what moved in each release.

Find out more:

- [Ably AI Transport docs.](https://ably.com/docs/ai-transport)
- [Ably AI Transport examples.](https://ably.com/examples?product=ai_transport)

---

## Getting started

Everything you need to get started with Ably AI Transport:

- [Get started with the Core SDK.](https://ably.com/docs/ai-transport/getting-started/core-sdk)
- [Get started with Vercel AI SDK.](https://ably.com/docs/ai-transport/getting-started/vercel-ai-sdk)
- [Get started with Vercel Workflow Development Kit.](https://ably.com/docs/ai-transport/getting-started/vercel-wdk)
- [Get started with Temporal.](https://ably.com/docs/ai-transport/getting-started/temporal)

---

## Supported platforms

Ably aims to support a wide range of platforms. If you experience any compatibility issues, open an issue in the repository or contact [Ably support](https://ably.com/support).

This SDK supports the following platforms:

| Platform      | Support                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------- |
| Node.js       | Version 22 or newer.                                                                          |
| Browsers      | All major desktop and mobile browsers, including Chrome, Firefox, Edge, and Safari.           |
| TypeScript    | Fully supported, the library is written in TypeScript and ships its own type definitions.     |
| React         | Versions 18 and 19, through `@ably/ai-transport/react` and `@ably/ai-transport/vercel/react`. |
| Vercel AI SDK | Versions 6 and 7, through the codec, transport factories, and `useChat` transport adapter.    |
| Temporal      | TypeScript SDK v1, through the durable-execution helpers in `@ably/ai-transport/temporal`.    |

The Ably Pub/Sub SDK (`ably`) version 2.23.0 or newer is required in every case. `ai`, `react`, and `@temporalio/activity` are optional peer dependencies, each needed only by the entry point that uses it.

---

## Installation

The AI Transport SDK is available as an [npm module](https://www.npmjs.com/package/@ably/ai-transport). It is built on top of the Ably Pub/Sub SDK and uses that to establish a connection with Ably, so install both:

```sh
npm install ably @ably/ai-transport
```

For a Vercel AI SDK project, add `ai` as well:

```sh
npm install ably @ably/ai-transport ai
```

AI Transport streams a response by appending tokens to a single Ably message, which requires the `mutableMessages` channel rule on the namespace your sessions live in. This is a one-time setup per Ably app: without it the first append fails with error `93002` and no tokens reach the client. See [configure channel rules](https://ably.com/docs/ai-transport/getting-started/channel-rules).

---

## Usage

The following code streams a model response from a Next.js route handler into a durable session, then renders it in React through Vercel AI SDK's `useChat`. [Get started with Vercel AI SDK](https://ably.com/docs/ai-transport/getting-started/vercel-ai-sdk) builds the same app in full, including the authentication endpoint.

### Agent

```typescript
import { after } from 'next/server';
import { convertToModelMessages, readUIMessageStream, streamText, type UIMessage, type UIMessageChunk } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import * as Ably from 'ably';
import { createAgentTransport, type VercelInput, type VercelOutput } from '@ably/ai-transport/vercel';
import type { AgentTransport } from '@ably/ai-transport';

const ably = new Ably.Realtime({ key: process.env.ABLY_API_KEY });

// Assemble the conversation from the channel: bucket each message's events by
// its transport-message-id, then merge every bucket with the AI SDK's own reducer.
async function mergeConversation(transport: AgentTransport<VercelInput, VercelOutput>): Promise<UIMessage[]> {
  const buckets = new Map<string, UIMessageChunk[]>();
  const wholeMessages = new Map<string, UIMessage>();
  for (let batch = await transport.history(); ; batch = await transport.history()) {
    for (const event of batch.events) {
      if (event.kind !== 'message' || event.meta.transportMessageId === undefined) continue;
      const id = event.meta.transportMessageId;
      const bucket = buckets.get(id) ?? [];
      buckets.set(id, bucket);
      bucket.push(...event.outputs);
      for (const input of event.inputs) {
        if (input.kind === 'chunk') bucket.push(input.payload);
        if (input.kind === 'message') {
          const existing = wholeMessages.get(id);
          if (existing) existing.parts.push(...input.payload.parts);
          else wholeMessages.set(id, structuredClone(input.payload));
        }
      }
    }
    if (batch.exhausted) break;
  }
  const conversation: UIMessage[] = [];
  for (const [id, chunks] of buckets) {
    const whole = wholeMessages.get(id);
    if (whole) {
      conversation.push(whole);
      continue;
    }
    const stream = new ReadableStream<UIMessageChunk>({
      start: (c) => {
        for (const chunk of chunks) c.enqueue(chunk);
        c.close();
      },
    });
    let last: UIMessage | undefined;
    for await (const message of readUIMessageStream({ stream })) last = message;
    if (last) conversation.push(last);
  }
  return conversation;
}

export async function POST(req: Request) {
  // The POST only names the input that woke the agent. Tokens reach every
  // subscribed client over the channel, so the response carries only the run id.
  const { channelName, eventId, runId } = (await req.json()) as {
    channelName: string;
    eventId: string;
    runId?: string;
  };

  const transport = createAgentTransport({ channel: ably.channels.get(channelName) });
  await transport.connect();

  // Find the input that woke this invocation, then open the run it triggers —
  // a fresh run, or a resume when the client named the run to continue.
  const located = await transport.locateInput(eventId);
  const run = transport.openRun(
    {
      ...(runId ? { runId, publish: 'resume' as const } : {}),
      ...(located?.meta.transportMessageId ? { inputTransportMessageId: located.meta.transportMessageId } : {}),
    },
    { signal: req.signal }, // Fires when any client cancels this run
  );

  after(async () => {
    const conversation = await mergeConversation(transport);

    const result = streamText({
      model: anthropic('claude-sonnet-4-6'),
      system: 'You are a helpful assistant.',
      messages: await convertToModelMessages(conversation),
      abortSignal: run.abortSignal,
    });

    const pipeResult = await run.pipe(result.toUIMessageStream());
    await run.end({ reason: pipeResult.reason === 'error' ? 'error' : 'complete' });
    transport.close();
  });

  return Response.json({ runId: run.runId });
}
```

### Client

```tsx
'use client';

import { useEffect, useState, type ReactNode } from 'react';
import * as Ably from 'ably';
import { AblyProvider } from 'ably/react';
import { useChat } from '@ai-sdk/react';
import { ChatTransportProvider, useChatTransport } from '@ably/ai-transport/vercel/react';

export default function Page() {
  return (
    <Providers>
      <ChatTransportProvider channelName="conversations:my-session">
        <Chat />
      </ChatTransportProvider>
    </Providers>
  );
}

function Chat() {
  const [input, setInput] = useState('');
  const { chatTransport } = useChatTransport();
  // The adapter drops straight into useChat: sends publish to the channel,
  // the streamed reply arrives over it, and `resume` reconnects to a run
  // still in flight after a reload. Anything the agent publishes, and
  // anything the user sends from another device, arrives over the channel
  // rather than in a fetch response.
  const { messages, sendMessage, stop, status } = useChat({ transport: chatTransport, resume: true });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        sendMessage({ text: input });
        setInput('');
      }}
    >
      {messages.map((message) => (
        <p key={message.id}>
          {message.role}: {message.parts.map((part) => (part.type === 'text' ? part.text : null))}
        </p>
      ))}
      <input
        value={input}
        onChange={(event) => setInput(event.target.value)}
      />
      {status === 'submitted' || status === 'streaming' ? (
        <button
          type="button"
          onClick={() => void stop()}
        >
          Stop
        </button>
      ) : (
        <button type="submit">Send</button>
      )}
    </form>
  );
}

// Create the Ably client in an effect so it never connects during SSR.
function Providers({ children }: { children: ReactNode }) {
  const [client, setClient] = useState<Ably.Realtime | null>(null);

  useEffect(() => {
    const ably = new Ably.Realtime({ authUrl: '/api/auth/token', clientId: 'user-abc' });
    setClient(ably);
    return () => ably.close();
  }, []);

  if (!client) return null;
  return <AblyProvider client={client}>{children}</AblyProvider>;
}
```

---

## Contribute

Read the [CONTRIBUTING.md](./CONTRIBUTING.md) guidelines to contribute to Ably, or [open an issue](https://github.com/ably/ably-ai-transport-js/issues) to share feedback or request a feature.

---

## Releases

The [CHANGELOG.md](./CHANGELOG.md) contains details of the latest releases for this SDK. You can also view all Ably releases on [changelog.ably.com](https://changelog.ably.com).

---

## Support, feedback, and troubleshooting

For help or technical support, visit Ably's [support page](https://ably.com/support) or [GitHub Issues](https://github.com/ably/ably-ai-transport-js/issues) for community-reported bugs and discussions.

[Troubleshooting AI Transport](https://ably.com/docs/ai-transport/troubleshooting) covers the failures teams hit most often, with the error codes to match.
