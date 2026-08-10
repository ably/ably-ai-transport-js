![Ably AI Transport Header](/images/JavaScriptSDK-AITransport-github.png)
[![npm version](https://img.shields.io/npm/v/@ably/ai-transport.svg?style=flat)](https://www.npmjs.com/package/@ably/ai-transport)
[![License](https://img.shields.io/github/license/ably/ably-ai-transport-js.svg)](https://github.com/ably/ably-ai-transport-js/blob/main/LICENSE)

# Ably AI Transport JavaScript SDK

Ably AI Transport is a durable session layer for AI applications. Your agent streams tokens into a session rather than into an HTTP response, so a client that reconnects picks up where it left off, the same conversation is open on any device the user picks up, and any participant can cancel, interrupt, or steer a response that is still in flight.

AI Transport is not an agent framework. It replaces the transport between your agents and your users and works alongside the stack you already have: Vercel AI SDK, Vercel Workflow Development Kit, Temporal, or your own framework through a custom codec. Sessions are built on [Ably](https://ably.com/) channels, so ordering, persistence, history, and presence come from the platform rather than from your application code.

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
| Vercel AI SDK | Version 6, through the codec, session factories, and `useChat` transport adapter.             |
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
import { streamText, convertToModelMessages } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import * as Ably from 'ably';
import { Invocation } from '@ably/ai-transport';
import { createAgentSession, vercelRunOutcome } from '@ably/ai-transport/vercel';

const ably = new Ably.Realtime({ key: process.env.ABLY_API_KEY });

export async function POST(req: Request) {
  // The POST only triggers the agent. Tokens reach every subscribed client
  // over the session, so the response body carries nothing but the run ids.
  const invocation = Invocation.fromJSON(await req.json());

  const session = createAgentSession({ client: ably, channelName: invocation.sessionName });
  await session.connect();
  const run = session.createRun(invocation, { signal: req.signal });

  after(async () => {
    // Page in the conversation so far, then open the run on the session.
    while (run.view.hasOlder()) await run.view.loadOlder();
    await run.start();
    const conversation = run.view.getMessages().map(({ message }) => message);

    const result = streamText({
      model: anthropic('claude-sonnet-4-6'),
      system: 'You are a helpful assistant.',
      messages: await convertToModelMessages(conversation),
      abortSignal: run.abortSignal, // Fires when any client cancels this run
    });

    const pipeResult = await run.pipe(result.toUIMessageStream());
    const outcome = await vercelRunOutcome(pipeResult, result.finishReason);
    if (outcome.reason === 'suspend') {
      await run.suspend(); // Paused on a client-executed tool or an approval
    } else {
      await run.end(outcome);
    }
    await session.end();
  });

  return Response.json({ runId: run.runId, invocationId: run.invocationId });
}
```

### Client

```tsx
'use client';

import { useEffect, useState, type ReactNode } from 'react';
import * as Ably from 'ably';
import { AblyProvider } from 'ably/react';
import { useChat } from '@ai-sdk/react';
import { ChatTransportProvider, useChatTransport, useMessageSync } from '@ably/ai-transport/vercel/react';

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
  const { session, chatTransport } = useChatTransport();
  const { messages, setMessages, sendMessage, status } = useChat({ transport: chatTransport });

  // Anything the agent publishes, and anything the user sends from another
  // device, arrives over the session rather than in a fetch response.
  useMessageSync({ setMessages });

  const stop = () => {
    const active = session.view.runs().find((run) => run.status === 'active');
    if (active) void session.cancel(active.runId);
  };

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
          onClick={stop}
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
