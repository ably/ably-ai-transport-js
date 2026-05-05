# Chat transport

The chat transport (`src/vercel/transport/chat-transport.ts`) is a thin adapter that wraps a core [ClientSession](client-session.md) to satisfy the `ChatTransport` interface that Vercel's `useChat()` hook expects. The real logic lives in the core session - this adapter maps Vercel's `sendMessages()` / `reconnectToStream()` contract to the session's default [view](client-session.md)'s `send()` and the session's `cancel()`.

## Why an adapter

Vercel's `useChat()` manages message state internally. When the user submits a message or requests regeneration, `useChat()` calls `sendMessages()` with the full message array and a `trigger` field. The adapter must:

1. Determine which messages are new vs history
2. Compute fork metadata for regeneration
3. Delegate to the core session's `send()`
4. Return the run stream so `useChat` can drive status and callbacks

## sendMessages

The adapter splits the message array based on `trigger`:

| Trigger              | New messages          | History              | Fork metadata                                                |
| -------------------- | --------------------- | -------------------- | ------------------------------------------------------------ |
| `submit-message`     | Last message in array | Everything before it | None                                                         |
| `regenerate-message` | None (empty array)    | Entire array         | `forkOf` = messageId, `parent` = tree parent of that message |

For regeneration, the adapter looks up the target message in the [conversation tree](conversation-tree.md) to compute the correct `forkOf` and `parent` values using the tree's `x-ably-msg-id` (not the `UIMessage.id`).

### Request customization

The `prepareSendMessagesRequest` hook (optional) lets the server app customize the POST body and headers. It receives the full context - trigger, history, messages, fork metadata - and returns `{ body, headers }`.

Without the hook, the adapter builds a default body with `history` (including per-message Ably headers), `chatId`, `trigger`, and fork metadata fields.

### Real stream return

The adapter returns the real run stream from `sendMessages()`. `useChat` consumes this stream to drive status transitions (`submitted` -> `streaming` -> `ready`), fire callbacks (`onToolCall`, `onData`, `onFinish`), and evaluate `sendAutomaticallyWhen`.

Both `useChat` and `useMessageSync` accumulate messages in parallel: `useChat` builds from the stream, while `useMessageSync` pushes from the transport's message store via `setMessages` (a full replacement). The transport's version is always authoritative - both accumulators produce identical messages from the same chunks, and `setMessages` overwrites `useChat`'s state on every transport event.

The server encoder ensures `messageId` alignment by stamping the transport-assigned `x-ably-msg-id` as a fallback domain `messageId` on the `start` chunk. This ensures both accumulators assign the same message ID.

### Abort signal

When `useChat()` provides an `abortSignal` (e.g. the user clicks stop), the adapter wires it to `session.cancel({ all: true })`. In multi-user scenarios, `cancel({ all: true })` is used rather than per-runId cancel because any client should be able to stop any active stream.

## reconnectToStream

Returns `null`. The core session's observer mode handles in-progress streams automatically - the channel subscription is established before attach, so on reconnect the [decoder's first-contact](decoder.md#first-contact) mechanism reconstructs stream state from the next server append.

## close

Delegates directly to `session.close(options)`.

## ChatTransportOptions

| Option                       | Type                                                           | Purpose                                                 |
| ---------------------------- | -------------------------------------------------------------- | ------------------------------------------------------- |
| `prepareSendMessagesRequest` | `(context: SendMessagesRequestContext) => { body?, headers? }` | Customize the HTTP POST body and headers before sending |

The `SendMessagesRequestContext` provides:

| Field       | Type                                       | Description                                      |
| ----------- | ------------------------------------------ | ------------------------------------------------ |
| `chatId`    | `string?`                                  | Chat session ID from `useChat()`                 |
| `trigger`   | `'submit-message' \| 'regenerate-message'` | What triggered the request                       |
| `messageId` | `string?`                                  | Target message ID for regeneration               |
| `history`   | `UIMessage[]`                              | Previous messages (context for the LLM)          |
| `messages`  | `UIMessage[]`                              | New messages being sent (empty for regeneration) |
| `forkOf`    | `string?`                                  | The message ID of the message being forked       |
| `parent`    | `string \| null?`                          | The message ID of the predecessor in the thread  |

See [Client session](client-session.md) for the core session that this adapter wraps. See [Vercel AI SDK framework guide](../frameworks/vercel-ai-sdk.md) for the integration paths. See [Vercel codec](vercel-codec.md) for how events are encoded/decoded.
