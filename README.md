![Ably AI Transport Header](/images/JavaScriptSDK-AITransport-github.png)
[![npm version](https://img.shields.io/npm/v/@ably/ai-transport.svg?style=flat)](https://www.npmjs.com/package/@ably/ai-transport)
[![License](https://img.shields.io/github/license/ably/ably-ai-transport-js.svg)](https://github.com/ably/ably-ai-transport-js/blob/main/LICENSE)

# Ably AI Transport JavaScript SDK

Ably AI Transport is a durable transport for AI applications. Your agent streams tokens onto an Ably channel rather than into an HTTP response, so a client that reconnects picks up where it left off, the same conversation is open on any device the user picks up, and any participant can cancel, interrupt, or steer a response that is still in flight.

AI Transport is not an agent framework, and it holds no conversation state. It carries runs, steps and codec events over one channel; your application merges that event stream into its own messages and owns the store. It works alongside the stack you already have: the Vercel AI SDK, the OpenAI Responses API, or your own framework through a custom codec. Everything is built on [Ably](https://ably.com/) channels, so ordering, persistence, history, and presence come from the platform rather than from your application code.

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

---

## Supported platforms

Ably aims to support a wide range of platforms. If you experience any compatibility issues, open an issue in the repository or contact [Ably support](https://ably.com/support).

This SDK supports the following platforms:

| Platform      | Support                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------- |
| Node.js       | Version 22 or newer.                                                                      |
| Browsers      | All major desktop and mobile browsers, including Chrome, Firefox, Edge, and Safari.       |
| TypeScript    | Fully supported, the library is written in TypeScript and ships its own type definitions. |
| React         | Versions 18 and 19, through `@ably/ai-transport/react`.                                   |
| Vercel AI SDK | Versions 6 and 7, through `@ably/ai-transport/vercel`.                                    |
| OpenAI        | The Responses API, through `@ably/ai-transport/openai`.                                   |

The Ably Pub/Sub SDK (`ably`) version 2.23.0 or newer is required in every case. `ai`, `openai`, and `react` are optional peer dependencies, each needed only by the entry point that uses it.

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

For a React project, add `react`. The React entry point builds on ably-js's own
React hooks, which ship inside the `ably` package:

```sh
npm install ably @ably/ai-transport react
```

AI Transport streams a response by appending tokens to a single Ably message, which requires the `mutableMessages` channel rule on the namespace your conversations live in. This is a one-time setup per Ably app: without it the first append fails with error `93002` and no tokens reach the client. See [configure channel rules](https://ably.com/docs/ai-transport/getting-started/channel-rules).

---

## Usage

The following code streams a model response from a Next.js route handler onto an
Ably channel, then reads it back on a client. The SDK carries the events; your
application decides what to do with them and owns the conversation store.
[Get started with Vercel AI SDK](https://ably.com/docs/ai-transport/getting-started/vercel-ai-sdk)
builds the same app in full, including the authentication endpoint.

### Agent

```typescript
import { after } from 'next/server';
import { streamText, convertToModelMessages } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import * as Ably from 'ably';
import { channelAgent, createAgentTransport, resolveChannelModes } from '@ably/ai-transport';
import { createUIMessageCodec, vercelRunOutcome } from '@ably/ai-transport/vercel';

const ably = new Ably.Realtime({ key: process.env.ABLY_API_KEY });

export async function POST(req: Request) {
  // The POST only wakes the agent. Tokens reach every subscribed client over
  // the channel, so the response body carries nothing the client reads.
  const { channelName, eventId } = (await req.json()) as { channelName: string; eventId: string };

  // The caller resolves the channel, so the caller stamps the SDK's identity
  // on it and funnels its modes through resolveChannelModes() — which yields
  // undefined for the server's default mode set, and takes OBJECT_MODES for a
  // channel that also needs LiveObjects. Every resolver of the same channel
  // must request the same modes in the same order, or they reattach it.
  const codec = createUIMessageCodec();
  // Attach per request: history pages backwards from the attach point, so a
  // transport attached before the client published could never locate it.
  const transport = createAgentTransport({
    channel: ably.channels.get(channelName, {
      params: { agent: channelAgent(codec) },
      modes: resolveChannelModes(),
    }),
    codec,
  });
  await transport.connect();

  const located = await transport.locateInput(eventId);
  if (!located) return new Response('input not found', { status: 404 });

  // Opening from the located input is what anchors the run to its trigger, so
  // the client can resolve the run id off the channel.
  const run = transport.openRun({ input: located }, { signal: req.signal });

  after(async () => {
    // Your own store owns the conversation; the transport holds no state.
    const conversation = await getStoredMessages(channelName);

    const result = streamText({
      model: anthropic('claude-sonnet-4-6'),
      system: 'You are a helpful assistant.',
      messages: await convertToModelMessages(conversation),
      abortSignal: run.abortSignal, // Fires when any client cancels this run
    });

    const pipeResult = await run.pipe(result.toUIMessageStream());
    const outcome = await vercelRunOutcome(pipeResult, result.finishReason);
    // A turn that produced tool calls is still terminal: end the run and let
    // the client's next input wake a new one.
    await run.end(outcome.reason === 'suspend' ? { reason: 'complete' } : outcome);
    transport.close();
  });

  return new Response('', { status: 202 });
}
```

### Client

Publishing an input and waking the agent is two calls. Reading the reply is a
subscription: each inbound wire message arrives as one classified event, and the
application merges the events it cares about into whatever state it renders from.

```typescript
import * as Ably from 'ably';
import { channelAgent, createClientTransport, resolveChannelModes } from '@ably/ai-transport';
import { createUIMessageCodec } from '@ably/ai-transport/vercel';

const ably = new Ably.Realtime({ authUrl: '/api/auth/token', clientId: 'user-abc' });
const channelName = 'conversations:abc';
const codec = createUIMessageCodec();

// Resolving the channel yourself means stamping the SDK's identity on it and
// funnelling its modes through resolveChannelModes() — see the agent example.
const transport = createClientTransport({
  channel: ably.channels.get(channelName, {
    params: { agent: channelAgent(codec) },
    modes: resolveChannelModes(),
  }),
  codec,
  clientId: 'user-abc',
});
await transport.connect();

// One event per inbound wire message: a decoded message, or a run/step
// lifecycle bracket. Nothing here assembles a message list — that is yours.
transport.subscribe((event) => {
  if (event.kind === 'message') {
    // `event.outputs` are the provider's own chunks, in wire order. Hand them
    // to the provider's reducer, keyed by `event.meta.transportMessageId`.
    merge(event.meta.transportMessageId, event.outputs);
    return;
  }
  if (event.kind === 'run-lifecycle' && event.event.type === 'end') {
    // A run that has ended publishes nothing more.
    markRunFinished(event.event.runId);
  }
});

// Publish the turn, then wake the agent. The channel carries the reply; the
// POST body does not.
const sent = await transport.publishInput({
  kind: 'message',
  payload: { id: 'm1', role: 'user', parts: [{ type: 'text', text: "what's the weather?" }] },
});
await fetch('/api/chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ channelName, eventId: sent.eventId }),
});

// The run id resolves off the channel, from the `ai-run-start` the agent
// published for this input — never out of the POST response. `publishInput`
// hands back a promise for it, so a cancel awaits that first.
const runId = await sent.runId;
const stopButton = document.querySelector('button');
stopButton?.addEventListener('click', () => void transport.cancel(runId));
```

To rebuild a conversation on load, page backwards from the attach point with
`transport.history()` and merge the batches oldest-first.

### React client

`@ably/ai-transport/react` is the same client transport behind a provider and
two hooks. The provider resolves the channel from the surrounding
`<AblyProvider>`, so the channel wiring the example above does by hand is
handled for you.

```tsx
import * as Ably from 'ably';
import { AblyProvider } from 'ably/react';
import { ClientTransportProvider, useClientTransport, useTransportEvents } from '@ably/ai-transport/react';
import { createUIMessageCodec } from '@ably/ai-transport/vercel';

const ably = new Ably.Realtime({ authUrl: '/api/auth/token', clientId: 'user-abc' });
const codec = createUIMessageCodec();

function App() {
  return (
    <AblyProvider client={ably}>
      <ClientTransportProvider
        channelName="conversations:abc"
        codec={codec}
        clientId="user-abc"
      >
        <Chat />
      </ClientTransportProvider>
    </AblyProvider>
  );
}

function Chat() {
  const { transport, error } = useClientTransport();

  // One event per inbound wire message, the same classification the plain
  // client sees. The handler is latched in an effect, so an inline closure is
  // fine and does not resubscribe.
  useTransportEvents((event) => {
    if (event.kind === 'message') merge(event.meta.transportMessageId, event.outputs);
  });

  if (error) return <p>Transport unavailable: {error.message}</p>;

  const send = async (text: string) => {
    // `transport` is undefined until the provider has built and connected it,
    // so guard before publishing.
    if (!transport) return;
    const sent = await transport.publishInput({
      kind: 'message',
      payload: { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] },
    });
    await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channelName: 'conversations:abc', eventId: sent.eventId }),
    });
  };

  return <Composer onSend={send} />;
}
```

Nest providers with distinct channel names to hold more than one conversation
at once, and pass `channelName` to either hook to pick which one it reads.

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
