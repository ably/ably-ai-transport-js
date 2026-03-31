# Vercel AI SDK v6 Surface Area Coverage

> [!warning]
> This document is largely raw Claude output, only refined through some back-and-forth with me. I have not yet looked into its findings. Further investigation of its points is to come.

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

1. **No React hooks** — frontend uses `ClientTransport` directly (wired into
   the user's own UI or a non-UI consumer); backend uses `ServerTransport`
   with `UIMessageCodec`.
2. **Our React hooks** — React frontend with `useClientTransport`, `useSend`,
   etc.; backend uses `ServerTransport` with `UIMessageCodec`.
3. **Vercel `useChat`** — React frontend with Vercel's `useChat` hook, using
   `ChatTransport` adapter + `useMessageSync`; backend uses `ServerTransport`
   with `UIMessageCodec`.

### Other AI SDK Capabilities Considered

The AI SDK v6 includes several capabilities beyond `streamText` + `useChat`.
The AI SDK UI layer (`ai` and `@ai-sdk/react` packages) provides exactly three
React hooks: `useChat`, `useCompletion`, and `useObject` (experimental). Only
`useChat` uses the `ChatTransport` abstraction. The other two hooks, and all
non-UI capabilities, were assessed for whether they need a durable transport
story:

| Capability | React hook? | Uses ChatTransport? | Streaming? | Durable transport value |
| --- | --- | --- | --- | --- |
| `streamText` + `useChat` | `useChat` (from `ai`) | **Yes** | Yes | **Critical** — our core use case |
| `streamObject` + `useObject` | `useObject` (experimental, from `@ai-sdk/react`) | No — direct HTTP POST | Yes (partial objects) | High — but different transport interface |
| `streamText` + `useCompletion` | `useCompletion` (from `ai`) | No — direct HTTP POST | Yes (text deltas) | Medium — simpler state model, no conversation history |
| `generateText` | No | No | No | Very low — single request/response |
| `generateImage` | No | No | No | Low — long-running but no streaming |
| `generateVideo` (experimental) | No | No | No | Low — same as image |
| `transcribe` (experimental) | No | No | No | Low |
| `generateSpeech` (experimental) | No | No | No | Very low |
| `embed` / `embedMany` | No | No | No | Very low |

**Why don't `useCompletion` and `useObject` have a `transport` option?**

`useChat` gained its `ChatTransport` abstraction relatively recently (AI SDK v5+)
to support custom transport layers like ours. The other two hooks are simpler and
less used:

- `useCompletion` is a thin wrapper around a single HTTP POST. It accumulates
  text deltas into a string — no message history, no tool calls, no
  conversation state. The entire hook is ~80 lines that call
  `callCompletionApi()`, which does `fetch(api, ...)` and reads the response
  body. There is no transport abstraction — the `fetch` call and response
  parsing are inlined.
- `useObject` (experimental, from `@ai-sdk/react`) is similarly a direct HTTP
  consumer. It POSTs to an `api` URL and parses the streaming JSON response
  into a typed partial object. No transport abstraction.

Both hooks accept a `fetch` option, which is a custom `fetch` function. In
theory, you could inject a `fetch` that ignores the URL and returns a `Response`
whose body is an Ably-backed `ReadableStream`. This would give you durable
streaming without changes to the AI SDK. However:

- It's a hack — the hooks still construct a `Request` with headers, body, and
  abort signal that get thrown away.
- For `useCompletion`, the response must be a stream of either plain text or
  newline-delimited JSON `UIMessageChunk` objects (depending on
  `streamProtocol`). Only `text-delta` and `error` chunk types are processed;
  everything else is ignored.
- For `useObject`, the response must be chunked JSON text that the hook parses
  incrementally against a Zod schema.
- Neither hook has conversation state, history, or branching — the features that
  make Ably's durable transport most valuable.

**Do `useCompletion` and `useObject` represent gaps in our coverage?**

Not really. `useCompletion`'s use case (single-shot text streaming) is a subset
of what `useChat` can do — a user can achieve the same thing with `useChat` and
our transport. `useObject`'s use case (streaming a structured object with
progressive partial rendering) is similarly covered: `streamText()` supports
`output: Output.object()` for structured output, and the resulting
`UIMessageChunk`s flow through our transport and into `useChat` as normal
message parts. The only thing lost vs. `useObject` is the incremental typed
partial object DX — with `useChat`, the structured data arrives as text or data
parts rather than as a progressively-filling typed object.

**Conclusion:** The three use cases listed above are the right ones for this
audit. `useChat` is the only React hook with a pluggable transport abstraction,
and its capabilities subsume the core use cases of `useCompletion` and
`useObject`. If there is customer demand for the specific `useObject` DX (typed
partial objects) over Ably, the right path would be to propose a `transport`
option upstream for that hook. For now, `useChat` with structured output covers
the need.

These map to the library's entry points as follows:

| Use case | Client entry points | Server entry point |
| --- | --- | --- |
| 1. No React hooks | `@ably/ai-transport` + `@ably/ai-transport/vercel` | `@ably/ai-transport/vercel` |
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

## Testing Taxonomy

The codebase currently has two test tiers: **unit tests** (mocks only, `npm
test`) and **integration tests** (real Ably channels, `npm run
test:integration`). However, the term "integration test" is ambiguous — the
existing integration tests vary in what they integrate, and some important
integration levels don't exist at all.

### Existing Test Levels

**Level 1: Unit tests (mocks only)**

All source modules have unit tests using mocked dependencies. Codec tests
encode/decode hand-crafted `UIMessageChunk` objects. Transport tests use mock
channels and mock writers. React hook tests use `renderHook` with mock
transports. The `ChatTransport` adapter is tested as a plain function against a
mocked core transport — not as a React hook.

**Level 2: Codec integration tests (real Ably, no transport)**

`test/vercel/codec/codec.integration.test.ts` — one client publishes via the
encoder, a separate client subscribes and decodes. Proves the wire format
survives Ably serialisation. No transport machinery involved.

**Level 3: Transport integration tests (real Ably, both transports)**

`test/core/transport/client-transport.integration.test.ts` — uses both
`ClientTransport` and `ServerTransport` on a real Ably channel. Proves the full
send → stream → receive lifecycle. The server side creates turns and streams
responses; the client side sends messages and reads the response stream.

`test/core/transport/server-transport.integration.test.ts` — uses
`ServerTransport` on one side and a bare subscriber client on the other (no
`ClientTransport`). The subscriber manually decodes Ably messages. Proves the
server publishes correctly.

### Missing Test Levels

**Level 4: AI SDK integration tests (real `streamText` + `toUIMessageStream`)**

No test currently uses the real AI SDK to produce chunks. All existing tests
hand-craft `UIMessageChunk` objects. A Level 4 test would use `streamText()`
with a fake language model provider, call `.toUIMessageStream()`, and pipe the
result through our `ServerTransport`. This would catch mismatches between what
the AI SDK actually produces and what our encoder expects — particularly
important when upgrading `ai` package versions, since chunk shapes can change.

The AI SDK provides a `MockLanguageModelV1` for testing (see
[AI SDK testing docs](https://ai-sdk.dev/docs/ai-sdk-core/testing)). This
could be used to produce deterministic `streamText` output without needing a
real LLM provider.

**Level 5: useChat integration tests (real `useChat` + our `ChatTransport`)**

No test currently exercises the real `useChat` hook with our `ChatTransport`.
The only place this combination runs is the demo app, which is manually tested.
A Level 5 test would use `renderHook` (or similar) to create a real `useChat`
instance with our `ChatTransport`, send messages, and verify that callbacks
fire, status transitions correctly, and messages arrive. This is the level
needed to validate or disprove the findings in Gap 0 (empty stream issues).

This is harder to set up than Levels 2–4 because it requires a React test
environment, a real (or realistically mocked) Ably channel, and a server-side
transport producing chunks. But it's the only way to prove that use case 3
actually works end-to-end.

### Which Gaps Need Which Test Level

| Gap | Minimum test level needed |
| --- | --- |
| Gap 0 (empty stream / useChat internals) | **Level 5** — must exercise real `useChat` to verify callbacks and status |
| Gap 1 (multi-step tool use) | **Level 3 or 4** — transport integration with multi-step chunk sequences; Level 4 would also validate that `streamText` with tools produces the expected chunks |
| Gap 2 (client-side tool execution) | **Level 5** — must exercise `onToolCall` + `addToolOutput` through real `useChat`; also needs a design decision for persisting tool output to Ably history |
| Gap 3 (Ably message size limits) | **Level 2** — codec integration with payloads near the size limit to characterise the failure mode |
| Gap 4 (data parts integration) | **Level 2** — codec roundtrip with realistic payloads |
| Gap 5 (edit flow) | **Level 3** — transport integration with `messageId` |
| Gap 6 (reconnect / resume) | **Level 5** — must verify `useChat` behaviour when `reconnectToStream` returns `null` |
| Gap 7 (tool approval) | **Level 3** — transport integration for the round-trip |
| Gap 8 (source parts) | **Level 2** — codec roundtrip |

---

## Server-Side Surface Area: UIMessageChunk Types

These are the chunk types that `toUIMessageStream()` can emit. Every one of
these must be correctly encoded by the server transport, transmitted over Ably,
decoded by the client, and accumulated into `UIMessage` objects.

### Message Lifecycle

| Chunk type | Codec handles? | Unit tested? | Codec integration (L2)? | Transport integration (L3)? |
| --- | --- | --- | --- | --- |
| `start` | Yes | Yes | Yes | Yes |
| `finish` | Yes | Yes | Yes | Yes |
| `abort` | Yes | Yes | Yes | Yes |
| `error` | Yes | Yes | Yes | Yes |
| `message-metadata` | Yes | Yes | No | No |
| `start-step` | Yes | Yes | No | No |
| `finish-step` | Yes | Yes | No | No |

### Text Streaming

| Chunk type | Codec handles? | Unit tested? | Codec integration (L2)? | Transport integration (L3)? |
| --- | --- | --- | --- | --- |
| `text-start` | Yes | Yes | Yes | Yes |
| `text-delta` | Yes | Yes | Yes | Yes |
| `text-end` | Yes | Yes | Yes | Yes |

### Reasoning

| Chunk type | Codec handles? | Unit tested? | Codec integration (L2)? | Transport integration (L3)? |
| --- | --- | --- | --- | --- |
| `reasoning-start` | Yes | Yes | Yes | No |
| `reasoning-delta` | Yes | Yes | Yes | No |
| `reasoning-end` | Yes | Yes | Yes | No |

### Tool Input (Streaming)

| Chunk type | Codec handles? | Unit tested? | Codec integration (L2)? | Transport integration (L3)? |
| --- | --- | --- | --- | --- |
| `tool-input-start` | Yes | Yes | Yes | No |
| `tool-input-delta` | Yes | Yes | Yes | No |
| `tool-input-available` | Yes | Yes | Yes | No |
| `tool-input-error` | Yes | Yes | No | No |

### Tool Output

| Chunk type | Codec handles? | Unit tested? | Codec integration (L2)? | Transport integration (L3)? |
| --- | --- | --- | --- | --- |
| `tool-output-available` | Yes | Yes | Yes | No |
| `tool-output-error` | Yes | Yes | No | No |
| `tool-approval-request` | Yes | Yes | No | No |
| `tool-output-denied` | Yes | Yes | No | No |

### Content Parts

| Chunk type | Codec handles? | Unit tested? | Codec integration (L2)? | Transport integration (L3)? |
| --- | --- | --- | --- | --- |
| `file` | Yes | Yes | No | No |
| `source-url` | Yes | Yes | No | No |
| `source-document` | Yes | Yes | No | No |
| `data-*` (custom) | Yes | Yes | No | No |

### Summary

The codec has **complete coverage of all UIMessageChunk types**. Every chunk type
that `toUIMessageStream()` can emit is handled by the encoder, decoder, and
accumulator. All types have unit tests. Codec integration tests (Level 2) exist
for text, reasoning, tool input/output, lifecycle, and error propagation.
Transport integration tests (Level 3) exist only for text streaming and
lifecycle events. No tests at any level use the real AI SDK (Level 4) or
exercise `useChat` (Level 5).

Note: the transport integration tests (Level 3) are at the core transport layer,
not the Vercel layer. They use the generic `ClientTransport` / `ServerTransport`
with the `UIMessageCodec`, so they do exercise the Vercel codec indirectly.

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
`chat-transport.ts`). **Messages display and stream correctly** — `useMessageSync`
subscribes to the core transport's `message` events and pushes authoritative
state into `useChat`'s `setMessages`, so the user sees the right content in
real time. The problem is that `useChat` itself doesn't know streaming is
happening — its internal `processUIMessageStream` never runs because there are
no chunks on the stream we return. So the content works, but `useChat`'s state
and callbacks don't reflect reality.

**Risk:** Critical for use case 3. Items 1 and 2 are likely to affect real
users. Items 3 and 4 affect users who rely on those specific useChat features.

**Testing needed:** Level 5 (useChat integration). This is the only way to
confirm or disprove these findings — a Level 5 test would create a real `useChat`
instance with our `ChatTransport`, send a message, and verify that `status`
transitions through `streaming`, that `onToolCall` fires for tool calls, and
that `onFinish` receives the real message. The existing demo app exercises this
path manually but has no automated assertions.

**Relationship to Gap 6 (reconnect/resume):** Gap 6 is the same root cause.
`reconnectToStream()` returns `null`, so when `useChat` tries to resume after
a page reload, it early-returns without entering `streaming` status, without
processing chunks, and without firing callbacks. The consequences are identical
to the empty stream: `status` doesn't reflect reality, `onToolCall` won't fire
for tool calls arriving after reconnection, `onFinish` won't fire, etc. The fix
is the same in both cases — return a real stream of `UIMessageChunk`s replayed
from the Ably channel.

**Possible fix directions:**
- **Replay chunks through the returned stream** — instead of returning an empty
  stream from `sendMessages` (and `null` from `reconnectToStream`), the
  `ChatTransport` could subscribe to the core transport's decoded events and
  re-emit them as `UIMessageChunk`s. This would restore all `useChat` internal
  processing (callbacks, status transitions) for both the send and reconnect
  paths. `useMessageSync` would continue to provide authoritative message state.
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

**Testing needed:** Level 3 (transport integration) at minimum — a test that
streams a multi-step tool sequence through `ClientTransport` and
`ServerTransport` on a real Ably channel. Level 4 (AI SDK integration) would
additionally validate that `streamText()` with real tools and a fake provider
produces the expected chunk sequence.

**Applies to:** All three use cases (server encodes multi-step; client
decodes/accumulates).

### Gap 2: Client-Side Tool Execution (High Priority — Use Case 3)

**What:** `useChat` supports client-side tool execution via `onToolCall` +
`addToolOutput`.

**Normal flow (vanilla `useChat` with default HTTP transport):**

1. Client sends messages to server via HTTP POST.
2. Server calls `streamText()` with tools; the LLM decides to call a tool.
3. Server streams the response back over SSE — `tool-input-available` chunks
   arrive at the client.
4. `useChat` processes the stream chunks, fires `onToolCall`.
5. Client executes the tool locally, calls `addToolOutput({ toolCallId,
   output })`, which mutates the assistant message's tool part in-memory.
6. `sendAutomaticallyWhen` triggers re-submission — `useChat` sends the full
   messages array (including the modified assistant message with tool output)
   via HTTP POST.
7. Server feeds the conversation to `streamText()` for the next step, streams
   the response back over SSE.

This works because conversation state lives entirely in client memory and is
sent in full to the server on each request. There is no persistent history to
keep in sync — the client's in-memory messages array is the source of truth.

**Flow with our transport:**

1. Client sends messages to server via HTTP POST (same as above).
2. Server calls `streamText()`, LLM decides to call a tool.
3. Server streams `tool-input-available` chunks to Ably — the tool **call** is
   now in channel history.
4. Server finishes the turn (`finishReason: 'tool-calls'`).
5. `useChat` receives the stream returned by our `ChatTransport` — but this
   stream is **empty** (Gap 0), so `onToolCall` never fires. The flow stops
   here.

Even if Gap 0 were fixed (so that `onToolCall` fires), the subsequent steps
diverge from the normal flow:

6. Client calls `addToolOutput`, mutating the assistant message in-memory.
7. `sendAutomaticallyWhen` triggers re-submission via our `ChatTransport`.
8. `ChatTransport` sends HTTP POST to server with the full messages array.
9. Server feeds it to `streamText()`, streams the next response over Ably.

The tool **output** (result) from step 6 only ever exists in the client's
in-memory state and the HTTP POST body. Nobody publishes it to the Ably
channel. In the normal flow this is fine — there is no persistent history. But
in our flow, Ably channel history is the source of truth for durability. A page
refresh would hydrate from history and find the tool call stuck in
`input-available` state with no output.

There are three distinct problems here:

**Problem 2a: `onToolCall` never fires (blocked by Gap 0).** The empty stream
means `useChat` never processes `tool-input-available` chunks, so the callback
never fires. Client-side tool execution cannot begin at all.

**Problem 2b: Tool output is not published to Ably history.** Even if Gap 0
were fixed, the tool **output** (result) only ever exists in the client's
in-memory state and the HTTP POST body. Nobody publishes it to the Ably channel.
The transport architecture is unidirectional: clients send user messages, the
server streams assistant messages. There is no mechanism for the client to
update an assistant message, and `addMessages` / `writeMessages` only encode
`text`, `file`, and `data-*` parts — tool parts are silently dropped.

This means a page refresh would hydrate from Ably history and show the tool
call stuck in `input-available` state with no output. Subsequent turns would
not have the tool result in context. This is a fundamental architectural gap:
the durability model assumes all conversation state flows through Ably, but
client-side tool output has no path to get there.

**Problem 2c: Re-submission flow is untested.** Even setting aside 2a and 2b,
the `addToolOutput` → `sendMessages` re-submission through our `ChatTransport`
is completely untested. After `addToolOutput`, `useChat` re-submits with
`trigger: 'submit-message'` where the last message in the array is the modified
**assistant** message. Our `ChatTransport` would treat this as the "new"
message to send — but `addMessages` is designed for user messages, not assistant
messages with tool parts.

**Risk:** Critical for use case 3. Three compounding issues: the trigger
mechanism is broken (2a), the durability model is broken (2b), and the
re-submission path is untested (2c).

**Testing needed:** Level 5 (useChat integration) — must exercise the full
flow. But before testing, a design decision is needed for how client-side tool
output should be persisted to Ably history. The AI SDK's
[chatbot tool usage docs](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage)
show client-side tool execution patterns (e.g. a `getLocation` tool) that would
be useful references for building demos and tests.

**Applies to:** Use case 3 only. Use cases 1 and 2 handle tool results
server-side, where the server streams `tool-output-available` to Ably as part
of `streamText()`'s automatic multi-step execution.

### Gap 3: Ably Message Size Limits for Large Payloads (High Priority)

**What:** Several types of data flow through the transport as **discrete Ably
messages carrying their full payload in a single message**. Ably's maximum
message size can be as low as 64KiB depending on the account's package (see
[Ably limits](https://ably.com/docs/platform/pricing/limits)), and no higher
than 256KiB. None of these payload types are streamed incrementally or broken
across multiple messages — the entire content travels in one Ably message.

This is a problem we introduce. In vanilla `useChat` (without our transport),
all of these payloads travel over a single HTTP SSE stream with no per-message
size limit. By routing them through Ably, we impose Ably's message size
constraints.

**Affected payload types, server→client (UIMessageChunk encoded as Ably
messages):**

- **`file` chunks** — Model-generated files (e.g. inline image generation from
  models like Gemini 2.5 Flash). The AI SDK converts model output to a base64
  data URL (`data:image/png;base64,...`) — there is no option for a hosted URL.
  A raw 48KB image becomes ~64KB in base64, hitting the minimum Ably limit.
- **`tool-output-available` chunks** — Server-side tool results. The `output`
  field is arbitrary JSON, serialised into the Ably message data. A tool
  returning a large JSON response (e.g. a database query result, an API
  response) could exceed the limit.
- **`data-*` chunks** — Custom data parts for generative UI. The Vercel docs
  describe use cases including "collaborative artifacts" and "code, documents,
  or designs in real-time", which could carry substantial payloads. Each chunk
  carries its full `data` payload in a single Ably message. The
  reconciliation-by-ID feature (updating an existing part) sends the full
  replacement payload each time, not a delta.

**Affected payload types, server-side publishing of user messages via
`addMessages` (UIMessage parts encoded as Ably messages):**

`addMessages` only publishes the **new user messages for the current turn** (not
previous turns' messages, which are already in channel history from when they
were originally streamed).

- **`file` parts** in user messages — When users attach files via
  `useChat.sendMessage({ files })`, the AI SDK's primary documented approach
  uses `<input type="file">` with `FileList`, which auto-converts files to
  base64 data URLs. This is what someone following the Vercel docs would be
  using. The `ChatTransport` sends these via HTTP POST to the server (not our
  problem — same as vanilla `useChat`), but the server then publishes them to
  the Ably channel via `turn.addMessages()`, where each `file` part becomes a
  discrete Ably message with `data: part.url` containing the full data URL.
  (Users _can_ alternatively provide `FileUIPart` objects with `https://` URLs,
  which would be tiny, but this is the secondary approach in the docs.)

**Potential future addition: client-side tool output.** Currently, client-side
tool output has no path to Ably at all (see Gap 2b). If that is resolved by
publishing tool output to the channel, those payloads would also be subject to
the size limit. Tool output is arbitrary JSON (`output: unknown`), so a tool
returning a large result (e.g. a fetched document, a data URL) would hit the
same constraint.

**Current state:** The codec handles encoding/decoding of all these types
correctly in unit tests. But no test exercises payloads near the Ably size
limit, and there is no handling (or documented guidance) for payloads that
exceed it.

**Risk:** Medium-high. This will silently fail or error on the Ably publish for
any payload exceeding the account's message size limit. Files are most likely to
hit this (images from `FileList` or model-generated images are routinely larger
than 48KB), but tool results and data parts are also at risk depending on the
application.

**Testing needed:** Level 2 (codec integration) with payloads near the size
limit, to confirm the failure mode and document it. We should also consider
whether we need a strategy for large payloads (e.g. external storage with URL
references, or splitting across multiple Ably messages).

**Applies to:** All three use cases.

### Gap 4: Data Parts / Generative UI — Integration Coverage (Medium Priority)

**What:** Custom `data-*` parts allow streaming structured data (charts,
widgets, artifacts, etc.) alongside text. Can be persistent or transient.
Persistent parts appear in `message.parts`; transient parts are only observable
via the `onData` callback in `useChat` (which is affected by Gap 0).

**Current state:** The codec fully supports `data-*` encoding, decoding, and
accumulation (including transient skipping and ID-based reconciliation). Unit
tests exist. But there is **no integration test** and **no demo** showing data
parts flowing through the transport.

**Risk:** Low-medium. The codec coverage is thorough in unit tests. The main
remaining risk is Ably serialisation edge cases with complex payloads (see also
Gap 3 for the size limit concern).

**Testing needed:** Level 2 (codec integration) — roundtrip with realistic
payloads.

**Applies to:** All three use cases for persistent data parts. Use case 3 for
transient data parts (blocked by Gap 0 — `onData` does not fire).

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

**Testing needed:** Level 3 (transport integration) — test `sendMessages` with
`messageId` and verify fork metadata and server handling.

**Applies to:** Use case 3 only. Use case 2 has `useEdit` which is a separate
mechanism with explicit fork metadata.

### Gap 6: Error Recovery / Stream Resume (Medium Priority — Use Case 3)

**What:** `useChat` has `resumeStream()` for reconnecting after network errors,
and `resume: true` for auto-resuming on mount.

**Background — how resume works in vanilla `useChat`:** The AI SDK's
[resume streams docs](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams)
describe a complex setup requiring Redis, the `resumable-stream` package, a
persistence layer, and two API endpoints (POST to create streams, GET to resume
them). All of this exists because HTTP SSE streams don't survive page reloads —
the client needs to reconnect and pick up where it left off.

**This is a problem Ably solves natively.** When a client disconnects and
reconnects, Ably delivers messages from the point of disconnection
automatically. Our transport handles this via observer mode (subscribe before
channel attach). So the Vercel resume mechanism is something **we replace
entirely** — it's one of our core value propositions. Users don't need Redis,
`resumable-stream`, or extra API endpoints.

**Current state:** `reconnectToStream()` returns `null`, which is intentional —
the client doesn't need to "resume" because it never lost the stream. But this
behaviour is **untested** against real `useChat`.

**Relationship to Gap 0:** This is the same root cause as Gap 0. Returning
`null` from `reconnectToStream` has the same consequences as returning an empty
stream from `sendMessages`: messages still appear correctly (via
`useMessageSync`), but `useChat`'s internal `processUIMessageStream` never runs,
so `status` doesn't reflect reality, and callbacks (`onToolCall`, `onFinish`,
`onData`) don't fire. The fix is the same — return a real stream of
`UIMessageChunk`s. If Gap 0 is fixed by replaying chunks through the returned
stream, `reconnectToStream` could use the same mechanism (subscribe to the Ably
channel and re-emit decoded chunks).

**Risk:** Same as Gap 0 — critical for use case 3. A user who refreshes mid-
stream will see messages appearing (via `useMessageSync`), but `useChat` won't
know it's streaming — `status` won't be `'streaming'`, `onToolCall` won't fire,
etc.

**Testing needed:** Level 5 (useChat integration) — must verify `useChat`
behaviour on page reload during an active stream.

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

**Testing needed:** Level 3 (transport integration) for the codec round-trip.
Level 5 (useChat integration) to verify the full approval flow through `useChat`.

**Applies to:** Use case 3 for the useChat flow. Use cases 1 and 2 would handle
this application-specifically.

### Gap 8: Source Parts (Low Priority)

**What:** `source-url` and `source-document` parts for citing sources in
responses.

**Current state:** Fully handled by the codec with unit tests. No integration
test.

**Risk:** Low. Simple discrete messages with straightforward encoding.

**Testing needed:** Level 2 (codec integration) — roundtrip through real Ably.

**Applies to:** All three use cases.

---

## Recommended Priority

### P0 — `useChat` state and callbacks are broken

0. **ChatTransport does not return a real stream (Gaps 0 + 6)** — `sendMessages`
   returns an empty stream; `reconnectToStream` returns `null`. Messages display
   and stream correctly (via `useMessageSync`), but `useChat`'s internal
   `processUIMessageStream` never runs because there are no chunks on the
   returned stream. This means `status` never reaches `streaming`, and callbacks
   (`onToolCall`, `onFinish`, `onData`) never fire. This blocks client-side tool
   execution (Gap 2). The fix is the same for both paths: replay decoded chunks
   from the Ably channel as `UIMessageChunk`s on the returned stream. This is a
   prerequisite for most other use case 3 work.

### P1 — Highest priority after P0

1. **Client-side tool execution (Gap 2)** — Even after P0 is fixed, two issues
   remain: tool output has no path to Ably history (architectural gap — the
   transport has no concept of a client updating an assistant message), and the
   re-submission flow is untested. Needs a design decision for how client-side
   tool output should be persisted before testing can begin.
2. **Ably message size limits (Gap 3)** — Affects anyone who uploads an image
   (the primary documented approach in the AI SDK), any model that generates
   images, and potentially any tool or data part with a non-trivial payload.
   Characterise the failure mode and decide on a strategy: document the
   limitation, provide guidance on hosted URLs / external storage, or implement
   chunking.

### P2 — Medium value, fills important gaps

3. **Multi-step tool use integration test (Gap 1)** — The codec probably handles
   this correctly (each chunk type is unit-tested), but the interaction between
   step boundaries, tool state transitions, and the accumulator's step-reset
   logic has not been validated end-to-end.
4. **Edit flow through ChatTransport (Gap 5)** — Test
   `sendMessage({ messageId })` produces correct fork metadata and the server
   handles it correctly.
5. **Data parts integration test (Gap 4)** — Prove `data-*` parts with real
   payloads survive the Ably encode/decode roundtrip.

### P3 — Lower value, defensive

6. **Tool approval flow integration test (Gap 7)** — Full round-trip through
   transport.
7. **Source parts integration test (Gap 8)** — Round-trip through transport.
