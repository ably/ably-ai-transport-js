# Minimal demo

One Next.js page that streams a chat reply over Ably with `@ably/ai-transport` and the Vercel AI SDK.

The browser publishes the user's message on the channel with `transport.send`, then POSTs the conversation to `/api/chat`. The route runs `streamText` and pipes the AI SDK's chunk stream through a transport on the same channel. Every tab on the channel decodes the chunks with the same codec and folds them with the AI SDK's own `readUIMessageStream`, so the reply streams to all of them at once, and a tab opened mid-reply picks the stream up where it is.

## Run it

```bash
cp .env.local.example .env.local   # add your Ably API key; MOCK_LLM=1 needs no model key
pnpm install
pnpm run dev
```

Open http://localhost:3000, send a message, and watch the reply stream. Open the same URL in a second tab to watch it there too.

## What is in it

- `src/app/api/chat/route.ts` pipes `toUIMessageStream(streamText(...))` through `createTransport` with the `vercel` codec.
- `src/app/api/chat/model.ts` picks the model: the mock when `MOCK_LLM=1`, otherwise Anthropic or OpenAI, whichever key is set.
- `src/app/api/auth/ably-token/route.ts` issues Ably token requests for the browser.
- `src/app/page.tsx` mounts `AblyProvider` and `TransportProvider` for one channel.
- `src/app/chat.tsx` sends the user message, folds the agent's chunks with `readUIMessageStream`, and shows the channel state.
