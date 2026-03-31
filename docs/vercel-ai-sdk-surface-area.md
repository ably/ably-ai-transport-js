# Vercel AI SDK v6 Surface Area Coverage

## Task

This document records the findings of an audit of the Vercel AI SDK v6 surface
area against the `@ably/ai-transport` integration, carried out as part of Jira
issue AIT-591 ("AI SDK Surface Area Coverage").

The original issue description (authored by Claude, take with a pinch of salt):

> - [ ] Audit Vercel AI SDK v6 surface: Enumerate all useChat options,
>   ChatTransport methods, and UIMessage features. Identify gaps in our
>   integration.
> - [ ] Tool call lifecycle: Verify full tool call flow — tool-call, tool-result,
>   multi-step — works correctly through the transport.
> - [ ] Attachments / file upload: Determine if/how file attachments pass through
>   the transport.
> - [ ] Middleware compatibility: Verify transport works with AI SDK middleware
>   (rate limiting, caching, etc.).
> - [ ] Generative UI / data parts: Verify data-\* UI parts roundtrip correctly
>   through encode/decode.
> - [ ] Error recovery in useChat: Verify useChat error/retry behavior works
>   correctly with our transport.

The investigation considers three use cases:

1. **Headless** — no AI SDK usage on the frontend; backend uses
   `ServerTransport` with `UIMessageCodec`.
2. **Our React hooks** — React frontend with `useClientTransport`, `useSend`,
   etc.; backend uses `ServerTransport` with `UIMessageCodec`.
3. **Vercel `useChat`** — React frontend with Vercel's `useChat` hook, using
   `ChatTransport` adapter + `useMessageSync`; backend uses `ServerTransport`
   with `UIMessageCodec`.

### Other AI SDK Capabilities Considered

The AI SDK v6 includes several capabilities beyond `streamText` + `useChat`.
These were assessed for whether they need a durable transport story:

| Capability | Streaming? | Uses ChatTransport? | Long-running? | Durable transport value |
| --- | --- | --- | --- | --- |
| `streamText` + `useChat` | Yes | Yes | Yes | **Critical** — this is our core use case |
| `streamObject` + `useObject` | Yes (partial objects) | No — different transport | Yes | **High** — but uses a different transport interface; not ChatTransport |
| `useCompletion` | Yes (text deltas) | No — simpler HTTP streaming | Yes | Medium — simpler state model, no conversation history |
| `generateText` | No | No | No | Very low — single request/response |
| `generateImage` | No | No | Yes (10–60s) | Low — long-running but no streaming; better served by async job queue |
| `generateVideo` (experimental) | No | No | Yes (30–120s+) | Low — same as image |
| `transcribe` (experimental) | No | No | Depends on audio length | Low |
| `generateSpeech` (experimental) | No | No | No (1–10s) | Very low |
| `embed` / `embedMany` | No | No | No | Very low |

**Conclusion:** The three use cases listed above are the right ones for this
audit. `streamText` + `useChat`/`ChatTransport` is the only AI SDK feature that
uses the `ChatTransport` interface we implement. The non-streaming capabilities
(`generateText`, `generateImage`, `embed`, etc.) are single request/response
operations that don't benefit from durable streaming.

`streamObject` + `useObject` is the most plausible future integration point — it
streams partial objects over a different transport interface and would benefit
from Ably's resumability. However, it uses a separate hook (`useObject`), a
separate transport contract, and a different chunk format, so it is out of scope
for this audit. Similarly, `useCompletion` streams text but uses a simpler
transport without message history. Both could be future work items if there is
customer demand.

These map to the library's entry points as follows:

| Use case | Client entry points | Server entry point |
| --- | --- | --- |
| 1. Headless | `@ably/ai-transport` (core only) | `@ably/ai-transport/vercel` |
| 2. Our React hooks | `@ably/ai-transport/react` + `@ably/ai-transport/vercel` | `@ably/ai-transport/vercel` |
| 3. Vercel `useChat` | `@ably/ai-transport/vercel/react` + `@ably/ai-transport/vercel` | `@ably/ai-transport/vercel` |

The server side is identical across all three — `createServerTransport()` from
the Vercel entry point uses `UIMessageCodec` to encode `UIMessageChunk` streams
onto an Ably channel.

The client side differs in how messages are consumed. Use case 3 adds the
`ChatTransport` adapter layer, which maps between `useChat`'s
`sendMessages`/`reconnectToStream` contract and our core transport's
`send`/`regenerate`/`edit` API.

## Sources

The AI SDK surface area was assessed using the following sources:

- **Bundled AI SDK docs** at `node_modules/ai/docs/` (AI SDK v6.0.137), searched
  via the `ai-sdk` Claude Code skill which reads from these docs and the AI SDK
  source.
- **AI SDK source code** at `node_modules/ai/src/`, read directly to verify
  interface definitions and behaviour.
- **Key source files consulted:**
  - `ai/src/ui/chat-transport.ts` — `ChatTransport` interface
  - `ai/src/ui/chat.ts` — `useChat` / `AbstractChat` implementation
  - `ai/src/ui/ui-messages.ts` — `UIMessage`, `UIMessagePart`, all part type
    definitions
  - `ai/src/ui-message-stream/ui-message-chunks.ts` — `UIMessageChunk`
    streaming variants
  - `ai/src/generate-text/stream-text.ts` — `toUIMessageStream()`
    implementation
  - `ai/src/ui/default-chat-transport.ts`,
    `ai/src/ui/http-chat-transport.ts` — built-in transport implementations
  - `ai/src/middleware/` and `ai/src/types/language-model-middleware.ts` —
    middleware system
  - `ai/src/generate-text/execute-tool-call.ts`,
    `ai/src/generate-text/run-tools-transformation.ts` — tool execution
- **Cross-referenced** against the `@ably/ai-transport` codebase: all source
  files in `src/vercel/`, all test files in `test/vercel/`, both demo apps in
  `demo/vercel/react/`, and the project rules in `.claude/rules/AISDK.md`.

---

## Server-Side Surface Area: UIMessageChunk Types

These are the chunk types that `toUIMessageStream()` can emit. Every one of
these must be correctly encoded by the server transport, transmitted over Ably,
decoded by the client, and accumulated into `UIMessage` objects.

### Message Lifecycle

| Chunk type | Codec handles? | Unit tested? | Integration tested? |
| --- | --- | --- | --- |
| `start` | Yes | Yes | Yes |
| `finish` | Yes | Yes | Yes |
| `abort` | Yes | Yes | Yes |
| `error` | Yes | Yes | Yes |
| `message-metadata` | Yes | Yes | No |
| `start-step` | Yes | Yes | No |
| `finish-step` | Yes | Yes | No |

### Text Streaming

| Chunk type | Codec handles? | Unit tested? | Integration tested? |
| --- | --- | --- | --- |
| `text-start` | Yes | Yes | Yes |
| `text-delta` | Yes | Yes | Yes |
| `text-end` | Yes | Yes | Yes |

### Reasoning

| Chunk type | Codec handles? | Unit tested? | Integration tested? |
| --- | --- | --- | --- |
| `reasoning-start` | Yes | Yes | Yes |
| `reasoning-delta` | Yes | Yes | Yes |
| `reasoning-end` | Yes | Yes | Yes |

### Tool Input (Streaming)

| Chunk type | Codec handles? | Unit tested? | Integration tested? |
| --- | --- | --- | --- |
| `tool-input-start` | Yes | Yes | Yes |
| `tool-input-delta` | Yes | Yes | Yes |
| `tool-input-available` | Yes | Yes | Yes |
| `tool-input-error` | Yes | Yes | No |

### Tool Output

| Chunk type | Codec handles? | Unit tested? | Integration tested? |
| --- | --- | --- | --- |
| `tool-output-available` | Yes | Yes | Yes |
| `tool-output-error` | Yes | Yes | No |
| `tool-approval-request` | Yes | Yes | No |
| `tool-output-denied` | Yes | Yes | No |

### Content Parts

| Chunk type | Codec handles? | Unit tested? | Integration tested? |
| --- | --- | --- | --- |
| `file` | Yes | Yes | No |
| `source-url` | Yes | Yes | No |
| `source-document` | Yes | Yes | No |
| `data-*` (custom) | Yes | Yes | No |

### Summary

The codec has **complete coverage of all UIMessageChunk types**. Every chunk type
that `toUIMessageStream()` can emit is handled by the encoder, decoder, and
accumulator. All types have unit tests. Integration test coverage exists for the
core streaming paths (text, reasoning, tool input/output, lifecycle) but not for
content parts, data parts, or error-path tool chunks.

---

## Client-Side Surface Area: useChat Features

These features are provided by Vercel's `useChat` hook. The "Relevant?" column
indicates whether the feature interacts with the transport layer (and therefore
with us).

### State & Core Functions

| Feature | Relevant to transport? | Works? | Tested? |
| --- | --- | --- | --- |
| `messages` state | No — derived from stream by useChat, but overridden by `useMessageSync` | — | — |
| `status` states (`submitted` / `streaming` / `ready` / `error`) | No — derived from stream state by useChat internally | — | — |
| `error` state | No — local state | — | — |
| `id` (chat ID) | Passed to `sendMessages` — included in POST body | Yes | Yes |
| `setMessages` | No — local state only | — | — |
| `clearError` | No — local state only | — | — |

### Sending Messages

| Feature | Relevant to transport? | Works? | Tested? |
| --- | --- | --- | --- |
| `sendMessage` (text) | Yes — triggers `sendMessages({ trigger: 'submit-message' })` | Yes | Yes |
| `sendMessage` with `messageId` (edit) | Yes — same trigger, but `messageId` is set | Probably — `messageId` is passed through in the POST body | **No** |
| `sendMessage` with `files` | Partially — files are added as `FileUIPart` to the user message by useChat before calling transport; transport just forwards the messages array in the POST body | Probably — but depends on payload size vs Ably/HTTP limits | **No** |
| `regenerate` | Yes — triggers `sendMessages({ trigger: 'regenerate-message' })` | Yes | Yes |
| `regenerate` with `messageId` | Yes — specifies which message to regenerate | Yes — computes `forkOf`/`parent` from tree | Yes |

### Stream Control

| Feature | Relevant to transport? | Works? | Tested? |
| --- | --- | --- | --- |
| `stop` (abort) | Yes — wired to `transport.cancel({ all: true })` via abort signal | Yes | Yes |
| `resumeStream` | Yes — calls `reconnectToStream()` | Returns `null` — relies on Ably observer mode instead | Partial (returns null; observer mode untested) |
| `resume` on mount | Yes — calls `reconnectToStream()` on mount | Same as above | **No** |

### Tool Handling

| Feature | Relevant to transport? | Works? | Tested? |
| --- | --- | --- | --- |
| `addToolOutput` | Yes — updates messages, may trigger `sendMessages` via `sendAutomaticallyWhen` | Should work — it's just another `submit-message` call | **No** |
| `addToolApprovalResponse` | Yes — same flow as `addToolOutput` | Should work | **No** |
| `sendAutomaticallyWhen` | Yes — triggers additional `sendMessages` calls | Should work | **No** |

### Callbacks

| Feature | Relevant to transport? | Works? | Tested? |
| --- | --- | --- | --- |
| `onFinish` | No — useChat internal, fires from stream events | — | — |
| `onToolCall` | No — useChat internal, fires from chunks | — | — |
| `onError` | No — useChat internal | — | — |
| `onData` | No — useChat internal, fires from `data-*` chunks | — | — |

### Configuration

| Feature | Relevant to transport? | Works? | Tested? |
| --- | --- | --- | --- |
| `transport` option | Yes — this is how our ChatTransport is injected | Yes | Yes |
| `experimental_throttle` | No — React rendering concern | — | — |
| Per-request `headers`/`body`/`metadata` | Partially — passed to `sendMessages`, available via `prepareSendMessagesRequest` hook | Yes | Yes (hook tested) |

---

## Transport-Layer Surface Area: ChatTransport Interface

The AI SDK's `ChatTransport` interface has two methods:

| Method | Signature | Implemented? | Tested? |
| --- | --- | --- | --- |
| `sendMessages` | `(opts: { trigger, messages, abortSignal, chatId, messageId, ... }) => Promise<ReadableStream<UIMessageChunk>>` | Yes | Yes |
| `reconnectToStream` | `(chatId, opts) => Promise<ReadableStream<UIMessageChunk> \| null>` | Yes (returns `null`) | Yes |

Our `ChatTransport` also adds `close()` for transport cleanup.

### sendMessages Behaviour

The `ChatTransport` adapter splits messages based on trigger:

- **`submit-message`**: last message is new, rest is history.
- **`regenerate-message`**: all messages are history, no new messages; computes
  `forkOf`/`parent` from the conversation tree.

The returned stream is **intentionally empty** — it closes when the turn ends but
contains no chunks. This avoids double-accumulation: the real message state comes
from `useMessageSync`, which subscribes to the core transport's `message` events
and pushes authoritative state into `useChat`'s `setMessages`.

### reconnectToStream Behaviour

Always returns `null`. The design relies on Ably's observer mode: the transport
subscribes before channel attach, so when the server appends to an in-progress
stream, the client receives events automatically and `useMessageSync` updates
React state.

---

## Features Assessed as Out of Scope

These AI SDK features are **not relevant** to the transport layer and do not
require testing or coverage from us:

- **Middleware** (`wrapGenerate`/`wrapStream`) — operates at the language model
  layer, before `streamText()` produces chunks. The transport only sees the
  final `UIMessageChunk` stream after all middleware transformations. Middleware
  is fully orthogonal to the transport.
- **`generateText()`** — non-streaming alternative to `streamText()`. Also
  produces `UIMessageChunk` via `toUIMessageStream()`, so the transport handles
  it identically.
- **`streamObject()`** — different API, not used with `useChat`/`ChatTransport`.
- **`DirectChatTransport`** — an in-process alternative to HTTP transports. It
  is a competing transport implementation, not something we wrap or support.
- **Server-side tool execution** — happens inside `streamText()` before chunks
  reach the transport. The transport just sees the resulting
  `tool-output-available` / `tool-output-error` chunks.
- **Provider-specific features** (OpenAI, Anthropic model options, etc.) —
  abstracted away by the AI SDK before reaching `toUIMessageStream()`.
- **`useCompletion`, `useObject`** — different hooks, not `useChat`.
### useChat Callbacks and State with the Empty Stream (Potential Issue)

Our `ChatTransport.sendMessages()` returns an **intentionally empty stream**
that closes when the turn ends but contains no `UIMessageChunk`s. The real
message state is pushed via `useMessageSync`, which subscribes to the core
transport's `message` events and calls `setMessages()`.

This design has consequences for useChat's internal processing. The `AbstractChat`
class in the AI SDK (at `ai/src/ui/chat.ts`) processes the returned stream via
`processUIMessageStream`, which drives callbacks and state transitions from the
chunks it receives. With an empty stream:

**Callbacks:**

| Callback | Fires? | Why |
| --- | --- | --- |
| `onFinish` | **Yes** — but with degraded data | Fires unconditionally in the `finally` block. However, the `message` field contains an assistant message with **empty `parts`** (since no chunks were processed), and `finishReason` is **`undefined`** (only set by a `finish` chunk). |
| `onToolCall` | **No** | Only fires when `processUIMessageStream` receives a `tool-input-available` chunk. Empty stream means this never happens. **This is a real gap for client-side tool execution in use case 3.** |
| `onData` | **No** | Only fires when `processUIMessageStream` receives a `data-*` chunk. |
| `onError` | **No** (unless stream throws) | Only fires if the stream itself throws an error, not from `error` chunks. |

**State:**

| State | Behaviour with empty stream | Expected behaviour |
| --- | --- | --- |
| `status` | Transitions `submitted` → `ready`, **never enters `streaming`** | Should transition `submitted` → `streaming` → `ready`. UI code checking `status === 'streaming'` to show typing indicators or stop buttons will not work. |
| `messages` | Not updated by the stream (the `write()` function is never called since no chunks arrive). `useMessageSync` calls `setMessages()` externally, which works because `write()` never overwrites it. | Works correctly in practice — `useMessageSync` provides authoritative state. But `onFinish` receives a message with empty parts, not the real accumulated message. |

**Assessment:** The empty stream design works for the basic send/receive flow
because `useMessageSync` provides authoritative message state. However, it
creates real problems for:

1. **Client-side tool execution** — `onToolCall` never fires, so tools cannot be
   executed on the client in use case 3. This is a functional gap, not just a
   testing gap.
2. **Status transitions** — `streaming` status is never reached, which affects
   UI patterns that depend on it (typing indicators, stop buttons). The
   `useChat` demo may work around this, but it's not obvious how.
3. **`onFinish` data quality** — the callback receives a hollow message, not the
   real one. Code that uses `onFinish` to persist messages or trigger
   side-effects will get wrong data.
4. **`onData` for transient data parts** — transient data parts (which are not
   persisted in messages) can only be observed via `onData`. Since it never
   fires, transient data parts are invisible in use case 3.

These are moved to the identified gaps section below.

---

## Identified Gaps

### Gap 0: Empty Stream Breaks useChat Internals (Critical — Use Case 3)

**What:** Our `ChatTransport.sendMessages()` returns an intentionally empty
`ReadableStream<UIMessageChunk>` — it closes when the turn ends but emits no
chunks. This was designed to avoid double-accumulation: the real message state
comes from `useMessageSync` calling `setMessages()`. However, `useChat`'s
`AbstractChat` class drives its callbacks and state transitions from the chunks
it reads from the returned stream. An empty stream causes:

1. **`onToolCall` never fires** — this callback is invoked only when
   `processUIMessageStream` receives a `tool-input-available` chunk. With no
   chunks, client-side tool execution is impossible in use case 3.
2. **`status` never reaches `'streaming'`** — the `write()` function (which
   transitions status from `submitted` to `streaming`) is only called when a
   chunk is processed. Status transitions are `submitted` → `ready`, skipping
   `streaming` entirely. UI code that checks `status === 'streaming'` for typing
   indicators or stop buttons will not work.
3. **`onFinish` receives degraded data** — it fires (in a `finally` block), but
   the `message` field contains an assistant message with empty `parts` and
   `finishReason` is `undefined`. Code using `onFinish` to persist messages or
   trigger side-effects gets wrong data.
4. **`onData` never fires** — transient data parts (not persisted in messages)
   can only be observed via `onData`. They are invisible in use case 3.

**Current state:** The empty stream is a deliberate design choice (see
`chat-transport.ts`). The basic send/receive flow works because `useMessageSync`
provides authoritative message state externally. But the above four issues are
**functional gaps**, not just testing gaps.

**Risk:** Critical for use case 3. Items 1 and 2 are likely to affect real
users. Items 3 and 4 affect users who rely on those specific useChat features.

**Possible fix directions:**
- **Replay chunks through the returned stream** — instead of returning an empty
  stream, the `ChatTransport` could subscribe to the core transport's decoded
  events and re-emit them as `UIMessageChunk`s on the returned stream. This
  would restore all useChat internal processing (callbacks, status transitions)
  while `useMessageSync` continues to provide authoritative message state.
- **Accept the limitation and document it** — if the cost of replaying chunks is
  too high, document that use case 3 does not support `onToolCall`, `onData`, or
  accurate `status` transitions, and recommend use case 2 for those features.

**Applies to:** Use case 3 only. Use cases 1 and 2 are not affected.

### Gap 1: Multi-Step Tool Use (High Priority)

**What:** When `streamText()` is configured with `stopWhen` for multi-step tool
use (or any custom stop condition), the LLM can call tools, receive results, and
call more tools across multiple steps. Each step emits `start-step` → tool
chunks → `finish-step` → `start-step` → more chunks → `finish-step` → `finish`.

**Current state:** The codec handles each individual chunk type correctly. The
accumulator handles `start-step`/`finish-step` and resets text ID tracking
between steps. But there are **no integration tests** for a multi-step tool flow
through the full transport. Neither demo exercises tools at all.

**Risk:** Medium-high. The codec encodes each chunk type correctly in isolation,
but the interaction between step boundaries, tool state machine transitions
across steps, and the accumulator's step-reset logic has not been validated
end-to-end.

**Applies to:** All three use cases (server encodes multi-step; client
decodes/accumulates).

### Gap 2: Client-Side Tool Results via useChat (High Priority — Use Case 3)

**What:** `useChat` supports client-side tool execution via `onToolCall` +
`addToolOutput`. When a tool call arrives, the client executes it locally and
calls `addToolOutput`, which updates the messages and (if
`sendAutomaticallyWhen` is configured) triggers a new `sendMessages` call to
continue the conversation.

**Current state:** This is **blocked by Gap 0** — since `onToolCall` never fires
with the empty stream, the client-side tool execution flow cannot work at all.
Even if Gap 0 were fixed, the subsequent `addToolOutput` → `sendMessages`
re-submission flow is **completely untested**. The `ChatTransport` would receive
a `sendMessages` call with the updated messages (including tool results). This
_should_ work since it is another `submit-message` call, but there are
subtleties: the messages array now contains assistant messages with tool call
parts, and the `ChatTransport` takes the last message as `newMessages`.

**Risk:** High — blocked by Gap 0, and untested even in isolation.

**Applies to:** Use case 3 only. Use cases 1 and 2 handle tool results
server-side.

### Gap 3: File Attachments (Medium Priority)

**What:** `useChat.sendMessage({ text, files })` adds file parts to the user
message. `toUIMessageStream()` can emit `file` chunks from the server (e.g.
generated images).

**Current state:** Server→client file chunks are handled by the codec (encoder,
decoder, accumulator all support `file` type with unit tests). Client→server
file uploads happen at the `useChat` level — files are added as `FileUIPart` to
the user message, then passed to `sendMessages`. The `ChatTransport` includes
the full message in the POST body, so files should flow through. But this is
**untested end-to-end**.

**Risk:** Medium. The server→client codec path is unit-tested. The client→server
path depends on how large file data URLs interact with Ably message size limits
and the HTTP POST body. Large images as data URLs could exceed limits.

**Applies to:** All three use cases for server→client. Use case 3 for
client→server via useChat.

### Gap 4: Data Parts / Generative UI (Medium Priority)

**What:** Custom `data-*` parts allow streaming structured data (charts,
widgets, etc.) alongside text. Can be persistent or transient.

**Current state:** The codec fully supports `data-*` encoding, decoding, and
accumulation (including transient skipping and ID-based reconciliation). Unit
tests exist. But there is **no integration test** and **no demo** showing data
parts flowing through the transport.

**Risk:** Low-medium. The codec coverage is thorough in unit tests. The main
risk is that data parts with complex serialised payloads might hit edge cases in
Ably message encoding.

**Applies to:** All three use cases.

### Gap 5: Edit Flow Through ChatTransport (Medium Priority — Use Case 3)

**What:** `useChat.sendMessage({ text, messageId })` replaces an existing
message and re-runs the assistant. This sends `trigger: 'submit-message'` with
a `messageId` to the transport. Our `ChatTransport` passes the `messageId`
through to the POST body but does not compute `forkOf`/`parent` for edits (only
for `regenerate-message`).

**Current state:** The code path exists but is **untested**. The server would
need to handle edit semantics (the `messageId` in the body indicates which
message is being replaced).

**Risk:** Medium. The transport passes the data through, but the fork metadata
is incomplete for edits. The server-side handling of edit-with-messageId is not
demonstrated or tested.

**Applies to:** Use case 3 only. Use case 2 has `useEdit` which is a separate
mechanism with explicit fork metadata.

### Gap 6: Error Recovery / Stream Resume (Medium Priority — Use Case 3)

**What:** `useChat` has `resumeStream()` for reconnecting after network errors,
and `resume: true` for auto-resuming on mount.

**Current state:** `reconnectToStream()` returns `null`. The design relies on
Ably's observer mode for mid-stream reconnection. This is a reasonable design
choice, but the fallback behaviour is **untested**.

**Risk:** Low-medium. Observer mode should work for mid-stream reconnection
(Ably handles this natively). But the `useChat` side may behave unexpectedly
when `reconnectToStream` returns `null` — e.g. it might set status to `'ready'`
when the stream is actually still in progress.

**Applies to:** Use case 3 only. Use cases 1 and 2 handle reconnection via the
core transport directly.

### Gap 7: Tool Approval Flow (Low Priority)

**What:** AI SDK v6 supports `tool-approval-request` →
`addToolApprovalResponse` for human-in-the-loop tool approval.

**Current state:** The codec handles `tool-approval-request` and
`tool-output-denied` chunks. The accumulator tracks approval states. Unit tests
exist. But the **full round-trip** (server sends approval request → client
approves/denies → server continues) is **untested** through the transport.

**Risk:** Low. The individual codec pieces are unit-tested. The integration risk
is that the approval response, sent back as a new `sendMessages` call via
`useChat`, might not carry the right message structure.

**Applies to:** Use case 3 for the useChat flow. Use cases 1 and 2 would handle
this application-specifically.

### Gap 8: Source Parts (Low Priority)

**What:** `source-url` and `source-document` parts for citing sources in
responses.

**Current state:** Fully handled by the codec with unit tests. No integration
test.

**Risk:** Low. Simple discrete messages with straightforward encoding.

**Applies to:** All three use cases.

---

## Recommended Priority

### P0 — Fix or explicitly accept a known functional limitation

0. **Empty stream in ChatTransport (Gap 0)** — Decide whether to fix the empty
   stream (by replaying decoded chunks through the returned stream) or accept
   the limitation and document it. This blocks client-side tool execution, breaks
   `status` transitions, and degrades `onFinish`/`onData`. If we fix it, Gaps 2
   and 4 (transient data parts) are unblocked. If we accept it, we should
   document that use case 3 does not support `onToolCall`, `onData`, or accurate
   `status` transitions, and recommend use case 2 for those features.

### P1 — Highest value, moderate effort

1. **Multi-step tool use integration test (Gap 1)** — Prove that a
   `streamText()` call with tools and a multi-step stop condition encodes,
   transmits, decodes, and accumulates correctly through the full transport.
   This is the biggest unknown in the codec/transport layer.
2. **Client-side tool result flow through ChatTransport (Gap 2)** — Once Gap 0
   is resolved, test (or demo) showing `onToolCall` → `addToolOutput` →
   auto-resubmit working through our transport end-to-end.

### P2 — Medium value, fills important gaps

3. **Edit flow through ChatTransport (Gap 5)** — Test
   `sendMessage({ messageId })` produces correct fork metadata and the server
   handles it correctly.
4. **File attachment roundtrip (Gap 3)** — Integration test for server→client
   file chunks; test for client→server file parts through `ChatTransport`.
5. **Data parts integration test (Gap 4)** — Prove `data-*` parts with real
   payloads survive the Ably encode/decode roundtrip.

### P3 — Lower value, defensive

6. **`reconnectToStream` behaviour validation (Gap 6)** — Verify that `useChat`
   handles the `null` return gracefully and that observer mode fills the gap.
7. **Tool approval flow integration test (Gap 7)** — Full round-trip through
   transport.
8. **Source parts integration test (Gap 8)** — Round-trip through transport.
