![Ably AI Transport Header](/images/JavaScriptSDK-AITransport-github.png)
[![npm version](https://img.shields.io/npm/v/@ably/ai-transport.svg?style=flat)](https://www.npmjs.com/package/@ably/ai-transport)
[![License](https://img.shields.io/github/license/ably/ably-ai-transport-js.svg)](https://github.com/ably/ably-ai-transport-js/blob/main/LICENSE)

# Ably AI Transport JavaScript SDK

Ably AI Transport carries an AI agent's output over an Ably channel. Your agent pipes the stream its model SDK gives it onto the channel, and every client on the channel receives each event as it is produced. A client that reconnects picks up where it left off, and a conversation is open on every device the user picks up.

The SDK is a transport and a set of codecs. A codec turns each event of a model SDK into one Ably message operation and back; the transport publishes, subscribes and pages history. It holds no conversation state: your application merges the event stream into its own messages, with the model SDK's own reducer where it has one. Codecs ship for the Vercel AI SDK and the OpenAI Responses API, and `defineCodec` builds one for any other framework. Everything is built on [Ably](https://ably.com/) channels, so ordering, persistence, history, and presence come from the platform rather than from your application code.

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

For a React project, add `react`. The React entry point builds on ably-js's own React hooks, which ship inside the `ably` package:

```sh
npm install ably @ably/ai-transport react
```

AI Transport streams a response by appending tokens to a single Ably message, which requires the `mutableMessages` channel rule on the namespace your conversations live in. This is a one-time setup per Ably app: without it the first append fails with error `93002` and no tokens reach the client. See [configure channel rules](https://ably.com/docs/ai-transport/getting-started/channel-rules).

---

## Usage

The following code streams a model response from a Next.js route handler onto an Ably channel, then reads it back on a client. The SDK carries the events; your application decides what to do with them and owns the conversation. `demo/minimal` in this repository is the same app in full, with the authentication endpoint.

### Agent

```typescript
import { streamText, convertToModelMessages, toUIMessageStream, type UIMessage } from 'ai';
import { openai } from '@ai-sdk/openai';
import * as Ably from 'ably';
import { channelAgent, createTransport, ErrorCode } from '@ably/ai-transport';
import { vercel } from '@ably/ai-transport/vercel';

const ably = new Ably.Realtime({ key: process.env.ABLY_API_KEY });

export async function POST(req: Request) {
  // The client has already published its message on the channel; the POST
  // wakes the agent with the conversation so far. Tokens reach every client
  // over the channel, so the response body carries nothing the client reads.
  const { channelName, messages } = (await req.json()) as { channelName: string; messages: UIMessage[] };

  // You resolve the channel, so you stamp the SDK's identity on it with
  // channelAgent(codec). Every resolver of the same channel must request the
  // same options, or ably-js reattaches it.
  const channel = ably.channels.get(channelName, { params: { agent: channelAgent(vercel) } });
  const transport = createTransport({ channel, codec: vercel });

  const result = streamText({
    model: openai('gpt-4o-mini'),
    messages: await convertToModelMessages(messages),
    abortSignal: req.signal,
  });

  // One Ably operation per chunk: a text or tool-input stream's deltas share
  // one message that grows by appends, and every other chunk, the stream's
  // start and end included, is a publish. The pipe resolves with the serial of
  // its last publish, and rejects with an ErrorInfo whose code says whether
  // the signal cancelled it (OperationCancelled) or it failed (PipeFailed).
  try {
    await transport.pipe(toUIMessageStream({ stream: result.fullStream }), { signal: req.signal });
    return new Response(null, { status: 204 });
  } catch (error) {
    const cancelled = error instanceof Ably.ErrorInfo && error.code === ErrorCode.OperationCancelled;
    return new Response(null, { status: cancelled ? 204 : 500 });
  } finally {
    await transport.close();
  }
}
```

### Client

Publishing a message is one call, and reading the reply is a subscription. Each inbound Ably message arrives as one delivery holding the decoded event, and the application folds the events into whatever it renders from.

```typescript
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import * as Ably from 'ably';
import { channelAgent, createTransport, type Delivery } from '@ably/ai-transport';
import { vercel, type VercelEvent } from '@ably/ai-transport/vercel';

const ably = new Ably.Realtime({ authUrl: '/api/auth/token' });
const channelName = 'conversations:abc';

const channel = ably.channels.get(channelName, { params: { agent: channelAgent(vercel) } });
const transport = createTransport({ channel, codec: vercel });

// One delivery per inbound Ably message. The first subscribe attaches the
// channel; nothing here assembles a message list, that is yours. Here the AI
// SDK's own reducer folds one reply: `start` opens a stream, and every chunk
// until `finish` goes into it.
let reply: ReadableStreamDefaultController<UIMessageChunk> | undefined;
const unsubscribe = transport.subscribe(({ event }) => {
  if (event === undefined || event.type === 'user-message') return;
  if (event.type === 'start') {
    const stream = new ReadableStream<UIMessageChunk>({ start: (c) => (reply = c) });
    void fold(stream);
  }
  reply?.enqueue(event);
  if (event.type === 'finish') reply?.close();
});
// The channel is the caller's, so its state is read from it directly.
await channel.whenState('attached');

async function fold(stream: ReadableStream<UIMessageChunk>) {
  for await (const message of readUIMessageStream({ stream })) render(message);
}

// Publish the turn on the channel, then wake the agent. Your own message comes
// back as an ordinary delivery under the serial send returns.
const message: UIMessage = { id: 'm1', role: 'user', parts: [{ type: 'text', text: "what's the weather?" }] };
const { serial } = await transport.send({ type: 'user-message', message });
await fetch('/api/chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ channelName, messages: [message] }),
});
```

To recover from a discontinuity, a channel state change after which messages may have been missed, page history back from the new attach point until you reach the last serial you applied, and apply what is newer. Serials sort as strings, so the comparison is a string comparison. Live delivery carries on during the walk, so the snippet parks what arrives in a buffer and releases it once the gap has been applied, which keeps everything in order. `demo/minimal/src/app/chat.tsx` does the same inside a component.

```typescript
let lastSeen: string | undefined;
let held: Delivery<VercelEvent>[] | undefined; // the fuse: set while a recovery walk runs

const apply = (delivery: Delivery<VercelEvent>) => {
  handle(delivery);
  lastSeen = delivery.message.serial; // after applying, so it never points past what the UI shows
};

transport.subscribe((delivery) => {
  if (held) {
    held.push(delivery); // parked until the walk has caught up
    return;
  }
  apply(delivery);
});

transport.on('discontinuity', async () => {
  held = [];
  const missed: Delivery<VercelEvent>[] = [];
  let page = await transport.history({ limit: 100 });
  for (;;) {
    const newer = page.items.filter((d) => lastSeen === undefined || (d.message.serial ?? '') > lastSeen);
    missed.unshift(...newer); // pages arrive newest first; keep the gap oldest first
    if (newer.length < page.items.length || !page.hasNext) break; // reached what was already applied
    page = await page.next();
  }
  for (const delivery of missed) apply(delivery);
  const parked = held;
  held = undefined; // close the fuse, then drain in arrival order
  for (const delivery of parked) apply(delivery);
});
```

To read a finished conversation, `transport.history({ limit })` opens a walk backwards from the attach point and returns its newest page; `page.next()` reads the older ones while `page.hasNext` is true. A streamed reply reads back as the chunks the agent produced, with one difference: its deltas share one message, so they come back as one delta carrying the whole text, between the same start and end chunks a live subscriber saw. The AI SDK's reducer folds that sequence as it folds the live one. Every delivery, live or from history, carries the raw Ably message, and `event` is `undefined` for a message the codec has nothing for, such as another application's publish on the same channel.

### React client

`@ably/ai-transport/react` is the same transport behind a provider and four hooks. The provider resolves the channel from the surrounding `<AblyProvider>`, so the channel wiring the example above does by hand is handled for you.

```tsx
import * as Ably from 'ably';
import { AblyProvider } from 'ably/react';
import { TransportProvider, useDeliveries, useTransport } from '@ably/ai-transport/react';
import { vercel, type VercelEvent } from '@ably/ai-transport/vercel';

const ably = new Ably.Realtime({ authUrl: '/api/auth/token' });

function App() {
  return (
    <AblyProvider client={ably}>
      <TransportProvider
        channelName="conversations:abc"
        codec={vercel}
      >
        <Chat />
      </TransportProvider>
    </AblyProvider>
  );
}

function Chat() {
  const { transport, error } = useTransport<VercelEvent>();

  // One delivery per inbound Ably message, as the plain client sees. The
  // latest handler is read on each delivery, so an inline closure is fine
  // and resubscribes nothing. The first subscribe attaches the channel.
  useDeliveries<VercelEvent>(({ event }) => {
    if (event !== undefined) fold(event);
  });

  if (error) return <p>Transport unavailable: {error.message}</p>;

  const send = async (text: string) => {
    // `transport` is undefined until the provider has built it, so guard.
    if (!transport) return;
    const message = { id: crypto.randomUUID(), role: 'user' as const, parts: [{ type: 'text' as const, text }] };
    await transport.send({ type: 'user-message', message });
    await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channelName: 'conversations:abc', messages: [message] }),
    });
  };

  return (
    <Composer
      onSend={send}
      disabled={!transport}
    />
  );
}
```

`useHistory({ limit })` reads the channel's history one page at a time, `useTransportStatus()` reports a discontinuity and the transport's errors, and the channel's own state is ably-js's `useChannelStateListener` under the provider. Nesting providers with distinct channel names holds more than one conversation at once; pass `channelName` to any hook to pick which one it reads.

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
