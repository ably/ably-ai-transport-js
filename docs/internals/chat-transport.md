# Chat transport

The chat transport (`src/vercel/transport/chat-transport.ts`) is a thin adapter that wraps a core [ClientSession](client-session.md) to satisfy the `ChatTransport` interface that Vercel's `useChat()` hook expects. It maps Vercel's `sendMessages()` / `reconnectToStream()` contract to the session's default [view](client-session.md)'s `send()` / `regenerate()` and to per-run cancellation via the `ActiveRun` handle.

The core session is a pure Ably-channel transport — it never sends HTTP. `useChat`'s contract, however, is request-driven: calling `sendMessages` is expected to trigger the backend. So the chat transport is the one place that issues the agent-invocation POST, keeping `useChat` a drop-in transport while the generic core stays HTTP-free.

## Why an adapter

Vercel's `useChat()` manages message state internally. When the user submits a message or requests regeneration, `useChat()` calls `sendMessages()` with the full message array and a `trigger` field. The adapter must:

1. Disambiguate the mode (new message, edit, continuation, regeneration) and determine which messages are new vs history
2. Compute fork metadata for edits and fork-on-unresolved-tool (regeneration's fork metadata is derived by `View.regenerate`)
3. Delegate to the view's `send()` / `regenerate()` to publish on the channel
4. POST the run's invocation pointer to wake the agent
5. Build a per-run `ReadableStream` from the session tree's events and return it so `useChat` can drive status and callbacks

## sendMessages

useChat calls `sendMessages` in several distinct modes. The adapter disambiguates by `(trigger, last-message role)` and whether `messageId` is set, then splits the message array accordingly:

| Mode                                                       | New messages          | History              | Fork metadata                                                                        |
| ---------------------------------------------------------- | --------------------- | -------------------- | ------------------------------------------------------------------------------------ |
| `submit-message`, last is user, no `messageId`             | Last message in array | Everything before it | None (unless fork-on-unresolved-tool, see below)                                     |
| `submit-message`, last is user, `messageId` set (edit)     | Last message in array | Everything before it | `forkOf` = `messageId`'s codec-message-id, `parent` = predecessor's codec-message-id |
| `submit-message`, last is assistant in tree (continuation) | None (empty array)    | Entire array         | None; reuses the assistant's `runId`                                                 |
| `regenerate-message`                                       | None (empty array)    | Entire array         | Derived by `View.regenerate` from the tree, not precomputed here                     |

For **edit** and **fork-on-unresolved-tool**, the adapter looks up the target in the [conversation tree](conversation-tree.md) (via `view.getMessagesWithIds()`) to compute `forkOf` and `parent` using the tree's `codec-message-id` (not the `UIMessage.id`). For **regeneration**, the adapter does NOT precompute fork metadata — it routes the target's codec-message-id through `view.regenerate()`, which derives `forkOf`/`parent` from the tree itself.

A **continuation** (a `submit-message` whose last message is an assistant already in the tree) covers useChat's auto-submit after a tool result and multi-step tool use. It publishes no new message; instead the adapter walks useChat's overlay against the tree and synthesizes the `tool-result` / `tool-result-error` / `tool-approval-response` inputs for any tool parts the user resolved, then sends them via `view.send` reusing the suspended assistant's `runId`.

A **fork-on-unresolved-tool** occurs when the user sends a fresh message while the preceding assistant still holds an unresolved tool call (`input-streaming`, `input-available`, or `approval-requested`). The new message forks off that assistant onto a sibling branch so the dangling tool call never reaches the LLM.

### Waking the agent (the invocation POST)

After `send()` publishes on the channel and returns the `ActiveRun`, the transport POSTs `run.toInvocation().toJSON()` to its configured `api` (default `/api/chat`) to wake the agent. The body is the invocation pointer — `inputEventId` and `sessionName` (the channel name), no `run-id` (run identity lives on the channel) — so the agent rebuilds it with `Invocation.fromJSON` and reads the conversation from the channel; no history is sent. The agent mints the `invocationId` (one per request) and returns it on the response, though this transport's POST is fire-and-forget and does not read it back (it routes outputs by the triggering input's `codec-message-id` over the channel). The POST uses the configured `fetch` and `credentials`.

The POST is fire-and-forget — the response arrives over the Ably channel, not the HTTP response, so awaiting it would needlessly delay the stream return. If the POST fails (non-2xx or network error), the agent never woke, so the transport errors **only** the `useChat`-facing stream with `SessionSendFailed` (which surfaces as `useChat` `status: 'error'`). It does this by failing the wrapped stream; the core session, conversation tree, and other observers are untouched.

### Request customization

The `prepareSendMessagesRequest` hook (optional) lets the app add to the invocation POST. It receives the full context - trigger, history, messages, fork metadata - and returns `{ body, headers }`. The returned `body` is merged into the POST body (the run's invocation identifiers always win) and `headers` are added to the request — use it for auth headers or extra agent metadata. Without the hook, the POST body is just the invocation pointer.

### Stream return

The adapter builds a per-run `ReadableStream<UIMessageChunk>` from the session tree's `output` and `run` events (via `createRunOutputStream`, the Vercel-layer module that owns streaming) and returns it from `sendMessages()`. `useChat` consumes this stream to drive status transitions (`submitted` -> `streaming` -> `ready`), fire callbacks (`onToolCall`, `onData`, `onFinish`), and evaluate `sendAutomaticallyWhen`. The stream closes on a terminal chunk (`finish`/`error`/`abort`) — so a tool-calls `finish` ends the consumer stream and triggers continuation while the core run stays alive — or on a (now always terminal) run-end as a safety net. A run-suspend keeps the core run alive and does not close the consumer stream.

Both `useChat` and `useMessageSync` accumulate messages in parallel: `useChat` builds from the stream, while `useMessageSync` pushes from the session's message store via `setMessages` (a full replacement). The session's version is always authoritative - both accumulators produce identical messages from the same chunks, and `setMessages` overwrites `useChat`'s state on every session event.

Correlation does not rely on the domain `UIMessage.id`. The SDK keys every message on its own client-minted `codec-message-id` (carried on the wire header), and the reconstructed `UIMessage.id` is preserved as-is — an assistant id comes from the stream's `start` chunk `messageId`, a user id from the caller. The two ids are independent: the domain id is surfaced to the app, while the transport routes and reconciles on the separate `codec-message-id`.

### Abort signal

When `useChat()` provides an `abortSignal` (e.g. the user clicks stop), the adapter wires it to `run.cancel()` on the `ActiveRun` returned by the just-issued send and closes that run's per-run stream so `useChat`'s reader ends immediately without waiting for the agent's run-end round-trip. The abort listener closes over the `ActiveRun` returned by `view.send` / `view.regenerate` (whose `runId` resolves once the agent mints it), so each stop fires exactly one cancel scoped to its originating send. (Because `useChat` enables Stop synchronously, the adapter also handles an already-aborted signal — firing the cancel directly rather than via the `abort` listener, which would never fire.)

## reconnectToStream

Returns `null`. The core session's observer mode handles in-progress streams automatically - the channel subscription is established before attach, so on reconnect the [decoder's first-contact](decoder.md#update-handling-first-contact-vs-prefix-match) mechanism reconstructs stream state from the next server append.

## close

Delegates directly to `session.close()`.

## ChatTransportOptions

| Option                       | Type                                                           | Purpose                                                                    |
| ---------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `api`                        | `string?`                                                      | Endpoint the transport POSTs the invocation to. Default `/api/chat`        |
| `credentials`                | `RequestCredentials?`                                          | Fetch credentials mode for the invocation POST                             |
| `fetch`                      | `typeof globalThis.fetch?`                                     | Custom fetch implementation for the invocation POST                        |
| `prepareSendMessagesRequest` | `(context: SendMessagesRequestContext) => { body?, headers? }` | Add body/headers to the invocation POST (invocation identifiers still win) |

The `SendMessagesRequestContext` provides:

| Field       | Type                                       | Description                                                              |
| ----------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| `chatId`    | `string?`                                  | Chat session ID from `useChat()`                                         |
| `trigger`   | `'submit-message' \| 'regenerate-message'` | What triggered the request                                               |
| `messageId` | `string?`                                  | Target message ID for edit or regeneration; undefined for a new message  |
| `history`   | `UIMessage[]`                              | Previous messages (context for the LLM)                                  |
| `messages`  | `UIMessage[]`                              | New messages being sent (empty for regeneration)                         |
| `forkOf`    | `string?`                                  | The codec-message-id of the message being forked (regenerated or edited) |
| `parent`    | `string?`                                  | The codec-message-id of the predecessor in the conversation thread       |

See [Client session](client-session.md) for the core session that this adapter wraps. See [Vercel AI SDK framework guide](../frameworks/vercel-ai-sdk.md) for the integration paths. See [Vercel codec](vercel-codec.md) for how events are encoded/decoded.
