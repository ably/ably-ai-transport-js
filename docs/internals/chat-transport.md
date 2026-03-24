# Chat transport

The chat transport (`src/vercel/transport/chat-transport.ts`) is a thin adapter that wraps a core [ClientTransport](client-transport.md) to satisfy the `ChatTransport` interface that Vercel's `useChat` hook expects. The real logic lives in the core transport — this adapter maps Vercel's `sendMessages` / `reconnectToStream` contract to the core transport's `send()` and `cancel()`.

## Why an adapter

Vercel's `useChat` manages message state internally. When the user submits a message or requests regeneration, `useChat` calls `sendMessages` with the full message array and a `trigger` field. The adapter must:

1. Determine which messages are new vs history
2. Compute fork metadata for regeneration
3. Delegate to the core transport's `send()`
4. Return a stream that signals completion without duplicating state

## sendMessages

The adapter splits the message array based on `trigger`:

| Trigger | New messages | History | Fork metadata |
|---|---|---|---|
| `submit-message` | Last message in array | Everything before it | None |
| `regenerate-message` | None (empty array) | Entire array | `forkOf` = messageId, `parent` = tree parent of that message |

For regeneration, the adapter looks up the target message in the [conversation tree](conversation-tree.md) to compute the correct `forkOf` and `parent` values using the tree's `x-ably-msg-id` (not the `UIMessage.id`).

### Request customization

The `prepareSendMessagesRequest` hook (optional) lets the server app customize the POST body and headers. It receives the full context — trigger, history, messages, fork metadata — and returns `{ body, headers }`.

Without the hook, the adapter builds a default body with `history` (including per-message Ably headers), `id`, `trigger`, and fork metadata fields.

### Empty stream return

The adapter returns an **empty stream** that closes when the turn ends — not the real event stream. This is intentional: `useChat` consumes the returned stream to accumulate the assistant message, but `useMessageSync` (the companion React hook) already pushes the transport's authoritative message state into `useChat` via `setMessages`. Returning the real event stream would cause `useChat` to accumulate a duplicate assistant message.

The empty stream is created via a `TransformStream` whose writable side closes when the turn's real stream finishes.

### Abort signal

When `useChat` provides an `abortSignal` (e.g. the user clicks stop), the adapter wires it to `transport.cancel({ all: true })`. In multi-user scenarios, `cancel({ all: true })` is used rather than per-turnId cancel because any client should be able to stop any active stream.

## reconnectToStream

Returns `null`. The core transport's observer mode handles in-progress streams automatically — the channel subscription is established before attach, so on reconnect the [decoder's first-contact](decoder.md#first-contact) mechanism reconstructs stream state from the next server append.

## close

Delegates directly to `transport.close(options)`.

## ChatTransportOptions

| Option | Type | Purpose |
|---|---|---|
| `prepareSendMessagesRequest` | `(context: SendMessagesRequestContext) => { body?, headers? }` | Customize the HTTP POST body and headers before sending |

The `SendMessagesRequestContext` provides:

| Field | Type | Description |
|---|---|---|
| `id` | `string?` | Chat session ID from `useChat` |
| `trigger` | `'submit-message' \| 'regenerate-message'` | What triggered the request |
| `messageId` | `string?` | Target message ID for regeneration |
| `history` | `UIMessage[]` | Previous messages (context for the LLM) |
| `messages` | `UIMessage[]` | New messages being sent (empty for regeneration) |
| `forkOf` | `string?` | The msg-id of the message being forked |
| `parent` | `string \| null?` | The msg-id of the predecessor in the thread |

See [Client transport](client-transport.md) for the core transport that this adapter wraps. See [Vercel AI SDK framework guide](../frameworks/vercel-ai-sdk.md) for the integration paths. See [Vercel codec](vercel-codec.md) for how events are encoded/decoded.
