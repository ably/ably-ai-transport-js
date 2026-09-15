# Minimal demo

One Next.js page that streams a chat reply over Ably with `@ably/ai-transport` and the Vercel AI SDK.

The browser publishes the user's message on the channel with `transport.send`, then POSTs it to `/api/chat`. The route adds it to the conversation the server holds for the channel, runs `streamText` and pipes the AI SDK's chunk stream through a transport on the same channel. Every tab on the channel decodes the chunks with the same codec and merges them with the AI SDK's own `readUIMessageStream`, so the reply streams to all of them at once, and a tab opened mid-reply picks the stream up where it is.

The server keeps each channel's conversation in memory. The route records the user's message and an empty placeholder for its reply when the request arrives, and the reply itself once its pipe resolves, with the serial of the reply's last message. Records merge by message id, so the conversation's order is fixed before a reply lands, two turns in flight at once each keep their place, and a reply cancelled part-way keeps a place the page fills from channel history. A page that loads reads the stored conversation from `/api/messages`, pages channel history back to that serial, applies what landed after it, and then lets live deliveries through, so a refresh shows the whole conversation and a reply in flight carries on where it is. While a reply streams, from its `start` chunk to its `finish`, the header says so and the composer is held; a route whose pipe is cancelled publishes an `abort` chunk so every tab lets go. The store lives for the life of the server process; with nothing stored, the page reads the whole channel from history.

## Run it

The demo streams on `ai:*` channels, which need the `mutableMessages` channel rule. A new Ably app comes with that rule on the `ai` namespace, so there is nothing to do. An app made before the rule existed needs it added once, or the first append fails with error `93002` and no tokens reach the page. See [configure channel rules](https://ably.com/docs/ai-transport/getting-started/channel-rules).

```bash
cp .env.local.example .env.local   # add your Ably API key; MOCK_LLM=1 needs no model key
pnpm install
pnpm run dev
```

Open http://localhost:3000, send a message, and watch the reply stream. Open the same URL in a second tab to watch it there too.

## What is in it

- `src/app/api/chat/route.ts` pipes `toUIMessageStream(streamText(...))` through `createTransport` with the `vercel` codec, then records the reply and the pipe's serial.
- `src/app/api/chat/model.ts` picks the model: the mock when `MOCK_LLM=1`, otherwise Anthropic or OpenAI, whichever key is set.
- `src/app/api/store.ts` is the in-memory store, one conversation per channel.
- `src/app/api/messages/route.ts` returns a channel's stored conversation and serial.
- `src/app/api/auth/ably-token/route.ts` issues Ably token requests for the browser.
- `src/app/page.tsx` mounts `AblyProvider` and `TransportProvider` for one channel.
- `src/app/chat.tsx` loads the stored conversation and catches up from its serial through history, sends the user message, merges the agent's chunks with `readUIMessageStream`, and shows the channel state.
