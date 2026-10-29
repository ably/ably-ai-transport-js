![Ably AI Transport Header](/images/JavaScriptSDK-AITransport-github.png)
[![npm version](https://img.shields.io/npm/v/@ably/ai-transport.svg?style=flat)](https://www.npmjs.com/package/@ably/ai-transport)
[![License](https://img.shields.io/github/license/ably/ably-ai-transport-js.svg)](https://github.com/ably/ably-ai-transport-js/blob/main/LICENSE)

# Ably AI Transport JavaScript SDK

Ably AI Transport carries an AI agent's output over an Ably channel. Your agent pipes LLM output to clients over Ably messages, and every client on the channel receives each event as it is produced, in realtime. A client that reconnects picks up where it left off, and a conversation is available on all the user's devices.

Your application holds the channel through the Ably Pub/Sub SDK. On the agent, an adaptor publishes an LLM's events onto that channel. In the client, a decoder turns each message the channel delivers, live or from history, back into the same events. Your application merges the event stream into its own messages. The SDK includes an adaptor and a decoder for the Vercel AI SDK, the OpenAI Responses API and AG-UI, and you can define your own format with the `defineCodec` builder. Everything is built on [Ably](https://ably.com/) channels, so ordering, persistence, history, and presence come from the platform rather than from your application code.

> [!NOTE]
> This SDK is pre-release (`0.x`). The public API is still changing and minor versions can carry breaking changes. [CHANGELOG.md](./CHANGELOG.md) records what moved in each release, and the [0.10.0 to 0.11.0 migration guide](./docs/migrations/0.10.0-to-0.11.0.md) walks through the move from the transport to adaptors and decoders.

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
| Vercel AI SDK | Versions 6 and 7, through `@ably/ai-transport/vercel`.                                    |
| OpenAI        | The Responses API, through `@ably/ai-transport/openai`.                                   |
| AG-UI         | Version 1 events, through `@ably/ai-transport/ag-ui`.                                     |

The Ably Pub/Sub SDK (`ably`) version 2.23.0 or newer is required in every case. `ai`, `openai` and `@ag-ui/core` are optional peer dependencies, each needed only by the entry point that uses it.

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

AI Transport streams a response by appending tokens to a single Ably message, which requires the `mutableMessages` channel rule on the namespace your conversations live in. This is a one-time setup per Ably app: without it the first append fails with error `93002` and no tokens reach the client. See [configure channel rules](https://ably.com/docs/ai-transport/getting-started/channel-rules).

---

## Usage

The following code streams a model response from a Next.js route handler onto an Ably channel, then reads it back on a client. The SDK carries the events; your application decides what to do with them and owns the conversation. `demo/minimal` in this repository is the same app in full, with the authentication endpoint.

### Agent

```typescript
import { streamText, convertToModelMessages, toUIMessageStream, type UIMessage } from 'ai';
import { openai } from '@ai-sdk/openai';
import * as Ably from 'ably';
import { ErrorCode } from '@ably/ai-transport';
import { vercelAdaptor } from '@ably/ai-transport/vercel';

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

  // You get the channel from your own client; the adaptor publishes on it.
  const adaptor = vercelAdaptor(ably.channels.get(channelName));

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
    await adaptor.pipe(toUIMessageStream({ stream: result.fullStream }), {
      signal: req.signal,
      headers: { requestId: message.id },
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    const cancelled = error instanceof Ably.ErrorInfo && error.code === ErrorCode.OperationCancelled;
    return new Response(null, { status: cancelled ? 204 : 500 });
  }
}
```

`pipe` runs unattended. `pipeEach` writes the same stream and hands each event back once it is written, with the serial of the message it landed on, so the agent can act inside the loop. The adaptor reads the next event only when the loop body has finished.

```typescript
for await (const { event, serial } of adaptor.pipeEach(stream, { signal })) {
  if (event.type === 'finish') await db.saveReplySerial(serial);
  heartbeat();
}
```

When the source ends, or the pipe itself fails, `pipeEach` flushes the stream's appends and repairs any that failed before the loop finishes or the failure is thrown. A `break`, a `return`, a throw in the loop body, or the signal stops it where it is. Nothing more is written, nothing is repaired, and no stream is ended, so a client sees a stream that was cut off stay open. Stopping early does not stop the source either: a `ReadableStream` is released, not cancelled, so abort the model call with the same signal if it should stop too.

### Client

The client subscribes to the channel through ably-js and passes every message to a decoder. The decoder gives each message back as deliveries holding the decoded event, and the application merges the events into whatever it renders from.

```typescript
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import * as Ably from 'ably';
import { vercelAdaptor, vercelDecoder } from '@ably/ai-transport/vercel';

const ably = new Ably.Realtime({ authUrl: '/api/auth/token' });
const channelName = 'conversations:abc';
const channel = ably.channels.get(channelName);

// One decoder per channel, for live delivery and history together. Every
// message comes back as a delivery: `event` is undefined for a message that
// is not the codec's, such as your application's own messages on the channel.
// Nothing here assembles a message list, that is yours. Here the AI SDK's own
// reducer merges one reply: `start` opens a stream, and every chunk until
// `finish` goes into it.
const decoder = vercelDecoder();
let reply: ReadableStreamDefaultController<UIMessageChunk> | undefined;
decoder.onEvent(({ event }) => {
  if (event === undefined || event.type === 'user-message') return;
  if (event.type === 'start') {
    const stream = new ReadableStream<UIMessageChunk>({ start: (c) => (reply = c) });
    void merge(stream);
  }
  reply?.enqueue(event);
  if (event.type === 'finish') reply?.close();
});
decoder.onError((error) => console.error(error));
await channel.subscribe(decoder.receive);

async function merge(stream: ReadableStream<UIMessageChunk>) {
  for await (const message of readUIMessageStream({ stream })) render(message);
}

// Publish the turn on the channel, then wake the agent with the same message.
// Your own message comes back as an ordinary delivery under the serial send
// returns; the agent hydrates the rest of the conversation from its store.
const message: UIMessage = { id: 'm1', role: 'user', parts: [{ type: 'text', text: "what's the weather?" }] };
const { serial } = await vercelAdaptor(channel).send(
  { type: 'user-message', message },
  { headers: { requestId: message.id } },
);
await fetch('/api/chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ channelName, message }),
});
```

`channel.unsubscribe(decoder.receive)` stops the subscription, since `receive` is bound to the decoder.

### Catching up from history

This section's listener replaces `channel.subscribe(decoder.receive)` from the client example: do not use both. Each subscribes its own listener, so with both every live message goes through the decoder twice, and a `start`, `finish` or `user-message` comes out twice, since the decoder drops a repeat only for a stream's message.

A client can join what its database holds with the channel, by reading history back to the last position it stored. Pass history messages to the same decoder with `decode`, which returns the deliveries without emitting them. History pages arrive newest first, and the decoder is built to take them in that order; reverse what it returns to apply it oldest first.

```typescript
import type { Delivery } from '@ably/ai-transport';
import type { VercelEvent } from '@ably/ai-transport/vercel';

const held: Delivery<VercelEvent>[] = [];
let live = false;
await channel.subscribe((message) => {
  const deliveries = decoder.decode(message);
  if (live) deliveries.forEach(apply);
  else held.push(...deliveries);
});

// Read back from the attach point to the serial your store holds, the one a
// publish ack returned.
const newer: Ably.InboundMessage[] = [];
let page: Ably.PaginatedResult<Ably.InboundMessage> | null = await channel.history({ untilAttach: true });
while (page) {
  newer.push(...page.items.filter((m) => (m.serial ?? '') > stored.serial));
  if (page.items.some((m) => (m.serial ?? '') <= stored.serial) || !page.hasNext()) break;
  page = await page.next();
}

// History first, oldest first, then what arrived live meanwhile.
newer
  .map((m) => decoder.decode(m))
  .toReversed()
  .flat()
  .forEach(apply);
held.forEach(apply);
live = true;
```

Live messages go through the decoder as they arrive, before history does, so the decoder drops history's copy of a message that live delivery already gave it. `demo/minimal/src/app/chat.tsx` does this when the page loads, from the serial its server stored with the conversation.

Two limits apply. If history returns a stream that was still in flight at a later version than the first live update the decoder held, history's text for that stream is applied before the update's, out of order. And `untilAttach` stops history at the point the channel attached, so a component that remounts on a channel that is still attached misses what arrived between that attach and its new subscription.

### Tagging a turn

`send`, `pipe` and `pipeEach` take `headers`, a flat map of string, number, boolean or null values that the adaptor includes in `extras.headers` on every message the call publishes. An adaptor can carry default headers as well, `vercelAdaptor(channel, { headers })`. A call's headers win over the defaults, and any headers the codec writes win over both.

You can read the headers from the raw Ably message in a delivery, `message.extras.headers`, or in the `headers` field passed to `decode` in the codec builder.

### AG-UI

`agUiAdaptor` and `agUiDecoder` carry [AG-UI](https://docs.ag-ui.com) events. An agent pipes its event stream, and every client decodes the same events and can merge them with AG-UI's own reducer, such as an `AbstractAgent` from `@ag-ui/client`. A client can start a run by sending the codec's own `run-input` event, which carries a `RunAgentInput`.

```typescript
import { agUiAdaptor, agUiDecoder } from '@ably/ai-transport/ag-ui';

const adaptor = agUiAdaptor(channel);

// Client: send only the messages this run adds.
await adaptor.send({ type: 'run-input', input: { threadId, runId, messages: [userMessage], tools, context } });

// Agent: the runId header goes on every message of the run.
await adaptor.pipe(events, { headers: { runId } });

// Client: decode what the channel delivers.
const decoder = agUiDecoder();
await channel.subscribe(decoder.receive);
```

The codec does not support `MESSAGES_SNAPSHOT`, and some events change on the wire:

- The codec does not publish `MESSAGES_SNAPSHOT`, and an inbound one does not decode to an event. A snapshot holds the whole conversation and grows past the Ably message size limit. Your application can load the conversation from its own store, and join the channel at a run boundary.
- `RUN_STARTED` travels with `input.messages` empty, for the same reason. Its other input fields travel as they are.
- `TEXT_MESSAGE_CONTENT`, `TOOL_CALL_ARGS` and `REASONING_MESSAGE_CONTENT` append to one message per stream. History and a client that joins late read one delta event per stream, with the text joined. That event carries the `timestamp` and `metadata` of the last delta only.
- The codec strips `rawEvent` from every event. The field carries the provider event that the AG-UI event was translated from, so it repeats the event's content. AG-UI's reducer does not read it.
- Every `*_CHUNK` event is its own message. A chunk stream does not have an end event, so the adaptor cannot hold the next message back until Ably has acknowledged the stream's appends. An agent that wants one message per stream in history can emit the START, CONTENT and END events.
- Every other event travels whole. The codec does not check sizes, so a large `STATE_SNAPSHOT`, `ACTIVITY_SNAPSHOT`, `TOOL_CALL_RESULT` or `RUN_FINISHED` fails its publish, and `pipe` rejects.

AG-UI's reducer rejects a stream that does not start with `RUN_STARTED`, and its state deltas patch the state the client already holds. So a client must join at a run boundary, with its messages and state loaded from your store. Your agent should pipe one run at a time to a channel.

### Your own format

`defineCodec` builds a codec from one row per event type, and `createAgentAdaptor` and `createDecoder` wrap it the way the provider factories wrap theirs.

```typescript
import { createAgentAdaptor, createDecoder, defineCodec } from '@ably/ai-transport';

const codec = defineCodec({
  id: 'my-format',
  typeOf: (e: MyEvent) => e.type,
  events: {
    /* one { encode, decode } row per event type */
  },
});
const adaptor = createAgentAdaptor(channel, codec);
const decoder = createDecoder(codec);
```

Every message a codec encodes carries the codec's `name`, `ai` unless you pass `name` to `defineCodec`, and its `id`, and a decoder skips a message with another name or another codec's id. Two formats can share a channel when their ids differ. A hand-written codec must write both itself.

### React

The SDK has no React entry point. Mount ably-js's own `<AblyProvider>` and `<ChannelProvider>`, get the channel from the client, and subscribe a decoder in an effect, as `demo/minimal/src/app/chat.tsx` does. Create the decoder inside the effect, one per run: an effect can run again, under Fast Refresh for example, and a decoder kept across runs drops text it has already seen.

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
