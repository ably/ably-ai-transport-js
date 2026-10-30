# Minimal demo

One Next.js page that streams a chat reply over Ably with `@ably/ai-transport` and the Vercel AI SDK.

The browser publishes the user's message on the channel with `vercelAdaptor(channel).send`, then POSTs it to `/api/chat`. The route adds it to the conversation the server holds for the channel, runs `streamText` and pipes the AI SDK's chunk stream through `vercelAdaptor` on the same channel. Every tab on the channel passes what it receives to `vercelDecoder` and merges the decoded chunks with the AI SDK's own `readUIMessageStream`, so the reply streams to all of them at once, and a tab opened mid-reply picks the stream up where it is.

The server keeps each channel's conversation in memory. The route records the user's message and an empty placeholder for its reply when the request arrives, with the serial the message's publish returned, and the reply itself once its pipe resolves, with the serial of the reply's last message. Records merge by message id, so the conversation's order is fixed before a reply arrives, two turns in flight at once each keep their place, and a reply cancelled part-way keeps a place the page fills from the channel. A page that loads reads the stored conversation from `/api/messages`, then gets the channel with `rewind` set to the stored serial. On attach the platform delivers everything after that serial, then live messages, in channel order, through one decoder: a refresh shows the whole conversation, and a tab opened mid-reply, the first reply included, picks the stream up where it is. While a reply streams, from its `start` chunk to its `finish`, the header says so and the composer is held; a route whose pipe is cancelled or fails publishes an `abort` chunk so every tab lets go. The store lives for the life of the server process; with nothing stored, the page attaches with no rewind.

## Run it

The demo streams on `ai:*` channels, which need the `mutableMessages` channel rule. A new Ably app comes with that rule on the `ai` namespace, so there is nothing to do. An app made before the rule existed needs it added once, or the first append fails with error `93002` and no tokens reach the page. See [configure channel rules](https://ably.com/docs/ai-transport/getting-started/channel-rules).

```bash
cp .env.local.example .env.local   # add your Ably API key; MOCK_LLM=1 needs no model key
pnpm install
pnpm run dev
```

Open http://localhost:3000, send a message, and watch the reply stream. Open the same URL in a second tab to watch it there too.

## What is in it

- `src/app/api/chat/route.ts` pipes `toUIMessageStream(streamText(...))` through `vercelAdaptor`, then records the reply and the pipe's serial.
- `src/app/api/chat/model.ts` picks the model: the mock when `MOCK_LLM=1`, otherwise Anthropic or OpenAI, whichever key is set.
- `src/app/api/store.ts` is the in-memory store, one conversation per channel.
- `src/app/api/messages/route.ts` returns a channel's stored conversation and serial.
- `src/app/api/auth/ably-token/route.ts` issues Ably token requests for the browser.
- `src/app/page.tsx` reads the stored conversation, then mounts `AblyProvider` and a `ChannelProvider` that rewinds the channel to the stored serial.
- `src/app/chat.tsx` subscribes a `vercelDecoder` to the rewound channel, sends the user message through `vercelAdaptor` and its serial to the route, merges the agent's chunks with `readUIMessageStream`, and shows the channel state.
