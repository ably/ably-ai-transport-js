# Anthropic demo

One Next.js page that streams Claude's replies over Ably with `@ably/ai-transport` and the Anthropic SDK's Messages API, with extended thinking, web search and a tool the user approves.

The browser publishes the user's message on the channel with `anthropicAdaptor(channel).send`, as the codec's `input` event, then POSTs its text and the publish's serial to `/api/chat`. The route builds the message from that text, adds it to the conversation the server holds for the channel, calls `client.messages.stream` and pipes the stream through `anthropicAdaptor` on the same channel. Every tab on the channel passes what it receives to `anthropicDecoder` and builds each Message with the SDK's own `MessageStream.fromReadableStream`, so the reply streams to all of them at once, and a tab opened mid-reply picks the stream up where it is.

Claude runs `web_search` on Anthropic's side; a reply that stops for the server tool's loop limit (`pause_turn`) is continued by the route with another request. `get_weather` is the app's own tool, and the route runs it once the user approves: a reply that calls it ends the turn, the page shows the call with Approve and Deny, and once every call has an answer the page POSTs the answers to `/api/chat`. The route runs each approved call, publishes the results on the channel as one `tool_result` message, and continues the turn. A denied call goes back as an error result, so Claude knows it did not run. The browser sends only the decisions, so it never sets a tool's arguments or its result.

The server keeps each channel's conversation in memory, as the Messages API's own `MessageParam`s, so the route hands it to the model as it is. Each input is stored with the serial its publish returned. Each reply is stored as `{ role: 'assistant', content }` from `stream.finalMessage()`, with its thinking signatures and search results intact, and with the serial of the last message its pipe published. A page that loads reads the stored conversation from `/api/messages`, then gets the channel with `rewind` set to the stored serial. On attach the platform delivers everything after that serial, then live messages, in channel order, through one decoder. When the channel loses continuity, the page reads the store again and rewinds from the newer serial. With nothing stored, the page attaches with no rewind.

## Run it

The demo streams on `ai:*` channels, which need the `mutableMessages` channel rule. A new Ably app comes with that rule on the `ai` namespace, so there is nothing to do. An app made before the rule existed needs it added once, or the first append fails with error `93002` and no tokens reach the page. See [configure channel rules](https://ably.com/docs/ai-transport/getting-started/channel-rules).

```bash
cp .env.local.example .env.local   # add your Ably and Anthropic API keys
pnpm install
pnpm run dev
```

Open http://localhost:3000 and ask about the weather in a city, or about anything recent enough to need a search. Open the same URL in a second tab to watch the reply there too.

## What is in it

- `src/app/api/chat/route.ts` records the input with its serial, pipes `client.messages.stream(...)` through `anthropicAdaptor`, and records each reply with the pipe's serial.
- `src/app/api/chat/tools.ts` declares the tools Claude may call, runs `get_weather`, and turns the user's answers into the `tool_result` blocks.
- `src/app/api/store.ts` is the in-memory store, one conversation per channel.
- `src/app/api/messages/route.ts` returns a channel's stored conversation and serial.
- `src/app/api/auth/ably-token/route.ts` issues Ably token requests for the browser.
- `src/app/page.tsx` reads the stored conversation, then mounts `PubSubClientProvider` and a `ChannelProvider` that rewinds the channel to the stored serial. When the channel loses continuity, it detaches the channel, reads the store again and remounts the chat on the newer serial.
- `src/chat/` is the page's chat, and `index.ts` exports its one component, `Chat`:
  - `use-conversation.ts` subscribes an `anthropicDecoder` to the rewound channel, builds each Message with `MessageStream.fromReadableStream`, and sends the user's input through `anthropicAdaptor`.
  - `use-tool-approval.ts` asks the user to approve each `get_weather` call and sends the answers to the route together.
  - `blocks.tsx` renders one content block: text with its citations, thinking, tool calls and their results.
  - `chat.tsx` puts the conversation, the approvals and the composer on the page.
  - `lib.ts` holds the page's types and the helpers the hooks share.
