![Ably AI Transport Header](/images/JavaScriptSDK-AITransport-github.png)
[![npm version](https://img.shields.io/npm/v/@ably/ai-transport.svg?style=flat)](https://www.npmjs.com/package/@ably/ai-transport)
[![License](https://img.shields.io/github/license/ably/ably-ai-transport-js.svg)](https://github.com/ably/ably-ai-transport-js/blob/main/LICENSE)

# Ably AI Transport JavaScript SDK

Ably AI Transport carries an AI agent's output over an Ably channel. Your agent pipes LLM output to clients over Ably messages, and every client on the channel receives each event as it is produced, in realtime. A client that reconnects picks up where it left off, and a conversation is available on all the user's devices.

The SDK is a transport and a set of codecs. A codec converts each event from the LLM output into one Ably message operation and back; the transport publishes, subscribes and pages history. Your application merges the event stream into its own messages. The SDK includes codecs for the Vercel AI SDK, the OpenAI Responses API and AG-UI. Or you can easily define your own codec using the `defineCodec` builder. Everything is built on [Ably](https://ably.com/) channels, so ordering, persistence, history, and presence come from the platform rather than from your application code.

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
| AG-UI         | Version 1 events, through `@ably/ai-transport/ag-ui`.                                     |

The Ably Pub/Sub SDK (`ably`) version 2.23.0 or newer is required in every case. `ai`, `openai`, `@ag-ui/core`, and `react` are optional peer dependencies, each needed only by the entry point that uses it.

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
import { createTransport, ErrorCode } from '@ably/ai-transport';
import { vercel } from '@ably/ai-transport/vercel';

const ably = new Ably.Realtime({ key: process.env.ABLY_API_KEY });

export async function POST(req: Request) {
  // The client has already published its message on the channel; the POST
  // wakes the agent with that one message. Record it in your store and
  // hydrate the conversation so far from there, never from the request body.
  // Tokens reach every client over the channel, so the response body carries
  // nothing the client reads.
  const { channelName, message } = (await req.json()) as { channelName: string; message: UIMessage };
  await recordMessage(channelName, message);
  const messages: UIMessage[] = await loadConversation(channelName);

  // The transport resolves the channel off the client and owns its options.
  // You keep the client: close() never closes it, and detaches the channel
  // only when the transport attached it.
  const transport = createTransport({ client: ably, channelName, codec: vercel });

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
  // The headers ride on every message of the reply, so the client can tell
  // which prompt it answers.
  try {
    await transport.pipe(toUIMessageStream({ stream: result.fullStream }), {
      signal: req.signal,
      headers: { requestId: 'm1' },
    });
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

Publishing a message is one call, and reading the reply is a subscription. Each inbound Ably message arrives as one delivery holding the decoded event, and the application merges the events into whatever it renders from.

```typescript
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import * as Ably from 'ably';
import { createTransport, type Delivery } from '@ably/ai-transport';
import { vercel, type VercelEvent } from '@ably/ai-transport/vercel';

const ably = new Ably.Realtime({ authUrl: '/api/auth/token' });
const channelName = 'conversations:abc';

const transport = createTransport({ client: ably, channelName, codec: vercel });

// One delivery per inbound Ably message. The first subscribe attaches the
// channel; nothing here assembles a message list, that is yours. Here the AI
// SDK's own reducer merges one reply: `start` opens a stream, and every chunk
// until `finish` goes into it.
let reply: ReadableStreamDefaultController<UIMessageChunk> | undefined;
const unsubscribe = transport.subscribe(({ event }) => {
  if (event === undefined || event.type === 'user-message') return;
  if (event.type === 'start') {
    const stream = new ReadableStream<UIMessageChunk>({ start: (c) => (reply = c) });
    void merge(stream);
  }
  reply?.enqueue(event);
  if (event.type === 'finish') reply?.close();
});
// To read the channel's state, ask for it by name with no options of your own
// and you get the one the transport resolved.
await ably.channels.get(channelName).whenState('attached');

async function merge(stream: ReadableStream<UIMessageChunk>) {
  for await (const message of readUIMessageStream({ stream })) render(message);
}

// Publish the turn on the channel, then wake the agent with the same message.
// Your own message comes back as an ordinary delivery under the serial send
// returns; the agent hydrates the rest of the conversation from its store.
const message: UIMessage = { id: 'm1', role: 'user', parts: [{ type: 'text', text: "what's the weather?" }] };
const { serial } = await transport.send({ type: 'user-message', message }, { headers: { requestId: message.id } });
await fetch('/api/chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ channelName, message }),
});
```

### Catching up from history

A subscriber can join data from their database with a position on the channel, by replaying history messages from the last recorded position in their database. A replay will paginate backwards (newest -> oldest messages) until it finds the required message and buffer live messages while paginating. Once the required message is found, it will release the messages in-order (oldest -> newest) through the subscribe handler; starting with those found in history, then the live subscription buffer, then the ongoing live subscription messages.

```typescript
import { fromSerial, untilEvent } from '@ably/ai-transport';

// From the serial your store holds, the one a publish ack returned. The
// messages after it are replayed; `inclusive: true` replays the message at
// the serial too.
const subscription = transport.subscribe(handle, {
  history: { replay: fromSerial(stored.serial), pageSize: 100 },
});
const { replayed, found } = await subscription.replayed; // rejects when the replay failed
subscription(); // calling it unsubscribes

// Another option, if you do not have a serial stored, is to find the last event to
// replay from by a property of that event. Here, the most recent event whose
// `type` is `finish`.
transport.subscribe(handle, {
  history: { replay: untilEvent((d) => d.event?.type === 'finish') },
});
```

`replay` is a function over the page `transport.history()` returns: it receives the newest page, reads older ones through `next()` as far as it needs, and returns the deliveries to replay, in any order. The transport sorts them by their message serial, the order history holds them in, so the handler sees channel order and the function does no ordering of its own. `fromSerial` and `untilEvent` build the two usual ones, with `maxPages` to cap the pages read and `onExhausted` to say what happens when the pages run out first. You can write your own for anything else: filter, slice, stop on a header, or read every page.

```typescript
transport.subscribe(handle, {
  history: {
    pageSize: 200,
    replay: async (historyPage) => {
      const deliveries: Delivery<VercelEvent>[] = [];
      let page = historyPage;
      for (;;) {
        deliveries.push(...page.items); // every delivery; the transport sorts them
        if (!page.hasNext) return deliveries;
        page = await page.next();
      }
    },
  },
});
```

`demo/minimal/src/app/chat.tsx` makes this subscribe call inside a component when the page loads, from the serial its server stored with the conversation.

### Tagging a turn

Both `send` and `pipe` take `headers`, a flat map of string, number, boolean or null values that the transport includes in `extras.headers` on every message published by that `send` or `pipe` call. Any headers returned by the codec are preferred to the headers set here, when there is a collision.

You can read the headers from the raw Ably message in the subscribe handler, `message.extras.headers`, or in the `headers` field passed to `decode` in the codec builder.

### AG-UI

The AG-UI codec carries [AG-UI](https://docs.ag-ui.com) events. An agent pipes its event stream, and every client decodes the same events and can merge them with AG-UI's own reducer, such as an `AbstractAgent` from `@ag-ui/client`. A client can start a run by sending the codec's own `run-input` event, which carries a `RunAgentInput`.

```typescript
import { createAGUICodec } from '@ably/ai-transport/ag-ui';

const transport = createTransport({ client: ably, channelName, codec: createAGUICodec() });

// Client: send only the messages this run adds.
await transport.send({ type: 'run-input', input: { threadId, runId, messages: [userMessage], tools, context } });

// Agent: the runId header goes on every message of the run.
await transport.pipe(events, { headers: { runId } });
```

The codec does not support `MESSAGES_SNAPSHOT`, and some events change on the wire:

- The codec does not publish `MESSAGES_SNAPSHOT`, and an inbound one does not decode to an event. A snapshot holds the whole conversation and grows past the Ably message size limit. Your application can load the conversation from its own store, and join the channel at a run boundary.
- `RUN_STARTED` travels with `input.messages` empty, for the same reason. Its other input fields travel as they are.
- `TEXT_MESSAGE_CONTENT`, `TOOL_CALL_ARGS` and `REASONING_MESSAGE_CONTENT` append to one message per stream. History and a client that joins late read one delta event per stream, with the text joined. That event carries the `timestamp` and `metadata` of the last delta only.
- The codec strips `rawEvent` from every event. The field carries the provider event that the AG-UI event was translated from, so it repeats the event's content. AG-UI's reducer does not read it.
- Every `*_CHUNK` event is its own message. A chunk stream does not have an end event, so the codec cannot hold the next message back until Ably has acknowledged the stream's appends. An agent that wants one message per stream in history can emit the START, CONTENT and END events.
- Every other event travels whole. The codec does not check sizes, so a large `STATE_SNAPSHOT`, `ACTIVITY_SNAPSHOT`, `TOOL_CALL_RESULT` or `RUN_FINISHED` fails its publish, and `pipe` rejects.

AG-UI's reducer rejects a stream that does not start with `RUN_STARTED`, and its state deltas patch the state the client already holds. So a client must join at a run boundary, with its messages and state loaded from your store. Your agent should pipe one run at a time to a channel.

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
    if (event !== undefined) merge(event);
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
      body: JSON.stringify({ channelName: 'conversations:abc', message }),
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

`useHistory({ limit })` reads the channel's history one page at a time, `useTransportStatus()` reports the transport's errors, and the channel's own state is ably-js's `useChannelStateListener` under the provider. Nesting providers with distinct channel names holds more than one conversation at once; pass `channelName` to any hook to pick which one it reads.

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
