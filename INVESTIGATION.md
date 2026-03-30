# Codebase Investigation: @ably/ai-transport

**Goal**: Fully understand the SDK's primitives, architecture, and implementation details so we can contribute new codecs for other AI providers (e.g. Anthropic API, Anthropic Agents SDK).

**Status**: Complete -- all phases reviewed, Anthropic Agent SDK codec implemented, conclusions documented

---

## How We Work

- **Check items off as we go.** Mark each checklist item `[x]` once we've reviewed it and written up findings.
- **Pause after every item.** After summarizing what we learned, ask Joao to confirm understanding before moving to the next item. Do not proceed until he says he's ready.
- **Refine as we learn.** Update earlier sections if later findings clarify or correct them.
- **Cross-reference docs and commits.** When a doc describes something a commit implements, note the connection in the findings.
- **Revisit open questions.** After each item, check if any open questions (marked in findings sections) can now be answered. Update the answer inline and strike through the question.

---

## Investigation Plan

### Phase 1: Documentation Review

Read through `docs/` to build a conceptual understanding before touching source code.

- [x] **1.1** `docs/index.md` -- top-level overview, what the SDK is and why it exists
- [x] **1.2** `docs/concepts/transport.md` -- what a "transport" means in this SDK
- [x] **1.3** `docs/concepts/turns.md` -- the turn model
- [x] **1.4** `docs/internals/codec-interface.md` -- the Codec generic interface (central to adding new codecs)
- [x] **1.5** `docs/internals/encoder.md` -- how encoding works
- [x] **1.6** `docs/internals/decoder.md` -- how decoding works
- [x] **1.7** `docs/internals/wire-protocol.md` -- what goes over the wire via Ably channels
- [x] **1.8** `docs/internals/headers.md` -- header conventions (generic vs codec-specific)
- [x] **1.9** `docs/internals/message-lifecycle.md` -- lifecycle of a message through the system
- [x] **1.10** `docs/internals/client-transport.md` -- client-side transport internals
- [x] **1.11** `docs/internals/server-transport.md` -- server-side transport internals
- [x] **1.12** `docs/internals/transport-components.md` -- sub-components (StreamRouter, TurnManager, etc.)
- [x] **1.13** `docs/internals/conversation-tree.md` -- branching / conversation tree
- [x] **1.14** `docs/internals/history.md` -- history hydration
- [x] **1.15** `docs/internals/lifecycle-tracker.md` -- lifecycle tracker
- [x] **1.16** `docs/internals/chat-transport.md` -- ChatTransport adapter (Vercel useChat)
- [x] **1.17** `docs/internals/vercel-codec.md` -- the existing Vercel codec implementation
- [x] **1.18** `docs/internals/glossary.md` -- terminology
- [x] **1.19** `docs/features/*.md` -- feature pages (streaming, tool calls, cancel, branching, history, etc.)
- [x] **1.20** `docs/frameworks/vercel-ai-sdk.md` -- Vercel-specific integration details
- [x] **1.21** `docs/reference/error-codes.md` and `docs/reference/react-hooks.md`

### Phase 2: Commit-by-Commit Code Review

Walk the commit history in order, focusing on the implementation commits. Each commit builds on the previous, so we review incrementally.

- [x] **2.1** `7d6e3f1` -- codec: add core encoder and decoder machinery
- [x] **2.2** `c583bf3` -- codec/vercel: add Vercel AI SDK codec implementation
- [x] **2.3** `4d6142e` -- test/integration: add Vercel codec integration tests
- [x] **2.4** `a4f09a4` -- transport: add core server transport
- [x] **2.5** `3127f77` -- transport: add core client transport
- [x] **2.6** `912d11e` -- transport/vercel: convenience transport factories
- [x] **2.7** `c7f8962` -- transport/vercel: ChatTransport adapter for useChat
- [x] **2.8** `a321c9f` -- react: React hooks
- [x] **2.9** `b0f1814` -- transport: fix cancel/abort flow and observer lifecycle
- [x] **2.10** `edd7605` -- examples: add custom codec example (directly relevant to our goal)
- [x] **2.11** Later commits (consolidation, renaming, bug fixes) -- skim for architectural changes

### Phase 3: Codec Deep-Dive

With the full picture, focus specifically on what it takes to add a new codec.

- [x] **3.1** Document the Codec interface contract in detail
- [x] **3.2** Trace the Vercel codec as a reference implementation
- [x] **3.3** Identify all touchpoints a new codec must satisfy
- [x] **3.4** Study Anthropic Agent SDK message/event types (from docs provided by Joao)
- [x] **3.5** Map Anthropic Agent SDK types to the codec interface
- [x] **3.6** Draft a plan for an Anthropic Agent SDK codec

---

## Concepts & Architecture

> This section is populated as we go through the investigation. Each subsection corresponds to a key concept.

### What is @ably/ai-transport?

A transport layer for AI apps built on Ably. It sits between the server (where the LLM runs) and clients (where users interact), streaming data over Ably channels. Built-in features: cancellation, conversation branching, history, multi-client sync.

**Key architectural idea**: The SDK is **codec-parameterized**. A generic transport core handles streaming, turns, and state management. A pluggable **codec** translates between a specific framework's types (e.g. Vercel AI SDK's `UIMessage`) and the Ably wire format. Today only the Vercel codec ships; custom codecs are supported via the generic interfaces.

**Four entry points** from a single package:
- `@ably/ai-transport` -- generic core (framework-agnostic)
- `@ably/ai-transport/react` -- generic React hooks
- `@ably/ai-transport/vercel` -- Vercel AI SDK codec + factories
- `@ably/ai-transport/vercel/react` -- Vercel-specific React hooks (e.g. `useChatTransport` for `useChat`)

**Peer deps**: `ably` (always), `ai` (Vercel entry points), `react` (React entry points).

**Status**: Pre-release (v0.0.1). Vercel is the only shipped codec. Generic interfaces support custom codecs -- which is exactly what we'll use to add Anthropic.

**Open questions** (expect answers in later items):
- ~~What is the Ably wire format, and is it the same regardless of codec?~~ Answered in 1.7: Yes, the wire format is the same regardless of codec. Transport headers (`x-ably-*`) are codec-agnostic and handle turn correlation, streaming lifecycle, branching. Codecs add their own metadata via `x-domain-*` headers which the transport passes through without interpreting. The message structure (discrete vs streamed, actions, status) is uniform.
- ~~What are the specific framework types for Vercel?~~ Answered in 1.4: `TEvent` = `UIMessageChunk`, `TMessage` = `UIMessage`. Event types include `text-start/delta/end`, `tool-input-start/delta/available`, `start`, `finish`, `error`, `tool-output-*`, `data-*`.
- ~~How does the codec mapping actually work -- what logic runs?~~ Answered in 1.4: domain encoder maps events to core operations (startStream/appendStream/closeStream/publishDiscrete); decoder provides hooks (buildStartEvents/buildDeltaEvents/buildEndEvents/decodeDiscrete) that the DecoderCore calls.
- ~~What runs server-side vs client-side, and what formats flow in each direction?~~ Answered across 1.4 + 1.9: Server uses encoder (`TEvent` -> Ably operations for streaming, `TMessage` -> discrete publishes for user messages). Client uses decoder (Ably messages -> `DecoderOutput[]` of events and messages) + accumulator (events -> complete `TMessage`s) + conversation tree (stores messages, handles branching). The Ably channel carries the wire format (transport + domain headers). Own turns additionally get a `ReadableStream<TEvent>` for framework adapters.

### The Transport Abstraction

Two transports, one Ably channel between them:

**Data flow**: User -> ClientTransport -> HTTP POST -> ServerTransport -> LLM -> token stream -> encode -> Ably channel -> decode -> ClientTransport -> render to user.

The HTTP POST is **fire-and-forget** -- the client doesn't read the HTTP response body. The response stream comes back via the Ably channel subscription. This is the core architectural insight: HTTP is only used for the request; Ably handles the response delivery.

**Server transport** manages **turns** (request-response cycles). Per-turn lifecycle:
1. `transport.newTurn({ turnId, clientId })` -- create a turn
2. `turn.start()` -- begin
3. `turn.addMessages(userMessages)` -- publish user messages to channel (so all clients see them + they persist in history)
4. `turn.streamResponse(stream)` -- pipe LLM stream through encoder to channel
5. `turn.end(reason)` -- close the turn

Also handles **cancel routing**: client publishes a cancel signal, server transport matches it to the right turn and fires the abort signal.

**Client transport** manages conversation state: message list, conversation tree (branching), active turns, history. Subscribes to the Ably channel **before attaching** so no messages are lost. Two consumption patterns:
- `transport.on('message', ...)` + `transport.getMessages()` -- messages accumulate as tokens stream in
- `turn` exposes a `ReadableStream<TEvent>` for framework adapters (e.g. Vercel's `useChat`)

**The codec** (partially answers open questions from 1.1):
- `Codec<TEvent, TMessage>` is the interface that translates between domain types and Ably messages
- Four responsibilities: **Encoder** (domain events -> Ably operations), **Decoder** (Ably messages -> domain events), **Accumulator** (stream of events -> complete messages), **Terminal detection** (identifies finish/error/abort events)
- For Vercel: `TEvent` = `UIMessageChunk`, `TMessage` = `UIMessage`
- The generic transport knows nothing about frameworks -- codec is the only framework-specific piece

**Refined understanding of the encode/decode flow**:
- Server-side: LLM produces a stream of `TEvent`s -> encoder converts each into Ably message operations (publish/append/update) -> published to Ably channel
- Client-side: Ably channel subscription delivers messages -> decoder converts each Ably message back into `TEvent`s -> accumulator assembles events into complete `TMessage`s for the UI
- The transports orchestrate this: server transport abstracts publishing + turn lifecycle, client transport abstracts subscribing + state reassembly + conversation management
- ~~Still unknown: what "publish/append/update" means concretely, and how the encoder chooses between them~~ Answered in 1.5-1.7: publish creates a new message, appendMessage adds data to it (targeting by serial), updateMessage replaces content entirely (used for recovery). The encoder core maps startStream->publish, appendStream->appendMessage, closeStream->appendMessage with finished status.

**Entry point for custom codecs**: `@ably/ai-transport` (the generic core) -- this is what we'll use.

### The Turn Model

A **turn** is one request-response cycle: user sends a message, server streams a response. Every message on the channel belongs to exactly one turn. Turns are the unit of cancellation, lifecycle tracking, and concurrency.

**Turn identity**: Each turn has a unique `turnId` and an owning `clientId`.

**Server-side lifecycle** (explicit):
1. `newTurn({ turnId, clientId })` -- synchronous, creates turn and registers for cancel routing (cancel can arrive before `start()`)
2. `turn.start()` -- publishes turn-start event to channel
3. `turn.addMessages(userMessages)` -- publishes user messages so all clients see them + they persist in history
4. `turn.streamResponse(llmStream)` -- pipes LLM stream through encoder to channel; returns `StreamResult` with `reason`: `'complete'` | `'cancelled'` | `'error'`
5. `turn.end(reason)` -- publishes turn-end event

**Client-side lifecycle** (implicit): `send()`, `regenerate()`, or `edit()` create turns automatically. Returns an `ActiveTurn` with `turnId`, `stream` (ReadableStream of decoded events), and `cancel()`.

**Lifecycle events**: All clients on the channel receive `x-ably-turn-start` and `x-ably-turn-end` events regardless of who started the turn. Useful for loading indicators, multi-client coordination.

**Active turn tracking**: `transport.getActiveTurnIds()` returns `Map<clientId, Set<turnId>>`. React hook: `useActiveTurns(transport)`.

**Concurrent turns**: Multiple turns can be active on the same channel simultaneously. Each has its own stream, cancel handle, and lifecycle. Cancellation is scoped to individual turns.

**Abort signal flow** (cancel chain):
- Each server turn exposes `turn.abortSignal` (pass to LLM's `streamText()`)
- Cancel signal arrives -> `onCancel(request)` returns true/false (authorization gate) -> if true, `abortSignal` fires -> `onAbort(write)` runs (cleanup, can publish final events like `[generation cancelled]`) -> stream closes
- `onCancel` = "should this cancel be allowed?"; `onAbort` = "the cancel is happening, write any final data before closing"

**Open questions**:
- ~~Does a turn encompass multi-step tool calling, or is that handled within a single LLM stream?~~ Answered in 1.19: Tool calling happens within a single turn's LLM stream. The framework (e.g. Vercel's `streamText`) handles multi-step tool use automatically; the transport just streams whatever events the LLM produces. Tool input is streamed (start/delta/available), tool output is discrete.
- ~~What exactly does `addMessages` publish?~~ Answered in 1.11: publishes user messages through the codec encoder, each getting a generated `x-ably-msg-id` + transport headers. Per-message headers from the client can override (for optimistic reconciliation). Just the new messages, not history.

### The Codec Interface

The codec is the boundary between the transport layer and the domain (framework) layer. The full interface (current, includes `getMessageKey` being removed by PR #11):

```typescript
interface Codec<TEvent, TMessage> {
  createEncoder(channel: ChannelWriter, options?: EncoderOptions): StreamEncoder<TEvent, TMessage>;
  createDecoder(): StreamDecoder<TEvent, TMessage>;
  createAccumulator(): MessageAccumulator<TEvent, TMessage>;
  isTerminal(event: TEvent): boolean;
  getMessageKey(message: TMessage): string; // Being removed by PR #11
}
```

**Five responsibilities** (four after PR #11):
1. **`createEncoder`** -- maps domain events to Ably publish operations (server-side)
2. **`createDecoder`** -- converts inbound Ably messages to domain events/messages (client-side)
3. **`createAccumulator`** -- builds complete `TMessage`s from streaming `TEvent`s
4. **`isTerminal`** -- identifies events that signal stream completion (finish, error, abort) -- used by StreamRouter to auto-close per-turn streams
5. **`getMessageKey`** -- returns a stable identity key for a domain message -- used by ConversationTree for upsert

**Encoder architecture** (composition, not inheritance):
```
Domain Encoder (e.g. UIMessageEncoder)
  └── EncoderCore
        └── ChannelWriter (Ably channel)
```
The domain encoder maps framework events to four core operations:
- `core.startStream(id, { name })` -- for stream-start events (e.g. `text-start`)
- `core.appendStream(id, delta)` -- for deltas (e.g. `text-delta`)
- `core.closeStream(id, payload)` -- for stream-end events (e.g. `text-end`)
- `core.publishDiscrete(payload)` -- for standalone events (e.g. `start`, `finish`, `error`, `tool-output-*`)

The EncoderCore handles all Ably-specific concerns: serial tracking, append queuing, flush/recovery, header persistence.

**Decoder architecture** (hooks into a core):
```
DecoderCore
  ├── buildStartEvents(tracker)    → domain-specific start events
  ├── buildDeltaEvents(tracker, δ) → domain-specific delta events
  ├── buildEndEvents(tracker, h)   → domain-specific end events
  └── decodeDiscrete(payload)      → domain-specific messages/events
```
The DecoderCore handles action dispatch, serial tracking, prefix-match accumulation. The hooks transform stream state into domain events without knowing about Ably message actions.

**Accumulator** (`MessageAccumulator<TEvent, TMessage>`):
- Assembles complete `TMessage`s from streaming `TEvent` fragments (a `text-delta` alone is meaningless)
- Assembly logic is codec-specific, so the codec must provide it
- A single turn can produce multiple messages (e.g. user message + assistant message)
- Two properties for different contexts:
  - `messages` -- all messages including in-progress (used during live streaming)
  - `completedMessages` -- only fully terminated messages (used for history)
- `hasActiveStream` -- whether any message is still receiving data
- Does NOT own message identity -- transport assigns `x-ably-msg-id` and headers; accumulator builds the domain object

**Lifecycle tracker**: Handles mid-stream joins. When a client connects mid-stream, the decoder sees deltas without the preceding start. The tracker synthesizes missing codec-level phases so the framework's lifecycle is complete (e.g. synthesizes a `start` chunk for Vercel).

**Vercel codec event mapping** (reference for building Anthropic codec):
- Streaming events (`text-start/delta/end`, `tool-input-start/delta/available`) -> core stream operations
- Discrete events (`start`, `finish`, `error`, `tool-output-*`, `data-*`) -> `publishDiscrete`
- Uses `x-domain-*` headers for Vercel-specific metadata (id, toolCallId, providerMetadata, finishReason, error, data)

**Steps to write a new codec** (the recipe):
1. Define `TEvent` and `TMessage` for the framework -- use the framework's own types if available (e.g. Vercel exports `UIMessageChunk` and `UIMessage`), don't redefine
2. Implement encoder -- map domain events to core operations
3. Implement decoder hooks -- build domain events from stream tracker state
4. Implement accumulator -- build complete messages from decoder outputs
5. Implement `isTerminal` -- identify stream-ending events
6. ~~Implement `getMessageKey` -- stable message identity~~ **Being removed by PR #11** (see Issues #1)

### Encoder

The EncoderCore (`src/core/codec/encoder.ts`) translates domain events into Ably publish operations. Domain codecs never interact with Ably directly -- they call core methods.

**Two message modes**:
- **Discrete**: `publishDiscrete(payload)` -- single immutable Ably message with `x-ably-stream: "false"`. For complete units: user messages, tool output, lifecycle events. Also `publishDiscreteBatch(payloads)` for atomic multi-message publish.
- **Streamed**: Uses Ably's message append lifecycle. A single Ably message is created, then progressively appended to:
  ```
  startStream(id, payload)   →  channel.publish()        x-ably-status: streaming
  appendStream(id, data)     →  channel.appendMessage()   (delta)
  appendStream(id, data)     →  channel.appendMessage()   (delta)
  closeStream(id, payload)   →  channel.appendMessage()   x-ably-status: finished
  ```

**Stream lifecycle details**:
- `startStream`: publishes initial message, captures the Ably `serial` (identifies message for all subsequent appends). Initializes a tracker with serial, accumulated text, and persistent headers.
- `appendStream`: fire-and-forget append of a text delta. Accumulated text grows with each append (used for recovery). Promises collected but not awaited -- errors batched and handled at flush.
- `closeStream`: final append with `x-ably-status: "finished"` + closing headers. Then flushes all pending appends.
- `abortStream`/`abortAllStreams`: append with `x-ably-status: "aborted"` + empty data. No need to flush before abort -- serial ordering guarantees abort follows content appends. Single flush at end waits for everything.

**Recovery mechanism**: Since appends are fire-and-forget, some may fail (network, rate limits). On flush (`closeStream`/`abortStream`), `_flushPending()` does `Promise.allSettled` on all collected promises. For failures: builds a recovery message with the **full accumulated text** (not just the failed delta) and calls `channel.updateMessage()` to replace the entire message content. Result: even if intermediate appends are lost, the final message is correct. The decoder handles this via prefix-match logic.

**Header merging** (priority order, later wins):
1. `defaultExtras` -- encoder-level defaults
2. Per-write overrides
3. Codec headers from payload

The `onMessage` hook runs as post-processing -- transport uses it to stamp transport-level headers (turn ID, role, parent, fork-of) without the codec knowing.

**Closing appends repeat all headers**: Ably replaces the entire `extras` object on each append, so the closing append starts from `persistentHeaders` (captured at `startStream`) and layers overrides on top.

**ChannelWriter interface**: Encoder writes through `ChannelWriter` (publish, appendMessage, updateMessage), not directly to `Ably.RealtimeChannel`. Enables mock testing. `Ably.RealtimeChannel` satisfies the interface directly.

### Decoder

The DecoderCore (`src/core/codec/decoder.ts`) converts inbound Ably messages into domain events. Handles all four Ably message actions, tracks stream state via serials, and delegates to codec-provided hooks.

**Action dispatch** -- `decode()` switches on `message.action`:
| Action | Meaning | Handling |
|---|---|---|
| `message.create` | New message | If `x-ably-stream: "true"` -> start tracking stream. If `"false"` -> `decodeDiscrete()` |
| `message.append` | Delta appended | Look up tracker by serial, accumulate delta, check terminal status |
| `message.update` | Content replaced | First-contact (new tracker + synthesize events) or prefix-match on existing |
| `message.delete` | Message deleted | Fire `onStreamDelete`, mark closed |

**Stream tracker** -- per streamed message, keyed by serial:
- `name`: Ably message name (e.g. "text", "tool-input")
- `streamId`: from `x-ably-stream-id` header
- `accumulated`: full text so far
- `headers`: current headers
- `closed`: whether finished/aborted

**Domain hooks** (what a codec provides):
| Hook | When | Returns |
|---|---|---|
| `buildStartEvents(tracker)` | New stream starts | Start events (e.g. `text-start`) |
| `buildDeltaEvents(tracker, delta)` | Delta received | Delta events (e.g. `text-delta`) |
| `buildEndEvents(tracker, closingHeaders)` | Stream finishes | End events (e.g. `text-end`, `finish`) |
| `decodeDiscrete(payload)` | Discrete message received | Events or complete messages |

Hooks return `DecoderOutput<TEvent, TMessage>[]` -- either `{ kind: 'event', event }` or `{ kind: 'message', message }`.

**Append handling**: Look up tracker by serial -> extract delta from `message.data` -> accumulate (`tracker.accumulated += delta`) -> call `buildDeltaEvents()` -> check `x-ably-status`: `"finished"` calls `buildEndEvents()` + marks closed; `"aborted"` marks closed (no end events).

**Update handling** -- two scenarios:
- **First-contact**: No tracker exists (stream started before subscription -- history, reconnect). Creates tracker with full data, synthesizes start/delta/end events as appropriate. This is how late-joining clients reconstruct complete event sequences.
- **Known serial, prefix-match**: Tracker exists. If incoming data starts with accumulated text, extract new delta. If not (full replacement from encoder recovery), replace tracker state and fire `onStreamUpdate`.

**Delete handling**: Fire callback, mark closed, emit no events -- transport handles removal from conversation tree.

**Message ID tagging**: After decoding, every event output is tagged with `x-ably-msg-id` from headers. The accumulator uses this to route events to the correct in-progress domain message.

**Decoder output routing**:
- `kind: 'event'` -> stream router (own turn) or accumulator (observer turn)
- `kind: 'message'` -> directly to conversation tree

### Wire Protocol

Every Ably message carries headers in `extras.headers`. Two namespaces, two message types.

**Two header namespaces**:
- `x-ably-*` (transport headers): turn correlation, stream lifecycle, cancellation, branching. Owned by transport layer, codec never reads/writes these.
- `x-domain-*` (domain headers): framework-specific metadata (IDs, tool call IDs, provider metadata, etc.). Owned by codec layer, transport passes through without interpreting.

Key transport headers: `x-ably-stream` (true/false), `x-ably-status` (streaming/finished/aborted), `x-ably-stream-id`, `x-ably-turn-id`, `x-ably-msg-id`, `x-ably-role` (user/assistant), `x-ably-parent` (linear parent msg-id), `x-ably-fork-of` (replaced msg-id for branching), cancel headers (`x-ably-cancel-turn-id`, `x-ably-cancel-own`, `x-ably-cancel-client-id`, `x-ably-cancel-all`), `x-ably-turn-reason`.

**Lifecycle events** (transport-level, no data payload):
- `x-ably-turn-start` (server -> channel): turn started
- `x-ably-turn-end` (server -> channel): turn ended + reason
- `x-ably-cancel` (client -> channel): cancel request with filter headers
- `x-ably-abort` / `x-ably-error` (server -> channel): transport-level signals

**Content messages** -- two types:
- **Discrete**: single immutable `message.create` with `x-ably-stream: "false"`. For user messages, tool output, lifecycle events.
- **Streamed**: Ably message that evolves via create/append/close actions with `x-ably-stream: "true"`. Lifecycle: `message.create` (streaming) -> `message.append` (deltas) -> `message.append` (finished or aborted).

**Turn lifecycle on the wire** (complete sequence):
1. `x-ably-turn-start`
2. `message.create` (user messages, role: user)
3. `message.create` (streaming) -> `message.append` (deltas) -> `message.append` (finished)
4. `x-ably-turn-end` (complete)

**Message identity (`x-ably-msg-id`)**: Every domain message gets a UUID. Generated by client (for optimistic user messages) or server (for relayed user messages and assistant responses). For streamed messages, the msg-id is in persistent headers so every append carries it -- single identity for the whole lifecycle.

**Optimistic reconciliation**: Client inserts optimistic message (no serial) on `send()`, records msg-id. Server relays the message to channel. Client matches by msg-id and promotes the serial (no duplicate).

**Branching headers**: `x-ably-parent` = preceding message (linear order). `x-ably-fork-of` = message being replaced (creates sibling group in conversation tree). Used by `regenerate()` and `edit()`.

### Headers

Mostly API-level detail for the header utilities. Key takeaways:

**Two utility sets** for codecs: `headerWriter()` (fluent builder, auto-prefixes keys with `x-domain-`) and `headerReader()` (typed accessor, auto-strips prefix). Methods: `str()`, `bool()`, `json()` for common types. Codecs work with unprefixed keys (e.g. `toolCallId` not `x-domain-toolCallId`).

**Transport headers** are built by `buildTransportHeaders` in `src/core/transport/headers.ts` -- codec code never touches these.

**For our codec**: We'll use `headerWriter`/`headerReader` to define Anthropic-specific `x-domain-*` headers (e.g. tool use IDs, model metadata, stop reasons). The utilities handle serialization and prefix management automatically.

### Message Lifecycle

Ties together decoder, accumulator, conversation tree, and React hooks into one flow.

**TEvent vs TMessage clarified**:
- `TEvent` = streaming fragment, individually meaningless (e.g. a text delta). Unit of real-time streaming.
- `TMessage` = complete domain message, fully formed. Unit of state -- what the tree stores, `getMessages()` returns, hooks render.
- Encoding: `TMessage` -> discrete Ably publishes; `TEvent` -> streamed Ably operations.
- Decoding: Ably messages -> `DecoderOutput` (either `{ kind: 'event', event: TEvent }` or `{ kind: 'message', message: TMessage }`).
- Accumulation bridges `TEvent -> TMessage`.

**Data flow** (Ably channel -> UI):
```
Channel -> Decoder -> DecoderOutput[] -> routing by turn ownership:
  Own turn:      events -> StreamRouter (ReadableStream) + Accumulator -> Tree.upsert()
  Observer turn: events -> Accumulator -> Tree.upsert()
  Discrete msg:  -> Tree.upsert() directly
Tree -> flatten() -> getMessages() -> React hooks -> UI
```

**Own turn vs observer turn routing**:
- **Own turn** (this client called `send()`): decoded events go to BOTH the StreamRouter (produces `ReadableStream<TEvent>` for framework adapters like Vercel's `useChat`) AND a per-turn accumulator (builds `TMessage`s, upserts to tree on every event).
- **Observer turn** (another client's turn): events go to accumulator only. No stream because no caller holds a handle.
- Both paths use the same `_accumulateAndEmit()` method internally.
- Discrete messages (`kind: 'message'`) bypass both and go directly to tree.

**Why own turns have a ReadableStream**: Primarily an integration seam for framework adapters (e.g. `useChat` expects a stream). For most app code, `getMessages()`/`on('message')` is the right path -- same granularity (updates on every event), simpler API.

**Accumulator -> tree flow**: On every event: feed to accumulator -> read `accumulator.messages` -> `structuredClone` snapshot -> `tree.upsert()`. Tree always has the latest partial state.

**History hydration** uses a separate pipeline:
1. Fetch raw Ably messages from channel history (newest-first)
2. Reverse to chronological, decode through fresh decoder
3. Group by `x-ably-turn-id`, each turn gets its own accumulator (prevents interleaved turns corrupting each other)
4. Read `completedMessages` (not `messages`) -- only fully terminated messages
5. Upsert into tree via `_processHistoryPage()`

**No cached message list**: `flatten()` rebuilds from tree on every call. Deliberate tradeoff -- no cache invalidation, cheap for conversation-sized lists (tens to low hundreds).

### Client Transport

`DefaultClientTransport` (`src/core/transport/client-transport.ts`) -- manages the full client-side conversation lifecycle over a single Ably channel.

**Composition**: ConversationTree + StreamRouter + StreamDecoder + EventEmitter + per-turn state maps. Subscribes before channel attach (RTL7g) to guarantee no messages missed.

**`send()` flow** (primary entry point):
1. Generate turn ID + per-message msg-ids (UUIDs)
2. Auto-compute parent from last message in flattened tree (if no explicit parent/forkOf)
3. Optimistic insert into conversation tree immediately (visible to `getMessages()` before server ack)
4. Create ReadableStream via stream router (controller captured synchronously)
5. Fire-and-forget HTTP POST (not awaited -- errors surfaced via `error` event)
6. Return `ActiveTurn { stream, turnId, cancel() }` synchronously

POST body: `{ history, messages (with headers), turnId, clientId }`.

Multi-message sends are chained: each message after the first uses the previous msg-id as parent -> linear thread.

**Client never publishes domain messages to the channel directly** -- only the server does. The client sends via HTTP POST, server relays to channel. Channel subscription is the sole source of truth.

**Optimistic reconciliation**: Own messages relayed from server are matched by `x-ably-msg-id` against `_ownMsgIds` set. On match, upsert with server serial triggers serial promotion in tree (optimistic entry moves to correct position).

**Message routing** (`_handleMessage`):
- Turn lifecycle events (`turn-start`/`turn-end`): record client ID, emit `turn` event, clean up state
- Codec-decoded messages: route by kind (`message` -> tree upsert; `event` -> stream router + accumulator for own turns, accumulator only for observer turns)

**Observer state** (`TurnObserverState`): headers (accumulate, later overrides earlier), serial (advances on every event), accumulator (builds `TMessage`s). Upserts snapshot to tree on every event.

**`regenerate(msgId)` and `edit(msgId, newMessages)`**: Convenience methods that delegate to `send()` with computed `forkOf`, `parent`, and truncated history.

**`cancel(filter?)`**: Publishes cancel to channel + closes matching local streams. Default filter: `{ own: true }`. Late server events still accumulated (observer state not cleared until `turn-end`).

**`history()`**: Loads older messages via `untilAttach` for gapless continuity. Withholding mechanism: newest batch shown immediately, older batches buffered for subsequent `next()` calls (prevents UI jump).

**`close()`**: Optional cancel publish, unsubscribe, close streams, clear all state. After close, turn-creating methods throw `TransportClosed`.

**Events**: `message` (tree changed), `turn` (start/end), `error` (non-fatal, e.g. POST failure), `ably-message` (raw Ably message).

### Server Transport

`DefaultServerTransport` (`src/core/transport/server-transport.ts`) -- handles server-side turn lifecycle. Composes a TurnManager + codec encoder. Much simpler than the client transport.

**Construction**: Creates TurnManager, subscribes to `x-ably-cancel` events on the channel (before attach per RTL7g). This cancel subscription is the transport's only subscription -- it doesn't subscribe to its own output.

**`newTurn(opts)`**: Synchronous. Creates `Turn` object + `AbortController`, registers for cancel routing immediately. Exposes `turn.abortSignal` for passing to LLM calls.

**`turn.start()`**: Publishes `x-ably-turn-start`. Must be called before `addMessages()` or `streamResponse()`.

**`turn.addMessages(inputs)`** (answers open question from 1.3): Publishes user messages through the codec encoder. Each message gets a generated `x-ably-msg-id`, transport headers (role, turn ID, parent, forkOf). Per-message headers from the client override transport defaults -- this is how the client's optimistic msg-id passes through for reconciliation. Returns effective msg-ids.

**`turn.streamResponse(llmStream)`**: Pipes a `ReadableStream<TEvent>` through the codec encoder to the channel via `pipeStream`. Headers: `role: 'assistant'` + branching metadata. Abort signal propagates for cancel. Returns `{ reason }`: `'complete'` | `'cancelled'` | `'error'`. Does NOT call `end()` -- caller must do that.

**`turn.end(reason)`**: Publishes `x-ably-turn-end`, unregisters from cancel routing. Idempotent.

**Cancel routing**: Handled directly by the transport. Turns registered on `newTurn()` (before `start()`). `onCancel` hook can reject. Throwing handlers don't prevent other turns from being cancelled (isolated). Uses sender's `clientId` from Ably message for `own` filter.

**`close()`**: Unsubscribes, aborts all active turns, clears registrations. Existing turns can still `end()` but no new turns created.

**Error handling**: Transport-level (`options.onError`) for cancel/attach failures. Turn-level (`turnOptions.onError`) for publish/encoding errors, falls back to transport-level.

### Transport Sub-Components

Four focused components, each handling one concern.

**StreamRouter** (client-side, `src/core/transport/stream-router.ts`):
- Maps decoded events to per-turn `ReadableStream` instances for own turns
- `createStream(turnId)` captures controller synchronously (WHATWG spec guarantees `start()` runs sync -- no async gap for lost events)
- `route(turnId, event)` enqueues event; if `isTerminal(event)` (codec-provided predicate), auto-closes stream after enqueueing
- Own-turn events go to both stream router AND accumulator; observer-turn events go to accumulator only

**TurnManager** (server-side, `src/core/transport/turn-manager.ts`):
- Tracks active turns, publishes lifecycle events (`x-ably-turn-start`, `x-ably-turn-end`)
- Each turn gets its own `AbortController` -- signal passed to LLM call and `pipeStream`
- Cancel signal -> abort controller -> abort signal -> stream reader stops -> encoder aborts
- Publishes `x-ably-turn-end` before deleting local state (allows retry on publish failure)

**pipeStream** (server-side, `src/core/transport/pipe-stream.ts`):
- Pure function: reads `ReadableStream`, writes through encoder, handles abort/error
- Core loop: `race(reader.read(), abortPromise)` -> aborted? -> `onAbort()` then `encoder.abort()` | done? -> `encoder.close()` | value? -> `encoder.appendEvent(value)`
- `onAbort` callback lets server write final events before close
- Returns `{ reason: 'complete' | 'cancelled' | 'error' }`

**buildTransportHeaders** (shared, `src/core/transport/headers.ts`):
- Builds `x-ably-*` headers for a message (role, turnId, msgId, turnClientId, parent, forkOf)
- Used by both server transport (`addMessages`, `streamResponse`) and client transport (optimistic stamping)

**Cancel routing** (in server transport, not a separate component):
- Subscribes to `x-ably-cancel` on channel construction
- Parses cancel filter headers -> resolves matching turns -> calls `onCancel` hook -> if allowed, fires `abort()`
- Each turn's cancel isolated in try/catch

### Conversation Tree

`src/core/transport/conversation-tree.ts` -- materializes a branching conversation from a flat stream of Ably messages. Single source of truth for conversation state.

**Ordering**: Serial-first. Serial-bearing messages sort lexicographically by Ably serial. Null-serial messages (optimistic inserts) sort after all serial-bearing, ordered by insertion sequence. Serial order is Ably's acceptance order, not delivery order.

**Data structures**: `_nodeIndex` (Map<msgId, Node>, primary), `_sortedList` (all nodes sorted by serial), `_parentIndex` (Map<parentId, Set<msgId>>), `_selections` (Map<groupRootId, index>). Note: `_codecKeyIndex` exists currently but is being removed by PR #11.

**ConversationNode**: `{ message: TMessage, msgId, parentId?, forkOf?, headers, serial? }`

**Upsert** (the only mutation):
- Insert: create node, add to indexes, binary search insert into sorted list (or append for null-serial)
- Update: update message/headers in place. If serial provided and node has none -> serial promotion: remove from sorted list, re-insert at correct position. This handles optimistic -> relay transition.

**Sibling groups** (branching): Messages forking the same target form a sibling group. Found by following `forkOf` chain to the group root (original message). Selection: each group has a selected index (default: last = most recent). `select(msgId, index)` changes active sibling.

**`flatten()`**: Walks sorted list, produces linear message sequence for currently selected branches:
1. Check parent reachability (is parent on current path?)
2. Check sibling selection (is this the selected sibling?)
3. If both pass: add to path, mark as reachable

Resolved groups cached per `flatten()` call to avoid re-resolution.

**Delete**: Removes from all indexes. Children NOT cascade-deleted -- they become unreachable in `flatten()` because parent is gone. Preserves undo capability.

**Example**: User asks "2+2?", gets "4" (m2). Regenerate m2 -> gets "Four" (m3, forkOf: m2). Sibling group [m2, m3], default selection: m3 (latest). `flatten()` -> ["2+2?", "Four"]. `select(m2, 0)` -> `flatten()` -> ["2+2?", "4"].

### History Hydration

`decodeHistory` (`src/core/transport/decode-history.ts`) -- loads conversation history from Ably's history API into domain messages.

**The problem**: Ably history is newest-first, decoder needs oldest-first (stream accumulation needs create before appends). A single domain message may span 100+ Ably messages (create + N appends + close). `limit` should control domain messages, not wire messages.

**Strategy -- collect and re-decode**: Fetch page -> append to collection -> reverse to chronological -> fresh decoder decodes all from beginning -> count completed messages -> if not enough, fetch next page and repeat. Simple, correct, handles page-boundary splits and concurrent turn interleaving.

**Per-turn accumulators**: Messages grouped by `x-ably-turn-id`, each turn gets its own accumulator (prevents cross-turn corruption). Reads `completedMessages` (not `messages`) -- only fully terminated messages appear in results.

**Pagination**: `limit` controls completed domain messages per page. Internally fetches `limit * 10` Ably messages per page (heuristic for many-to-one ratio). `hasNext()`/`next()` for cursor-based traversal.

**`untilAttach: true`**: Guarantees no gap between history and live subscription -- history ends exactly where subscription starts.

**Shared state across pages**: `HistoryState` persists raw messages, returned count, and Ably page cursor across `next()` calls. Re-decodes or slices from existing decoded set.

**For our codec**: History hydration is generic -- uses the codec's decoder and accumulator via interfaces. No modifications needed.

### Lifecycle Tracker

`src/core/codec/lifecycle-tracker.ts` -- ensures required lifecycle events are emitted before content events, even on mid-stream joins.

**The problem**: Decoder handles stream-level reconstruction (start -> delta -> end) via first-contact. But higher-level message lifecycle events (e.g. `start`, `start-step`) are discrete events that may have already been published and missed. Without them, the accumulator can't create a message container and drops events.

**Solution**: Generic tracker configured with ordered phases. Each phase has a key and a build function that produces synthetic events. Phases are scoped by turn ID.

**API**:
- `ensurePhases(scopeId, context)` -- returns synthetic events for any missing phases, marks them emitted. Subsequent calls return empty array.
- `markEmitted(scopeId, phaseKey)` -- marks phase as received from wire (prevents re-synthesis)
- `resetPhase(scopeId, phaseKey)` -- resets for re-emission (repeating phases, e.g. `start-step` after `finish-step` in multi-step turns)
- `clearScope(scopeId)` -- frees memory on turn completion

**Vercel usage** (two phases: `start`, `start-step`):
- Before every streamed event: `ensurePhases` prepends missing lifecycle events
- On real `start`/`start-step`: `markEmitted` prevents duplication
- On `finish-step`: `resetPhase('start-step')` for next step
- On `finish`/`abort`: `clearScope`

**For our codec**: The tracker is generic -- we configure it with Anthropic-specific phases. If Anthropic's streaming has lifecycle events that must precede content (e.g. `message_start`, `content_block_start`), we define those as phases. The tracker handles mid-stream joins automatically.

### ChatTransport (Vercel useChat adapter)

`src/vercel/transport/chat-transport.ts` -- thin adapter wrapping core `ClientTransport` to satisfy Vercel's `ChatTransport` interface for `useChat`. Vercel-specific, not relevant to generic codec work.

**Why it exists**: `useChat` manages message state internally and calls `sendMessages` with the full message array + a trigger. The adapter translates this to the core transport's `send()`.

**`sendMessages`**: Splits message array by trigger:
- `submit-message`: last message is new, rest is history
- `regenerate-message`: no new messages, full array is history. Looks up target in conversation tree for `forkOf`/`parent`.

**Key trick -- empty stream return**: Returns an empty stream that closes when the turn ends, NOT the real event stream. This is because `useMessageSync` already pushes transport state into `useChat` via `setMessages`. Returning the real stream would cause duplicate accumulation.

**`reconnectToStream`**: Returns `null`. The core transport's channel subscription + decoder first-contact handles reconnection automatically.

**For our codec work**: This is a framework-specific adapter layer. If Anthropic has a similar hook-based UI library, we'd write an equivalent adapter. But the core transport handles the real work -- the adapter is thin.

### Vercel Codec (Reference Implementation)

`src/vercel/codec/` -- concrete implementation mapping `UIMessageChunk` events / `UIMessage` objects to Ably. Three files: encoder, decoder, accumulator.

#### Encoder (`encoder.ts`)

Two write paths:

**Streaming events (`appendEvent`)** -- each `UIMessageChunk` maps to exactly one core operation:
- Stream start (`text-start`, `reasoning-start`, `tool-input-start`) -> `core.startStream(id, { name })`
- Stream delta (`text-delta`, `reasoning-delta`, `tool-input-delta`) -> `core.appendStream(id, delta)`
- Stream end (`text-end`, `reasoning-end`, `tool-input-available`) -> `core.closeStream(id, payload)`
- Lifecycle (`start`, `start-step`, `finish-step`, `finish`, `error`, `abort`) -> `core.publishDiscrete(payload)`
- Tool lifecycle, content, custom data -> `core.publishDiscrete(payload)`

Domain headers passed to every operation. Start headers become persistent (repeated on every append). Closing headers merged on top.

**Complete messages (`writeMessages`)** -- encodes `UIMessage[]` as discrete publishes (for user messages via `addMessages`). Each message is split into per-part Ably messages sharing `x-domain-messageId`:
- `text` part -> name `"text"`, data: `part.text`
- `file` part -> name `"file"`, data: `part.url`
- `data-*` part -> name: part's type string, data: `part.data`
- No encodable parts -> single `text` message with empty data (placeholder)

**Abort handling**: On `abort` chunk, abort all in-progress streams then publish discrete `abort` event. `_aborted` flag prevents double-abort.

#### Decoder (`decoder.ts`)

Four hooks into the decoder core:

**`buildStartEvents`/`buildDeltaEvents`/`buildEndEvents`** -- reconstruct `UIMessageChunk` from stream tracker state + domain headers:
- Name `"text"` -> `text-start`/`text-delta`/`text-end`
- Name `"reasoning"` -> `reasoning-start`/`reasoning-delta`/`reasoning-end`
- Name `"tool-input"` -> `tool-input-start`/`tool-input-delta`/`tool-input-available`
- Start hooks call `ensurePhases` on lifecycle tracker for mid-stream joins
- End: `tool-input-available` parses accumulated JSON for final tool input

**`decodeDiscrete`** -- two categories:
- **Message parts** (identified by `x-ably-role` header): reconstructed into single-part `UIMessage` objects. Tree merges parts sharing same `x-ably-msg-id`.
- **Lifecycle events** (dispatched by Ably message name): `start`, `start-step`, `finish-step`, `finish`, `error`, `abort`, tool events, `data-*`. Each interacts with lifecycle tracker (mark emitted, reset phase, clear scope).

**Non-streaming tool calls**: When `tool-input-available` arrives with no stream tracker, decoder emits `tool-input-start` + `tool-input-available` in sequence (preceded by any missing lifecycle phases).

#### Accumulator (`accumulator.ts`)

Builds and maintains `UIMessage[]` from decoder outputs. Groups streaming events into messages using lifecycle boundaries (`start`/`finish`). Multiple messages can be in-progress concurrently (identified by `messageId` from `x-ably-msg-id`).

**Per-message state**:
- `textStreams` / `reasoningStreams` -- `DeltaStreamTracker` mapping stream IDs to part indices
- `toolTrackers` -- per-toolCallId tracker with accumulated input and part index
- `streamStatus` -- per-stream status (streaming/finished/aborted)

**Event processing** (key mappings):
| Event | Accumulator action |
|---|---|
| `start` | Create/locate message, set messageId + metadata |
| `text-start`/`reasoning-start` | Push empty part, register stream |
| `text-delta`/`reasoning-delta` | Append to registered part's text |
| `text-end`/`reasoning-end` | Mark stream finished |
| `tool-input-start` | Push `dynamic-tool` part in `input-streaming` state |
| `tool-input-delta` | Accumulate JSON fragment, attempt parse, update part |
| `tool-input-available` | Set final parsed input, transition to `input-available` |
| `tool-output-available` | Transition to `output-available` |
| `finish-step` | Reset stream trackers for next step |
| `finish` | Set final metadata, remove from active |
| `abort` | Mark all streaming parts aborted, remove from active |
| `message` (complete) | Push directly to list |

#### Key patterns for Anthropic codec design

1. **Event categorization**: Every framework event maps to exactly one core operation. The mapping is a big switch/if-else.
2. **Domain headers carry all framework-specific metadata**: IDs, tool call IDs, provider metadata, finish reason. Passed on start (persistent) and close (override).
3. **`writeMessages` splits per-part**: A single domain message may become multiple Ably messages. Shared identity via domain header.
4. **Accumulator is the most complex piece**: Tracks multiple concurrent streams, handles partial state, manages per-stream status. This is where framework-specific message assembly logic lives.
5. **Lifecycle tracker integration**: Decoder hooks call `ensurePhases` before content, `markEmitted` on real events, `resetPhase` on step boundaries, `clearScope` on finish/abort.
6. **Non-streaming fallback**: Some events that are normally streamed can arrive as discrete messages. Decoder handles both paths.

### Remaining Docs (1.18-1.21)

**Glossary (1.18)**: Formalizes all the terms we've already encountered. No new concepts, but confirms our understanding. Notable: "codec key" is documented but being removed by PR #11.

**Features (1.19)** -- all features are transport-level, codec-agnostic:
- **Streaming**: Message appends persist accumulated text, so reconnecting/late-joining clients get the full response from history. This is a key Ably advantage.
- **Tool calls**: Tool events flow through the transport like any other streaming content. The transport doesn't orchestrate tools -- the LLM framework handles execution, transport just delivers. Tool input is streamed (start/delta/available), tool output is discrete. **This answers the open question from 1.3**: tool calling happens within a single turn's LLM stream (e.g. Vercel's `streamText` handles multi-step tool use automatically). The transport just streams whatever events the LLM produces.
- **Cancel**: Channel-level operation. Client publishes cancel signal, server receives and aborts matching turns. Full chain already documented in 1.3/1.12.
- **Interruption**: User sends a new message while AI is streaming. Creates a new concurrent turn. Two patterns: cancel-then-send, or send-alongside (both turns stream concurrently).
- **Branching**: Tree-based history with regenerate/edit creating sibling groups. Already documented in 1.13.
- **History**: Channel-persisted, codec-decoded. Already documented in 1.14.
- **Multi-client sync**: All clients on same channel see same conversation. Own turns vs observer turns. Already documented in 1.9.
- **Optimistic updates**: Automatic, no opt-in. Already documented in 1.7/1.10.
- **Concurrent turns**: Multiple turns active simultaneously, each with own stream/cancel/lifecycle. Already documented in 1.3.

**Vercel AI SDK framework guide (1.20)**: Two integration paths:
1. **useChat path** (simpler): `useChatTransport` + `useMessageSync` + Vercel's `useChat`. Transport delivers messages over Ably instead of HTTP.
2. **Generic hooks path** (more control): `useClientTransport` + `useConversationTree` + `useSend` etc. Full branching UI, custom message construction.

Server code is the same for both: `createServerTransport` + pipe `streamText().toUIMessageStream()` through a turn.

**Relevant for Anthropic**: We'd follow the same two-path pattern. The generic hooks path works out of the box with any codec. If Anthropic has a `useChat`-equivalent, we'd build an adapter like `ChatTransport`.

**Error codes (1.21)**: 7 codes total (2 standard Ably + 5 custom 104xxx). All transport-level. No codec-specific error codes exist -- codecs don't define their own errors. If our Anthropic codec encounters framework-specific errors, they'd flow through the existing `error` event type.

**React hooks reference (1.21)**: All generic hooks are parameterized by `<TEvent, TMessage>` -- they work with any codec. Key hooks: `useClientTransport`, `useMessages`, `useSend`, `useRegenerate`, `useEdit`, `useActiveTurns`, `useHistory`, `useConversationTree`. Vercel-specific: `useChatTransport`, `useMessageSync`. **For Anthropic**: The generic hooks work immediately with a new codec. If we build Anthropic-specific React integration, we'd only add hooks equivalent to the Vercel-specific ones.

---

## Commit Review Notes

> Notes from reviewing each implementation commit. Focus on "what was added", "key design decisions", and "things to watch out for".

### 2.1 -- Core Encoder & Decoder (`7d6e3f1`)

**3,145 lines added.** Establishes the generic codec core -- the foundation everything else builds on.

**Files**: `src/core/codec/` (types.ts, encoder.ts, decoder.ts, lifecycle-tracker.ts, index.ts), `src/constants.ts`, `src/utils.ts`, `src/errors.ts`, plus tests.

**Key types in `types.ts`** (the Codec contract):
- `ChannelWriter` -- the I/O interface (publish, appendMessage, updateMessage). Ably channel satisfies it directly.
- `WriteOptions` -- per-write overrides (clientId, extras, messageId)
- `MessagePayload` -- codec-agnostic description of a discrete message (name, data, headers)
- `StreamPayload` -- like MessagePayload but data must be string (for append/accumulate semantics)
- `StreamTrackerState` -- decoder's per-stream state (name, streamId, accumulated, headers, closed)
- `DiscreteEncoder<TEvent, TMessage>` -- stateless publish operations (writeMessage, writeMessages, writeEvent). Used by client transport.
- `StreamEncoder<TEvent, TMessage>` extends DiscreteEncoder -- adds `appendEvent()` and `close()`. Used by server transport.
- `DecoderOutput<TEvent, TMessage>` -- union: `{ kind: 'event', event, messageId? }` | `{ kind: 'message', message }`
- `StreamDecoder<TEvent, TMessage>` -- `decode(message) -> DecoderOutput[]`
- `MessageAccumulator<TEvent, TMessage>` -- processOutputs, updateMessage, messages, completedMessages, hasActiveStream
- `Codec<TEvent, TMessage>` -- createEncoder, createDecoder, createAccumulator, isTerminal, getMessageKey

**EncoderCore** (what domain encoders call):
- `publishDiscrete(payload)` / `publishDiscreteBatch(payloads)` -- discrete messages
- `startStream(streamId, payload)` -- opens a streamed message
- `appendStream(streamId, data)` -- fire-and-forget delta append
- `closeStream(streamId, payload)` -- close with finished status + flush
- `abortStream(streamId)` / `abortAllStreams()` -- abort + flush
- `close()` -- flush + clear. Factory: `createEncoderCore(writer, options)`

**DecoderCore** (what domain decoders provide hooks to):
- Hooks: `buildStartEvents(tracker)`, `buildDeltaEvents(tracker, delta)`, `buildEndEvents(tracker, closingHeaders)`, `decodeDiscrete(input)`
- Options: `onStreamUpdate` callback, `onStreamDelete` callback
- Factory: `createDecoderCore(hooks, options)`
- `decode()` switches on `message.action`: create, append, update, delete

**Constants** (`constants.ts`): All `x-ably-*` header constants, message/event names. Both codec and transport layers reference these.

**Observations**:
- Clean separation: encoder core handles Ably primitives, domain encoder handles event classification
- `DiscreteEncoder` vs `StreamEncoder` split is smart -- client only needs discrete, server needs both
- `eventOutput()` helper wraps a domain event as `DecoderOutput[]` -- used constantly by decoder hooks
- Spec points referenced throughout (e.g. `AIT-CD1`, `AIT-CD7`)
- Tests cover all paths: stream lifecycle, error handling, callback isolation, edge cases (548 + 579 lines)

### 2.2 -- Vercel Codec (`c583bf3`)

**3,475 lines added.** The reference implementation: `UIMessageCodec` implementing `Codec<UIMessageChunk, UIMessage>`.

**Files**: `src/vercel/codec/` (encoder.ts, decoder.ts, accumulator.ts, index.ts) + comprehensive tests.

**Codec entry point** (`index.ts`) -- remarkably simple:
```typescript
export const UIMessageCodec: Codec<AI.UIMessageChunk, AI.UIMessage> = {
  createEncoder,
  createDecoder,
  createAccumulator,
  getMessageKey: (message) => message.id,
  isTerminal: (event) => event.type === 'finish' || event.type === 'error' || event.type === 'abort',
};
```
Just wires together the three factories + two predicates. This is what our Anthropic codec entry point will look like.

**Encoder** (384 lines) -- the mapping layer:
- `appendEvent(chunk)` is a big switch on `chunk.type`:
  - Stream starts (`text-start`, `reasoning-start`, `tool-input-start`) -> `core.startStream()` with domain headers via `headerWriter()`
  - Stream deltas (`text-delta`, `reasoning-delta`, `tool-input-delta`) -> `core.appendStream()` (data only)
  - Stream ends (`text-end`, `reasoning-end`) -> `core.closeStream()`
  - `tool-input-available` -> tries `closeStream`, falls back to `publishDiscrete` if no active stream (non-streaming tool call)
  - Lifecycle events (`start`, `finish`, `error`, `abort`, etc.) -> `core.publishDiscrete()`
- `writeMessages(messages)` splits each `UIMessage` into per-part payloads (`encodeMessagePayloads`):
  - `text` part -> `{ name: 'text', data: part.text }`
  - `file` part -> `{ name: 'file', data: part.url }`
  - `data-*` part -> `{ name: part.type, data: part.data }`
  - Empty message -> placeholder text message
  - All share `x-domain-messageId` header
- `close()` delegates to `core.close()`

**Decoder** (554 lines) -- hooks into the decoder core:
- Creates a `VercelHeaderReader` extending base reader with typed `providerMetadata()`
- `buildStartChunk`/`buildDeltaChunk`/`buildEndChunk` -- switch on `tracker.name` ("text", "reasoning", "tool-input") to produce the right `UIMessageChunk` type
- Lifecycle tracker with phases `['start', 'start-step']` -- `ensurePhases()` called in start hooks
- `decodeDiscrete` handles: discrete message parts (identified by `x-ably-role`), lifecycle events (start, finish, error, abort, etc.), non-streaming tool calls
- Helper functions: `parseFinishReason`, `isDataEventName`, `parseJsonOrString` -- trust boundary validations

**Accumulator** (603 lines) -- the most complex piece:
- `ActiveMessageState` per in-progress message: message object, `DeltaStreamTracker` for text/reasoning, `ToolPartTracker` per toolCallId, `StreamStatus` per stream
- `DeltaStreamTracker` class manages stream ID -> part index mapping, handles start/delta/reset for a single part type
- Event processing: `start` creates message, `text-start` pushes part + registers stream, `text-delta` appends to part, `finish` closes message, etc.
- Tool parts use accumulation buffer (`inputText`) for JSON fragments before parsing
- `processOutputs()` routes each output by kind (event vs message)

**Key patterns for our Anthropic codec**:
1. The encoder is a ~380-line switch statement mapping event types to core operations + domain headers
2. The decoder hooks are ~180 lines of chunk construction from tracker state + header reading
3. The accumulator is ~600 lines of stateful message assembly -- the bulk of the complexity
4. `isTerminal` and `getMessageKey` are one-liners
5. Trust boundaries are explicit: JSON parsing, finish reason validation, wire data interfaces
6. Non-streaming fallback pattern: `tool-input-available` tries closeStream, catches "no active stream", falls back to discrete

### 2.3 -- Vercel Codec Integration Tests (`4d6142e`)

**767 lines added.** Integration test infrastructure + 8 codec-level roundtrip tests over real Ably channels.

**Infrastructure**:
- Sandbox app provisioning via `ably-common test-app-setup` (globalSetup)
- Helpers: `ablyRealtimeClient()`, `closeAllClients()` (afterEach), `uniqueChannelName()`
- Integration vitest config with 30s timeout
- Environment config supporting sandbox (default), local, production

**Test pattern** (consistent across all 8 scenarios):
1. Create pub/sub client pair with unique channel
2. Create encoder on pub channel, decoder + accumulator on sub channel
3. Subscribe, collect outputs, resolve promise on terminal event
4. Encode a sequence of events through the encoder
5. Await terminal, assert event types + accumulated message content

**Scenarios**: Text roundtrip, streaming tool call, non-streaming tool call, abort mid-stream, history hydration, multi-client sync (2 subscribers), reasoning stream, error propagation.

**Observations**:
- Tests use `stampHeaders` helper to simulate transport-level headers (turnId, msgId) -- since these are codec-level tests without the transport
- History test has a `setTimeout(1000)` for Ably consistency -- necessary for real network, but could be fragile
- `void encoder.appendEvent(...)` used for fire-and-forget deltas (matching production pattern)
- Clean test isolation via unique channels and `closeAllClients()`

**For our Anthropic codec**: We'd write nearly identical integration tests -- same infrastructure, same pattern, just with Anthropic event types and message structures. The test helpers are reusable.

### 2.4 -- Server Transport (`a4f09a4`)

**2,521 lines added.** The generic server-side transport layer with turn management and cancel routing.

**Files**: `src/core/transport/` (server-transport.ts, turn-manager.ts, pipe-stream.ts, headers.ts, types.ts, index.ts), `src/errors.ts` updates, tests + integration tests.

**Transport types** (`types.ts`, 201 lines):
- `Turn<TEvent, TMessage>` interface: turnId, abortSignal, start(), addMessages(), streamResponse(), end()
- `ServerTransport<TEvent, TMessage>` interface: newTurn(), close()
- `NewTurnOptions<TEvent>`: turnId, clientId, parent, forkOf, onMessage, onAbort, onCancel, onError
- `InputMessage<TMessage>`: message + optional extra headers
- `CancelFilter`, `CancelRequest`, `StreamResult`, `TurnEndReason`

**Server transport** (`server-transport.ts`, 455 lines):
- `DefaultServerTransport` composes TurnManager + codec encoder
- Constructor: subscribes to `x-ably-cancel` events (before attach per RTL7g)
- `newTurn()`: synchronous, creates Turn object, registers `RegisteredTurn` for cancel routing
- Turn's `addMessages()`: creates discrete encoder, builds transport headers per message, publishes. Merges per-message headers from client (for optimistic msg-id passthrough).
- Turn's `streamResponse()`: creates streaming encoder with `onMessage` hook for transport headers, calls `pipeStream()`. Returns `{ reason }`.
- Turn's `end()`: delegates to TurnManager, idempotent.
- Cancel routing: parses filter headers, resolves matching turns, calls `onCancel` hooks in isolated try/catch, fires `controller.abort()` on approval.

**pipeStream** (`pipe-stream.ts`, 94 lines) -- clean pure function:
- `Promise.race([reader.read(), abortPromise.then(() => 'aborted')])` loop
- On abort: call `onAbort` callback, then break (encoder abort handled by caller)
- On done: `encoder.close()`
- On error: best-effort `encoder.close()`, return `'error'`
- Finally: remove abort listener, release reader lock

**Observation**: In `pipeStream`, on error it calls `encoder.close()` but not `encoder.abortAllStreams()`. The encoder's `close()` does flush + clear, but doesn't set aborted status. Looking at the server transport's `streamResponse()`, after `pipeStream` returns with `reason: 'error'`, the caller gets back `{ reason: 'error' }` but the encoder streams are closed as "finished" not "aborted". Is this intentional? The `close()` path in the encoder flushes pending appends but doesn't send an abort status. Subscribers might see a stream that ends without a proper terminal status if an error occurs mid-stream. Worth checking if this is handled elsewhere or is a gap.

**For our codec work**: Entirely generic -- no modifications needed for a new codec. The transport creates encoders via `codec.createEncoder()` and passes `ReadableStream<TEvent>` to `pipeStream`. Our Anthropic codec just needs to satisfy the Codec interface.

### 2.5 -- Client Transport (`3127f77`)

**5,782 lines added.** The largest commit -- client transport + conversation tree + history + stream router + event emitter.

**Files**: `src/core/transport/` (client-transport.ts 930 lines, conversation-tree.ts 434, decode-history.ts 337, stream-router.ts 118), `src/event-emitter.ts` 103, type additions, tests (2,256 unit + 657 integration).

**Client transport** (`client-transport.ts`, 930 lines):
- Composes: ConversationTree, StreamRouter, StreamDecoder, EventEmitter, per-turn state maps
- Constructor: subscribes to channel before attach, creates decoder + stream router
- `send()`: generate IDs -> auto-compute parent -> optimistic insert -> create stream -> fire-and-forget POST -> return ActiveTurn
- `_handleMessage()`: turn lifecycle events (start/end) + codec-decoded messages routed by kind/turn ownership
- `TurnObserverState`: headers + serial + accumulator per turn. Upserts to tree on every event.
- `regenerate()`/`edit()`: compute forkOf/parent/truncated history, delegate to `send()`
- `cancel()`: publish cancel + close matching local streams
- `history()`: delegates to `decodeHistory`, upserts results into tree with withholding mechanism
- `close()`: unsubscribe, close streams, clear state. Post-close methods throw `TransportClosed`.

**StreamRouter** (`stream-router.ts`, 118 lines):
- Clean interface: `createStream`, `closeStream`, `route`, `has`
- Controller captured synchronously via ReadableStream `start()` callback
- Terminal detection via codec's `isTerminal` predicate
- Defensive: catches already-closed controllers, removes entries on enqueue failure

**ConversationTree** (`conversation-tree.ts`, 434 lines):
- Data structures: `_nodeIndex` (Map<msgId>), `_codecKeyIndex` (Map<codecKey, msgId>), `_sortedList`, `_parentIndex`, `_selections`
- `upsert()`: insert (binary search for serial-bearing, append for null-serial) or update (serial promotion)
- `flatten()`: walks sorted list checking parent reachability + sibling selection
- Sibling groups: follow `forkOf` chain to group root, collect all siblings
- `delete()`: removes from indexes, children become unreachable (no cascade)

**decodeHistory** (`decode-history.ts`, 337 lines):
- Collect-and-redecode strategy: fetch page, reverse to chronological, fresh decoder, count completed messages
- Per-turn accumulators to prevent cross-turn corruption
- `limit * 10` Ably messages per page (heuristic)
- `untilAttach: true` for gapless continuity

**EventEmitter** (`event-emitter.ts`, 103 lines):
- Type-safe wrapper around Ably's EventEmitter, adapted from ably-chat-js

**No new issues spotted** -- implementation matches the Phase 1 documentation closely. The 2,256-line unit test file for client transport is impressively thorough.

**For our codec**: Entirely generic. No modifications needed.

### 2.6 -- Vercel Transport Factories (`912d11e`)

**169 lines.** Thin convenience wrappers in `src/vercel/transport/index.ts` -- `createClientTransport` and `createServerTransport` that delegate to core factories with `UIMessageCodec` pre-bound. Consumers don't pass codec explicitly. **We'd do the same for Anthropic**: `createClientTransport` and `createServerTransport` in `src/anthropic/transport/`.

### 2.7 -- ChatTransport Adapter (`c7f8962`)

**705 lines.** `src/vercel/transport/chat-transport.ts` (278 lines) + tests (415 lines). Wraps `ClientTransport` to satisfy Vercel's `ChatTransport` interface for `useChat`. Maps `sendMessages`/`reconnectToStream` to core `send()`/`cancel()`. Returns empty stream (useMessageSync pushes authoritative state). Handles submit vs regenerate triggers. **Vercel-specific -- only relevant if Anthropic has an equivalent hook-based UI library.**

### 2.8 -- React Hooks (`a321c9f`)

**2,135 lines.** Generic hooks in `src/react/` (11 hooks: useClientTransport, useMessages, useSend, useEdit, useRegenerate, useActiveTurns, useConversationTree, useHistory, useAblyMessages). Vercel-specific hooks in `src/vercel/react/` (useChatTransport, useMessageSync). Ref-based memoization for React Strict Mode double-mount safety. Mock transport helper for testing.

**All generic hooks work with any codec** -- parameterized by `<TEvent, TMessage>`. For Anthropic, only Anthropic-specific hooks (if any) would need writing.

### 2.9 -- Cancel/Abort Fix (`b0f1814`)

**502 lines changed.** Important fix that **resolves Issue #2** I raised in commit 2.4:
- **Added `StreamEncoder.abort(reason?)` to the codec interface** -- the transport now calls `encoder.abort()` after `onAbort` callback, not `encoder.close()`. This ensures the wire sees "aborted" status, not "finished".
- `pipeStream` now calls `await encoder.abort('cancelled')` on cancel path.
- Vercel encoder implements `abort()`: aborts all streams + publishes discrete abort event with `x-ably-status: aborted`.
- **Client transport observer lifecycle fix**: preserve observers after cancel so late server events (abort, status updates) still accumulate. Cleanup on turn-end, not cancel.
- **History duplication fix**: capture history before optimistic inserts.
- **Vercel decoder**: added discrete message part decoding (writeMessage echoes) via `x-ably-role` presence check.

**For our codec**: `abort()` is now part of the `StreamEncoder` interface -- our encoder must implement it.

### 2.10 -- Custom Codec Example (`edd7605`)

**1,150 lines.** `examples/custom-codec/` -- a complete worked example of building a custom codec. **This is our direct template.**

**Domain types** (`types.ts`, 118 lines): Simple model -- `AgentEvent` union (start, text-delta, text-end, tool-call, finish) and `AgentMessage` (id, role, text, toolCalls). Comments explain the streamable vs discrete design decision.

**Codec** (`codec.ts`, 580 lines): Full `Codec<AgentEvent, AgentMessage>` with heavily commented implementation:
- Encoder: switch on event.type -> core operations. `text-delta` uses startStream/appendStream, tool-call uses publishDiscrete with domain headers, start/finish are discrete lifecycle events. Tracks `_textStreamOpen` flag. `writeMessage` splits user messages into discrete payloads.
- Decoder: hooks into core. `buildStartEvents`/`buildDeltaEvents`/`buildEndEvents` for text stream. `decodeDiscrete` for tool-call, start, finish, and user message parts.
- Accumulator: tracks `ActiveMessageState` with in-progress text and tool calls. Event processing: start creates message, text-delta appends, tool-call pushes, finish finalizes.
- Entry point: `AgentCodec` object wiring factories + `isTerminal` (finish event) + `getMessageKey` (message.id).

**Simulate script** (`simulate.ts`, 238 lines): Encodes, publishes, subscribes, decodes, accumulates over a real Ably channel.

**Key insight**: The example codec is ~580 lines for a simple domain (text + tool calls). Anthropic's domain is more complex (content blocks, thinking, tool use with streaming), so expect more.

### 2.11 -- Later Commits

Post-example commits are incremental fixes and docs. Notable code changes:
- `af8898f`: Observer serial advances on every event (not just start/end) -- ensures tree nodes sort correctly during streaming
- `08782e9`: Multi-message sends chained into linear thread (each message's parent = previous msg-id)
- `8cd2594`: Edit history truncated before the edited message
- `bad849f`: `addMessages` returns msg-ids, parent made explicit in server transport
- `f92b516`: Consolidate `writeMessage` into `writeMessages`, rename `InputMessage`

Remaining commits are docs, CI, formatting, typos. No architectural changes.

**Post-review new commits** (after rebase to latest main, `3348814..264255b`):
- Build system: Vite build for all 4 entry points, package.json exports configured
- Module resolution: switched to `moduleResolution: "nodenext"`
- CI release workflow + CHANGELOG for 0.0.1
- README positioning revisions
- No code/architecture changes. Relevant for Anthropic: we'd need to add `./anthropic` and `./anthropic/react` export entries + vite configs following the same pattern as `./vercel`.

---

## Codec Authoring Guide (Phase 3)

> What we learn about writing a new codec -- the contract, touchpoints, and gotchas.

### Codec Interface Contract (3.1)

From Phase 1+2, the codec must implement (after PR #11 merges):

```typescript
interface Codec<TEvent, TMessage> {
  createEncoder(channel: ChannelWriter, options?: EncoderOptions): StreamEncoder<TEvent, TMessage>;
  createDecoder(): StreamDecoder<TEvent, TMessage>;
  createAccumulator(): MessageAccumulator<TEvent, TMessage>;
  isTerminal(event: TEvent): boolean;
}
```

**StreamEncoder** must implement: `appendEvent(event)`, `writeMessages(messages)`, `writeEvent(event)`, `abort(reason?)`, `close()`.

**StreamDecoder** must implement: `decode(message) -> DecoderOutput[]`. Internally, provide 4 hooks to `createDecoderCore`: `buildStartEvents`, `buildDeltaEvents`, `buildEndEvents`, `decodeDiscrete`.

**MessageAccumulator** must implement: `processOutputs(outputs)`, `updateMessage(message)`, plus properties `messages`, `completedMessages`, `hasActiveStream`.

### Vercel Codec as Reference (3.2)

See detailed notes in 2.2. Key size reference:
- Encoder: ~380 lines (switch on chunk.type -> core operations + domain headers)
- Decoder: ~550 lines (4 hooks + lifecycle tracker + discrete decoding)
- Accumulator: ~600 lines (per-message state with concurrent stream tracking)
- Entry point: ~15 lines (wire factories + isTerminal + getMessageKey)

### Touchpoints for a New Codec (3.3)

Files to create:
1. `src/anthropic/codec/types.ts` -- TEvent and TMessage type definitions (or re-export from SDK)
2. `src/anthropic/codec/encoder.ts` -- StreamEncoder implementation
3. `src/anthropic/codec/decoder.ts` -- DecoderCoreHooks + StreamDecoder factory
4. `src/anthropic/codec/accumulator.ts` -- MessageAccumulator implementation
5. `src/anthropic/codec/index.ts` -- Codec entry point wiring factories + isTerminal
6. `src/anthropic/index.ts` -- public API exports
7. `src/anthropic/transport/index.ts` -- convenience factories (createClientTransport, createServerTransport)
8. Package.json: add `./anthropic` export + vite config
9. Tests: unit tests for encoder, decoder, accumulator + integration tests

### Anthropic Agent SDK Types (3.4)

The Agent SDK (`@anthropic-ai/claude-agent-sdk`) uses `query()` which returns a `Query` object -- an `AsyncGenerator<SDKMessage, void>`.

**SDKMessage** is a large union type (~20 variants). The key message types for a codec:

**Core conversation messages:**
- `SDKAssistantMessage` (`type: "assistant"`) -- contains `message: BetaMessage` from the Anthropic SDK (with `id`, `content`, `model`, `stop_reason`, `usage`), `uuid`, `session_id`, `parent_tool_use_id`, optional `error`
- `SDKUserMessage` (`type: "user"`) -- contains `message: MessageParam` from Anthropic SDK, `uuid?`, `session_id`, `parent_tool_use_id`, `isSynthetic?`, `tool_use_result?`
- `SDKResultMessage` (`type: "result"`) -- final result with `subtype` (success or error variants), `duration_ms`, `total_cost_usd`, `usage`, `num_turns`, `stop_reason`

**Streaming:**
- `SDKPartialAssistantMessage` (`type: "stream_event"`) -- only when `includePartialMessages: true`. Contains `event: BetaRawMessageStreamEvent` from the Anthropic SDK. This is the streaming chunk type.

**System/lifecycle:**
- `SDKSystemMessage` (`type: "system"`, `subtype: "init"`) -- initialization with tools, model, agents, etc.
- `SDKCompactBoundaryMessage` (`type: "system"`, `subtype: "compact_boundary"`) -- conversation compaction
- `SDKStatusMessage`, `SDKToolProgressMessage`, `SDKHookStartedMessage`, `SDKHookProgressMessage`, `SDKHookResponseMessage` -- operational status events
- `SDKTaskNotificationMessage`, `SDKTaskStartedMessage`, `SDKTaskProgressMessage` -- background task events
- `SDKPromptSuggestionMessage` -- prompt suggestions after turns
- `SDKLocalCommandOutputMessage` -- local command output
- `SDKToolUseSummaryMessage` -- tool use summary
- `SDKRateLimitEvent` -- rate limiting info
- `SDKAuthStatusMessage` -- auth status
- `SDKFilesPersistedEvent` -- file checkpointing events

**Key insight: The streaming is based on `BetaRawMessageStreamEvent`** from the Anthropic SDK, which follows the Anthropic Messages API streaming format:
- `message_start` -- new message begins
- `content_block_start` -- new content block (text, tool_use, thinking)
- `content_block_delta` -- delta for a content block (text_delta, input_json_delta, thinking_delta)
- `content_block_stop` -- content block complete
- `message_delta` -- message-level delta (stop_reason, usage)
- `message_stop` -- message complete

**Content block types** (from BetaMessage.content):
- `text` -- text content with `text: string`
- `tool_use` -- tool call with `id`, `name`, `input`
- `thinking` -- extended thinking with `thinking: string`

**Fundamental difference from Vercel**: The Agent SDK wraps the Anthropic API types (`BetaMessage`, `MessageParam`, `BetaRawMessageStreamEvent`) rather than defining its own. The streaming events are the raw Anthropic API stream events wrapped in an `SDKPartialAssistantMessage` envelope. The complete messages are `BetaMessage` objects wrapped in `SDKAssistantMessage`.

**Streaming output docs** (from platform.claude.com/docs/en/agent-sdk/streaming-output):

With `includePartialMessages: true`, the message flow is:
```
StreamEvent (message_start)
StreamEvent (content_block_start) - text block
StreamEvent (content_block_delta) - text_delta chunks...
StreamEvent (content_block_stop)
StreamEvent (content_block_start) - tool_use block
StreamEvent (content_block_delta) - input_json_delta chunks...
StreamEvent (content_block_stop)
StreamEvent (message_delta) - stop_reason, usage
StreamEvent (message_stop)
AssistantMessage - complete message with all content
... tool executes ...
... more streaming events for next turn ...
ResultMessage - final result
```

Without `includePartialMessages`, you only get `AssistantMessage`, `ResultMessage`, `SystemMessage`, etc. (no `StreamEvent`).

**Known limitation**: Extended thinking with explicit `maxThinkingTokens` disables `StreamEvent` messages -- only complete messages are yielded.

**Key types from the streaming events** (`BetaRawMessageStreamEvent`):
- `message_start` -- new message begins
- `content_block_start` -- new content block starts (text, tool_use, or thinking)
- `content_block_delta` -- incremental update:
  - `text_delta` with `text: string`
  - `input_json_delta` with `partial_json: string`
  - `thinking_delta` with `thinking: string`
- `content_block_stop` -- content block complete
- `message_delta` -- message-level updates (stop_reason, usage)
- `message_stop` -- message complete

**Design decisions for TEvent and TMessage:**

After discussion, we'll use the SDK types directly (as peer dependency), following the same pattern as Vercel:
- `TEvent` = `AgentCodecEvent` -- a filtered subset of `SDKMessage` containing only conversation-relevant types (~5 of ~20 variants). Defined by us as a union of SDK types. The server filters `query()` output to this subset before piping to the transport.
- `TMessage` = `AgentMessage` = `SDKAssistantMessage | SDKUserMessage` (union of both roles). Similar to how Vercel's `UIMessage` covers both roles.
- Peer dependency: `@anthropic-ai/claude-agent-sdk` (for types only on the frontend, same as `ai` for Vercel).

The streaming content blocks map directly to encoder core operations:
- `content_block_start` (text) -> `startStream`
- `content_block_delta` (text_delta) -> `appendStream`
- `content_block_stop` + `content_block_start` was text -> `closeStream`
- `content_block_start` (tool_use) -> `startStream` (tool input streaming)
- `content_block_delta` (input_json_delta) -> `appendStream`
- `content_block_stop` + `content_block_start` was tool_use -> `closeStream`
- `AssistantMessage`, `ResultMessage`, lifecycle events -> `publishDiscrete`

### Anthropic Agent SDK -> Codec Mapping (3.5)

**TEvent = `AgentCodecEvent`** (our filtered subset of `SDKMessage` -- see 3.6 type definitions)

**TMessage = `AgentMessage`** = `SDKAssistantMessage | SDKUserMessage` (from `@anthropic-ai/claude-agent-sdk`)

**Encoder mapping** (`appendEvent` switch on `message.type`):

| SDKMessage type | Inner event/field | Core operation |
|---|---|---|
| `stream_event` + `message_start` | lifecycle | `publishDiscrete` (or lifecycle tracker phase) |
| `stream_event` + `content_block_start` (text) | stream start | `startStream(blockIndex, { name: 'text' })` |
| `stream_event` + `content_block_delta` (text_delta) | stream delta | `appendStream(blockIndex, delta.text)` |
| `stream_event` + `content_block_stop` (was text) | stream end | `closeStream(blockIndex, ...)` |
| `stream_event` + `content_block_start` (tool_use) | stream start | `startStream(toolUseId, { name: 'tool-input' })` |
| `stream_event` + `content_block_delta` (input_json_delta) | stream delta | `appendStream(toolUseId, delta.partial_json)` |
| `stream_event` + `content_block_stop` (was tool_use) | stream end | `closeStream(toolUseId, ...)` |
| `stream_event` + `content_block_start` (thinking) | stream start | `startStream(blockIndex, { name: 'thinking' })` |
| `stream_event` + `content_block_delta` (thinking_delta) | stream delta | `appendStream(blockIndex, delta.thinking)` |
| `stream_event` + `content_block_stop` (was thinking) | stream end | `closeStream(blockIndex, ...)` |
| `stream_event` + `message_delta` | lifecycle | `publishDiscrete` (stop_reason, usage) |
| `stream_event` + `message_stop` | lifecycle | `publishDiscrete` |
| `assistant` | complete message | `publishDiscrete` (or skip if streaming was enabled) |
| `result` | terminal | `publishDiscrete` (terminal event) |
| `user` | user message | via `writeMessages` path |
| Other operational types | skip | Encoder ignores |

**Decoder hooks**:
- `buildStartEvents(tracker)`: switch on `tracker.name` ("text", "tool-input", "thinking") to produce appropriate `SDKPartialAssistantMessage` wrapping a `content_block_start` event
- `buildDeltaEvents(tracker, delta)`: produce `SDKPartialAssistantMessage` wrapping a `content_block_delta` event
- `buildEndEvents(tracker, closingHeaders)`: produce `SDKPartialAssistantMessage` wrapping a `content_block_stop` event
- `decodeDiscrete(payload)`: reconstruct `SDKAssistantMessage`, `SDKResultMessage`, or lifecycle events from discrete messages

**Domain headers** (`x-domain-*`):
- `x-domain-blockIndex` -- content block index within the message
- `x-domain-blockType` -- "text", "tool_use", "thinking"
- `x-domain-toolUseId` -- tool call identifier (for tool_use blocks)
- `x-domain-toolName` -- tool name
- `x-domain-stopReason` -- why the message ended
- `x-domain-model` -- model used
- `x-domain-messageId` -- BetaMessage.id
- `x-domain-parentToolUseId` -- sub-agent context

**Accumulator**: Builds `SDKAssistantMessage` from streaming events:
- On `message_start` -> create new in-progress message
- On `content_block_start` (text) -> add empty text content block
- On `content_block_delta` (text_delta) -> append to text block
- On `content_block_start` (tool_use) -> add tool_use content block
- On `content_block_delta` (input_json_delta) -> accumulate JSON input
- On `content_block_stop` -> mark block complete
- On `message_delta` -> set stop_reason, usage
- On `message_stop` / complete `AssistantMessage` -> finalize
- On `ResultMessage` -> mark as terminal

**`isTerminal`**: `message.type === 'result'` (the `SDKResultMessage` signals the end)

**Lifecycle tracker phases**: `['message_start']` -- ensures a `message_start` event is synthesized for mid-stream joins before any content blocks arrive.

### Key Differences from Vercel Codec

| Concern | Vercel | Anthropic Agent SDK |
|---|---|---|
| **TEvent source** | `UIMessageChunk` -- Vercel's own streaming type | `SDKMessage` subset -- wraps Anthropic API stream events |
| **TMessage** | `UIMessage` -- single type with `role` field | `SDKAssistantMessage \| SDKUserMessage` -- union of two structurally different types |
| **Event self-identification** | Every chunk carries its own identity (e.g. `chunk.id`, `chunk.toolCallId`) | `content_block_stop` has only `index`, no type. Encoder must track open blocks by index. |
| **Encoder state** | Stateless aside from `_aborted` flag | Needs `Map<number, { name, streamId }>` to track open content blocks by index |
| **Streaming opt-in** | Always streaming | Requires `includePartialMessages: true`. Extended thinking disables streaming entirely. |
| **Event union size** | `UIMessageChunk` has ~20 variants, all conversation-relevant | `SDKMessage` has ~20 variants, only ~5 are conversation-relevant. Need a filtered subset type. |
| **Lifecycle events** | `start`, `start-step`, `finish-step`, `finish` (Vercel-specific) | `message_start`, `message_stop`, `message_delta` (Anthropic API events) |
| **Content blocks** | Parts array on UIMessage (text, file, reasoning, dynamic-tool, data-*) | Content blocks on BetaMessage (text, tool_use, thinking) |
| **Tool input streaming** | `tool-input-start/delta/available` events with `toolCallId` | `content_block_start/delta/stop` with `index` + `input_json_delta` |
| **Non-streaming fallback** | `tool-input-available` without prior start -> discrete publish | Complete `AssistantMessage` when `includePartialMessages` is false |
| **Peer dependency** | `ai` package | `@anthropic-ai/claude-agent-sdk` package |
| **Client-side SDK** | Yes (`useChat`, React hooks from `@ai-sdk/react`) | No -- Agent SDK is server-only. Generic React hooks from `@ably/ai-transport/react` used directly. |

### Anthropic Agent SDK Codec Plan (3.6)

#### Type Definitions (`src/anthropic/codec/types.ts`)

```typescript
// Filtered subset of SDKMessage -- only conversation-relevant types
type AgentCodecEvent =
  | SDKPartialAssistantMessage  // streaming chunks
  | SDKAssistantMessage         // complete assistant response
  | SDKUserMessage              // user input
  | SDKResultMessage            // terminal result
  | SDKToolProgressMessage;     // optional: tool execution progress

// Union message type for the conversation tree
type AgentMessage =
  | SDKAssistantMessage
  | SDKUserMessage;
```

`TEvent = AgentCodecEvent`, `TMessage = AgentMessage`.

Both types re-exported from `@anthropic-ai/claude-agent-sdk` (peer dependency). The subset type `AgentCodecEvent` is ours -- a `Pick` from the `SDKMessage` union to keep the encoder switch statement focused.

#### Encoder (`src/anthropic/codec/encoder.ts`)

**State**: `_openBlocks: Map<number, { name: string; streamId: string }>` tracking content blocks by index. `_aborted: boolean` flag.

**`appendEvent(event)`** switch on `event.type`:
- `"stream_event"`: inner switch on `event.event.type`:
  - `message_start` -> `publishDiscrete` (lifecycle)
  - `content_block_start` -> `startStream(streamId, { name })`, record in `_openBlocks`
  - `content_block_delta` -> `appendStream(streamId, deltaText)` (dispatch on delta type: text_delta, input_json_delta, thinking_delta)
  - `content_block_stop` -> look up `_openBlocks[index]`, `closeStream(streamId, ...)`, remove from map
  - `message_delta` -> `publishDiscrete` (carries stop_reason, usage)
  - `message_stop` -> `publishDiscrete`
- `"assistant"` -> `publishDiscrete` (complete message, for non-streaming mode)
- `"result"` -> `publishDiscrete` (terminal)
- Other types -> ignore (no-op)

**`writeMessages(messages)`**: Encode `AgentMessage[]` as discrete publishes. Switch on `message.type`:
- `"user"`: publish the `message.message: MessageParam` content (may need to split content array into per-block payloads, similar to Vercel's per-part split)
- `"assistant"`: publish the full `message.message: BetaMessage` (for history/replay scenarios)

**`abort(reason?)`**: Abort all open streams via `_core.abortAllStreams()`, publish discrete abort event.

**Non-streaming mode**: When `includePartialMessages` is false, `query()` yields complete `SDKAssistantMessage` instead of `SDKPartialAssistantMessage` stream events. The encoder handles this via the `"assistant"` case in the switch -- publishes the complete message as discrete. The accumulator handles it via `kind: 'message'` output path.

**Domain headers**: `x-domain-blockIndex`, `x-domain-blockType`, `x-domain-toolUseId`, `x-domain-toolName`, `x-domain-stopReason`, `x-domain-model`, `x-domain-parentToolUseId`.

#### Decoder (`src/anthropic/codec/decoder.ts`)

**Hooks**:
- `buildStartEvents(tracker)`: switch on `tracker.name` ("text", "tool-input", "thinking") -> produce `SDKPartialAssistantMessage` wrapping appropriate `content_block_start`
- `buildDeltaEvents(tracker, delta)`: produce `SDKPartialAssistantMessage` wrapping `content_block_delta` with correct delta type
- `buildEndEvents(tracker, closingHeaders)`: produce `SDKPartialAssistantMessage` wrapping `content_block_stop`
- `decodeDiscrete(payload)`: switch on `payload.name` to reconstruct `SDKAssistantMessage`, `SDKResultMessage`, lifecycle events, or `SDKUserMessage` (via `kind: 'message'`)

**Lifecycle tracker**: phases `['message_start']`. Ensures `message_start` is synthesized for mid-stream joins.

#### Accumulator (`src/anthropic/codec/accumulator.ts`)

Builds `AgentMessage` (= `SDKAssistantMessage | SDKUserMessage`) from decoder outputs.

**Per-message state**:
- `contentBlocks: Map<number, ContentBlock>` -- in-progress content blocks by index
- `toolInputBuffers: Map<string, string>` -- JSON accumulation for tool_use inputs
- `streamStatus: Map<string, 'streaming' | 'finished' | 'aborted'>` -- per-stream status
- `messageMetadata: { id, model, stopReason, usage }` -- from message_start/message_delta

**Event processing**:
- `message_start` -> create in-progress `SDKAssistantMessage`
- `content_block_start` (text) -> add `{ type: 'text', text: '' }` to content blocks
- `content_block_delta` (text_delta) -> append to text block
- `content_block_start` (tool_use) -> add `{ type: 'tool_use', id, name, input: {} }` to content blocks
- `content_block_delta` (input_json_delta) -> accumulate JSON fragment
- `content_block_stop` -> parse accumulated JSON for tool_use, mark block complete
- `content_block_start` (thinking) -> add `{ type: 'thinking', thinking: '' }` to content blocks
- `content_block_delta` (thinking_delta) -> append to thinking block
- `message_delta` -> set stop_reason, usage on message
- `message_stop` / complete `SDKAssistantMessage` -> finalize, move to completed
- `SDKUserMessage` (via `kind: 'message'`) -> push directly to list
- `SDKResultMessage` -> terminal signal

**`isTerminal`**: `event.type === 'result'`

#### Package Integration

Files to create:
- `src/anthropic/codec/` -- types.ts, encoder.ts, decoder.ts, accumulator.ts, index.ts
- `src/anthropic/transport/index.ts` -- convenience factories
- `src/anthropic/index.ts` -- public exports
- `src/anthropic/vite.config.ts` -- build config
- `package.json` -- add `./anthropic` export entry
- Peer dependency: `@anthropic-ai/claude-agent-sdk`
- Tests: unit tests mirroring `test/vercel/codec/`, integration tests mirroring `test/vercel/codec/codec.integration.test.ts`

#### Estimated Size

Based on the Vercel reference and accounting for differences:
- Encoder: ~300 lines (simpler event types but needs block index tracking)
- Decoder: ~400 lines (similar complexity, different event structures)
- Accumulator: ~450 lines (simpler content model than Vercel's parts system)
- Types: ~50 lines (subset type + re-exports)
- Entry point + transport factories: ~50 lines
- Total codec: ~1,250 lines
- Tests: ~2,000 lines (unit + integration)

---

## Issues & Observations

> Bugs, inconsistencies, limitations, open questions, or improvement ideas found during the investigation.

| # | Type | Location | Description | Status |
|---|------|----------|-------------|--------|
| 1 | Design issue / PR | `Codec.getMessageKey()`, ConversationTree | Transport layer depended on codec for message identity via `getMessageKey()`. This couples transport to domain message shape and breaks for frameworks where messages don't have IDs (e.g. Anthropic user messages). PR #11 (`refactor/message-id`) removes `getMessageKey()` from the Codec interface entirely, making transport use only `x-ably-msg-id`. Also replaces `flatten()` with `flattenNodes()`, `getMessageHeaders()`/`getMessagesWithHeaders()` with `getNodes()`. | Open PR #11 |
| 2 | ~~Potential issue~~ | `pipe-stream.ts` error path | Initially raised in 2.4: pipeStream called `encoder.close()` on abort instead of aborting. **Fixed in commit 2.9** (`b0f1814`): added `StreamEncoder.abort()` to the interface, pipeStream now calls `encoder.abort('cancelled')` on the cancel path. The error path still calls `encoder.close()` (best-effort), which is reasonable -- errors are signaled via a discrete `error` event before the stream throws. | Resolved by 2.9 |
| 3 | Codec authoring tension | Lifecycle tracker + complex SDK types | The lifecycle tracker synthesizes events for mid-stream joins. For Vercel, synthetic events are simple (`{ type: 'start', messageId }` — flat objects). For Anthropic, synthetic events require constructing nested `BetaMessage` objects with many required fields (`id`, `role`, `type`, `model`, `content`, `stop_reason`, `stop_sequence`, `usage`, `container`, `context_management`). This is fragile — if the Anthropic SDK adds a required field, the synthetic construction breaks. **Suggestion**: The lifecycle tracker could accept a simpler "phase event" type that the accumulator knows how to handle, rather than requiring full TEvent construction. Or the accumulator could be designed to lazily create messages on first content block without requiring a preceding start event. | Design friction — noted during implementation |
| 4 | Codec authoring tension | `getMessageKey` with union TMessage | For Vercel, `getMessageKey` is trivial (`message.id`). For Anthropic's `SDKAssistantMessage | SDKUserMessage` union, `uuid` is optional on `SDKUserMessage`, requiring a fallback. This confirms the PR #11 decision to remove `getMessageKey` — it couples the codec interface to domain message identity assumptions that don't hold for all frameworks. | Confirms PR #11 motivation |

---

## Conclusions

### How easy was it to add a new codec?

**The architecture delivered on its promise.** The two-layer split (generic transport + pluggable codec) meant we never touched a single line of transport code. The EncoderCore and DecoderCore handled all Ably wire protocol concerns. We wrote ~2,100 lines of codec source code and ~3,800 lines of tests, with zero changes to the existing codebase.

The custom-codec example was an effective starting template. The Vercel codec served as a comprehensive reference for every edge case. The documentation in `docs/internals/` was accurate and thorough enough to build a mental model before reading any source code.

**Overall verdict: moderately easy for the codec itself, but significantly harder than expected due to SDK type friction.**

### What went well

1. **EncoderCore and DecoderCore are excellent abstractions.** The domain encoder is just a switch statement mapping events to four core operations. The domain decoder provides four hooks. All Ably-specific complexity (serial tracking, append batching, flush/recovery, prefix-match, first-contact) is handled by the cores. A codec author never needs to understand Ably message actions.

2. **The header utilities (`headerWriter`/`headerReader`) are clean and ergonomic.** The `x-domain-` prefix is handled automatically. The fluent builder pattern makes header construction readable.

3. **The lifecycle tracker is a good generic solution** for the mid-stream join problem. Configuring it with phases is straightforward.

4. **The test infrastructure is reusable.** Sandbox provisioning, unique channel names, client lifecycle helpers -- all worked immediately for our codec's integration tests.

5. **The transport factory pattern (Omit codec from options) is trivially implementable.** The Anthropic transport factories are ~50 lines.

### What was challenging

1. **Transitive SDK type resolution.** The Anthropic Agent SDK (`@anthropic-ai/claude-agent-sdk`) depends on `@anthropic-ai/sdk` for types like `BetaRawMessageStreamEvent` and `BetaMessage`. With `skipLibCheck: true`, TypeScript resolves these as error types, causing every property access to require `eslint-disable` comments. This is the single biggest source of friction -- approximately 40% of the eslint-disable comments in our codec exist solely because of transitive type resolution. **This is not a problem with the AI Transport SDK's design**, but it is a real pain point for codec authors whose framework SDK has deep type dependency chains.

2. **Complex nested SDK types require `as unknown as` casts.** The Anthropic codec has 30 `as unknown as` casts in source files (vs 0 in Vercel). These exist because the decoder and accumulator construct SDK types (`BetaRawMessageStreamEvent`, `BetaMessage`, content blocks) from decoded wire data. The object literals don't structurally satisfy the full union types -- for example, `BetaContentBlock` is a union of 14 variants, and constructing any one of them requires all fields for that variant. The root cause is using complex SDK types as `TEvent`/`TMessage`. If we defined our own simpler types (like the custom-codec example's flat `AgentMessage { id, role, text, toolCalls }`), there'd be zero casts -- but consumers couldn't work with familiar SDK types. The casts are at well-defined trust boundaries and validated by the switch-based type narrowing, so they're correct -- just not ideal for maintainability.

3. **Events that don't self-identify.** Vercel's `UIMessageChunk` types carry their own identity (e.g. `text-delta` has `chunk.id`). Anthropic's `content_block_delta` and `content_block_stop` only carry an `index`, so the encoder must track open blocks to map index to stream ID. This is a minor annoyance, not a fundamental problem, but it adds state that the Vercel encoder doesn't need.

4. **Union `TMessage` types.** The Vercel codec has a single `UIMessage` type for both roles. The Anthropic codec has `SDKAssistantMessage | SDKUserMessage` -- structurally different types. This complicates `getMessageKey`, `updateMessage`, `writeMessages`, and any code that switches on the union. It works, but it's less ergonomic.

5. **Preserving SDK metadata through the wire.** Fields like `uuid`, `session_id`, `parent_tool_use_id` need to survive encode -> Ably -> decode. Each requires a domain header. The initial implementation missed `uuid` and `session_id`, which were caught by the deep audit. The Vercel codec doesn't have this problem because `UIMessage` has fewer metadata fields.

   **Known limitation: `session_id` on streaming events.** Discrete messages (assistant-message, user-message) carry `session_id` via the `x-domain-sessionId` header and are reconstructed correctly. But streaming events (`SDKPartialAssistantMessage` reconstructed by the decoder from streamed content blocks) get `session_id: ''`. This is because `session_id` is not included in the persistent headers passed to `startStream`.

   The Vercel codec uses persistent headers to carry metadata through the stream lifecycle. For example, `id` and `providerMetadata` are set on `startStream` and repeated on every append by the EncoderCore:
   ```typescript
   // Vercel encoder: headers on startStream become persistent
   const h = headerWriter().str('id', chunk.id).json('providerMetadata', chunk.providerMetadata).build();
   await this._core.startStream(chunk.id, { name: 'text', data: '', headers: h });
   // EncoderCore repeats these headers on every append and the closing append.
   // The decoder reads them from tracker.headers in every hook call.
   ```

   To fix `session_id` on streaming events, we'd add it as a persistent header in the encoder's `_handleContentBlockStart`:
   ```typescript
   // In _handleContentBlockStart, add to the header builder:
   .str('sessionId', sessionId)
   ```

   **The catch**: `_handleContentBlockStart` only receives the inner `StreamEvent` (the `BetaRawMessageStreamEvent`), not the outer `SDKPartialAssistantMessage` that carries `session_id`. The outer event is available in `appendEvent` but not passed down to the content block handler. Two approaches to fix:

   **(a) Capture in encoder state**: When `message_start` arrives, store `session_id` in an instance field. Read it in `_handleContentBlockStart`:
   ```typescript
   private _sessionId = '';

   // In _handleStreamEvent, case 'message_start':
   this._sessionId = outerEvent.session_id;  // but outerEvent isn't available here either

   // The same problem: _handleStreamEvent receives StreamEvent, not the outer SDKPartialAssistantMessage
   ```

   **(b) Thread the outer event through**: Pass the `SDKPartialAssistantMessage` into `_handleStreamEvent` and down to the content block handler:
   ```typescript
   // In appendEvent:
   case 'stream_event': {
     await this._handleStreamEvent(event.event, event, perWrite);  // pass outer event
     break;
   }

   // In _handleStreamEvent, accept outer event and pass session_id to content block handlers:
   private async _handleStreamEvent(
     streamEvent: StreamEvent,
     outerEvent: Anthropic.SDKPartialAssistantMessage,  // new parameter
     perWrite?: WriteOptions,
   ): Promise<void> {
     // ...
     case 'content_block_start': {
       // Now we can access outerEvent.session_id for persistent headers
       const h = headerWriter()
         .str('blockIndex', String(index))
         .str('sessionId', outerEvent.session_id)
         // ...
     }
   }
   ```

   Approach (b) is cleaner. The `session_id` would then be available in `tracker.headers` on every decoder hook call, and `wrapStreamEvent` could read it instead of defaulting to `''`.

   **Current decision**: Left as a known limitation. The accumulated `SDKAssistantMessage` has the correct `session_id` (from the `message_start` event data). Only the transient `SDKPartialAssistantMessage` wrappers produced by the decoder have `session_id: ''`, and nothing currently reads that field from streaming events. Fix when a consumer needs it.

### Bugs found in existing primitives

No bugs were found in the existing encoder core, decoder core, lifecycle tracker, transport, or other base primitives. The architecture is solid and the implementations are correct.

### Suggestions to improve the base primitives

1. **Lifecycle tracker should not force codecs to construct full `TEvent` objects.**

   The lifecycle tracker synthesizes missing "startup" events for mid-stream joins. It's configured with phases, and each phase has a `build()` function that must return `TEvent[]` -- the codec's full event type.

   For Vercel, `TEvent` is `UIMessageChunk` which includes simple flat variants, so `build()` is trivial:
   ```typescript
   // Vercel: 1 line, no casts, no eslint-disable
   build: (ctx) => [{ type: 'start', messageId: ctx.messageId }]
   ```

   For Anthropic, `TEvent` includes `SDKPartialAssistantMessage` -- a wrapper around deeply nested Anthropic SDK types. The `build()` function must construct:
   ```typescript
   // Anthropic: ~25 lines, multiple casts, 5 eslint-disable comments
   {
     type: 'stream_event',
     event: {                          // BetaRawMessageStreamEvent
       type: 'message_start',
       message: {                      // BetaMessage -- 10+ required fields
         id: '...', type: 'message', role: 'assistant', model: '...',
         content: [], stop_reason: null, stop_sequence: null,
         usage: { input_tokens: 0, output_tokens: 0, ... },
         container: null, context_management: null,
       }
     },
     parent_tool_use_id: null, uuid: '...', session_id: '',
   }
   ```

   The root cause: `build()` is forced to return `TEvent[]`. For frameworks with simple event types this is trivial; for frameworks with complex nested types it's painful and fragile (if the SDK adds a required field, the synthetic construction breaks).

   A simpler alternative: the lifecycle tracker could just report which phases are missing and let the decoder's own hooks handle construction. The hooks already know how to build events -- they do it for every stream start. The tracker doesn't need to build events itself; it just needs to track what's been emitted and what hasn't.

2. **Remove `getMessageKey` from the Codec interface** (PR #11, already in review). Our experience confirms this is the right call. The transport's own `x-ably-msg-id` is sufficient for identity. Requiring codecs to provide a domain key couples the interface to assumptions about message identity that don't hold for all frameworks (e.g. `SDKUserMessage.uuid` is optional).

3. **Add `@anthropic-ai/sdk` as a peer dependency to fix transitive type resolution.** The Anthropic codec initially had 41 `eslint-disable` comments (vs 0 for Vercel) because `@anthropic-ai/claude-agent-sdk` references types from `@anthropic-ai/sdk` (a transitive dependency not installed in our project). With `skipLibCheck: true`, TypeScript resolved these as error types, requiring `eslint-disable` on every property access. Adding `@anthropic-ai/sdk` as an explicit peer dependency fixed this: the types resolve correctly, 28 transitive-type disables were removed, and proper type checking caught real incompleteness in our synthetic objects (missing `BetaUsage` fields, `BetaThinkingBlock.signature`, etc.) that were hidden when the types were `any`. After fixing those, the codec has 30 remaining `eslint-disable` comments -- all for the legitimate `unicorn/no-null` rule (the Anthropic SDK requires `null` where the project linter prefers `undefined`). The Vercel codec has 0 because `UIMessage` types don't use `null`.

4. **The accumulator contract should specify that `messages` returns a stable reference.** The `MessageAccumulator` interface says `messages` returns `TMessage[]` but doesn't say whether it's the same array every time or a new copy. This matters because the transport reads `accumulator.messages` on every streaming token (potentially hundreds per response) -- allocating a new array each time is wasteful. Both the Vercel accumulator and the custom-codec example return the same array (mutated in place), but nothing in the interface documents this. Our initial Anthropic accumulator accidentally created a new array on every access (`return [...completed, ...inProgress]`). A one-line JSDoc addition would prevent this: `"Returns a stable reference — the same array instance on every access, mutated in place as events arrive."`

---

## Glossary

> Key terms as we encounter them. Will be cross-referenced with `docs/internals/glossary.md`.

| Term | Definition |
|------|-----------|
| Domain event | The `TEvent` type parameter on `Codec<TEvent, TMessage>`. The streaming chunk type used by the consuming framework -- e.g. `UIMessageChunk` for Vercel AI SDK. |
| Domain message | The `TMessage` type parameter on `Codec<TEvent, TMessage>`. The complete message type used by the consuming framework -- e.g. `UIMessage` for Vercel AI SDK. |
| EncoderCore | Ably-specific encoding machinery. Handles publish/append/update operations, serial tracking, flush/recovery. Domain encoders compose it, never extend it. |
| DecoderCore | Ably-specific decoding machinery. Handles action dispatch, serial tracking, prefix-match accumulation. Calls domain-provided hooks to build framework events. |
| Accumulator | Codec-provided component that assembles complete `TMessage`s from a stream of `TEvent` fragments. |
| Codec key | Stable identity string for a domain message, returned by `getMessageKey()`. Used by ConversationTree for upsert. **Being removed by PR #11.** |
| Lifecycle tracker | Synthesizes missing codec-level phases for mid-stream joins (e.g. client connects after `text-start` was published). |
| Own turn | A turn initiated by the current client. |
| Observer turn | A turn initiated by another client, observed via the shared channel. |
| Discrete message | A standalone Ably message (not part of a stream). Used for events like `start`, `finish`, `error`, tool outputs. |
| Serial | Ably-assigned identifier for a message, returned by `publish()`. Used to target subsequent appends to the same message. |
| Message append | Ably primitive: after publishing a message, you can append to it (adding data) or update it (replacing data), targeting it by serial. |
| Fire-and-forget | Pattern where a promise is collected but not awaited inline. Errors are batched and handled later (at flush). Used for append performance. |
