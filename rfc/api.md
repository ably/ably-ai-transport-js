# Durable AI Transport — Design

A design document for the durable-sessions API described in [AIT012.md](./AIT012.md). Concrete type signatures live in [`rfc/types/`](./types/); this document explains what the types are for, how they fit together, what semantics they guarantee, and the problems they exist to solve.

Read top-to-bottom the first time. Sections are ordered by progressive disclosure: the mental model is enough to read any example; the concept sections add depth; the implementation-detail sections surface the non-obvious rules a reader would otherwise discover by tripping over them.

---

## Problem framing

The existing AI Transport SDK conflates three concerns — the durable record of a conversation, the way each participant reads/writes it, and the Ably channel beneath — into one interwoven surface. It works for single-stream request/response, and falls apart everywhere else.

Five concrete pain points drive this redesign:

**Conversation state travels on every HTTP request.** Clients POST the message history with each call. Two devices submitting concurrently hand the agent a split-brain view of the conversation. A framework-retried invocation double-publishes the same user input and the agent processes it twice.

**Hydration is client-only.** Clients can reconstruct conversation state from channel history. Agents have no equivalent: they rely on what the HTTP request body carries. Neither side can hydrate from an external store (database, workflow state).

**Retried agents produce competing outputs.** A crashed agent leaves a `turn-start` without a `turn-end`. There is no protocol for a later invocation to discover or supersede the dead attempt. Output from the zombie turn persists alongside the retry's output, with nothing to group and discard it.

**No mid-conversation pause.** A "turn" ends when the agent process exits (one HTTP request per turn). There is no way to suspend for a tool-call approval, for additional user input, or for an external dependency. Every multi-hop workflow builds its own pause machinery.

**Abort depends on a live subscription.** Abort delivery assumes a connected channel subscriber. Anything spanning multiple agent invocations — durable-execution hops, HITL pauses, retries — has windows where no agent is listening, and an abort published in one of those windows goes nowhere.

The redesign raises **session** to a first-class durable primitive that clients and agents interact with symmetrically. It introduces **run** above single agent execution to group work that spans multiple executions, and **step** below to identify individual executions within a run. The channel becomes the oplog; the session is the materialised conversation. Invocations become lightweight HTTP pointers to channel state, not copies of that state. Abort becomes a durable message on the channel, observable on hydration.

---

## Mental model

Five abstractions, stacked:

```
┌─────────────────────────────────────┐
│ View       — linear projection      │  ← you render / read from here
├─────────────────────────────────────┤
│ Tree       — full conversation DAG  │
├─────────────────────────────────────┤
│ Session    — durable state handle   │
├─────────────────────────────────────┤
│ Codec      — domain <-> wire        │  ← translates for the transport
├─────────────────────────────────────┤
│ Channel    — Ably oplog             │
└─────────────────────────────────────┘

```

**Session** is the durable container. It wraps the Ably channel, optional storage, and the live subscription. Opening a session doesn't guarantee content; `connect()` hydrates from storage and channel history and exposes the result. A client and an agent hydrating the same session name arrive at the same state regardless of who published what when.

**Tree** is the complete conversation: every message from every branch, every run, every step, materialised from channel messages and their headers. It emits granular typed events for observers that need precise change notification — telemetry, debug, framework integrations.

**View** is a linear projection over the tree — one selected sibling at each branch point, ordered from root to leaf. Clients render from it; agents read it to pass to the model. ClientView's branch selection is mutable; AgentView's is pinned by the invocation it was created from.

**Run** is the logical unit of user intent — opened by the initiator (a client click, a backend handler, a parent agent), closed by the agent. A run can span multiple agent executions: it survives HITL pauses, durable-execution hops, and crash retries. Control signals (abort, pause, resume, retry) target a run.

**Step** is one continuous agent execution within a run. Sequential within a run by Ably's total-order guarantee. Messages published during a step carry its ID, so output from non-complete steps (failed, superseded, aborted) is identifiable and can be filtered out rather than conflated with successful output.

**Codec** is the translation layer between the domain (Vercel's `UIMessage`, Anthropic's content blocks, OpenAI Responses, etc.) and channel operations. It owns three concerns: encode outgoing parts and events, decode incoming wire messages, and accumulate the decoded pieces into complete domain messages. The transport depends on the codec contract but knows nothing about the domain model.

**Invocation** is a serialisable HTTP pointer: session name, run ID, optionally a step ID and/or message ID as preconditions. The agent waits for those preconditions to land on the channel, then reads the session and acts. The invocation itself carries no content.

---

## Concepts

### Session

A durable handle on a conversation. Type signatures: [`session.ts`](./types/session.ts).

A session is created by `createClientSession({ client, sessionName, codec, storageReader?, storageWriter? })` or `createAgentSession(...)`. The returned session is not yet live: `connect()` hydrates from the storage reader (if supplied), attaches to the channel, subscribes, and resolves. Then views start populating, and the tree begins emitting events.

`connect()` and `close()` are both **idempotent**. Calling `connect()` on a connected session is a no-op that resolves immediately — the design makes durable-execution retries cheap. `close()` is idempotent and never rejects, so it can sit safely in error-handling paths without a `try/catch`. Both interfaces also implement `[Symbol.asyncDispose]` for scope-based cleanup (`await using session = ...`).

**Writer-only sessions.** A session created without calling `connect()` can still be used to publish via `session.writer`. No tree, no subscription, no memory footprint beyond the connection. This is the serverless pattern the server-side-validation and durable-execution lifecycle hops use: a backend receives an HTTP request, validates it, publishes `x-ably-run-start` + the user message through the writer, and returns. The session is never connected and is closed immediately.

**Storage integration.** `StorageReader` (async iterable of `Ably.Message`) is drained during `connect()`. `StorageWriter` (awaited `write(message)`) receives every message the session processes, historical and live. A session hydrated from a storage reader and one hydrated from channel history arrive at the same state — neither path is privileged. Reader failures reject `connect()` via `HydrationFailed`; writer failures surface via `session.on('error')` so the caller owns the retry policy.

**Variants.** `ClientSession<C>` exposes `createView()` and a tree typed with `ClientRun<C>`. `AgentSession<C>` exposes `createView(invocation)` and a tree typed with `AgentRun<TMessage>`. The asymmetry reflects the asymmetry of control: clients branch and navigate; agents execute against one pinned branch.

### Tree

The full, unfiltered conversation structure. Type signatures: [`tree.ts`](./types/tree.ts).

Every message from every branch, every run, every step. The tree is the canonical source of conversation structure within a session; views project from it.

The tree emits granular typed events — `message-added`, `message-updated`, `run-started`, `run-updated`, `run-ended`, `step-started`, `step-updated`, `step-ended`, `control-signal`. These are the right events for framework integrations and telemetry: precise, typed, no polling. UI rendering should use a view's `subscribe()` instead — that's state-oriented and fires only on visible-output changes.

**`message-added` vs `message-updated`.** When a message is published whose ID is new to the tree, the tree fires `message-added`. When the ID already identifies an existing node, it fires `message-updated` — the codec's accumulator has either been called with `setMessage()` (same-ID republish) or with `applyEvent()` (codec event targeting the message). The node identity stays constant; the domain message inside it changes.

**Control-signal buffering.** Signals observed on subscription (live) are delivered to handlers registered at that moment. Signals observed during hydration are delivered to handlers the first time they subscribe. A pause signal that arrived while the agent was crashed fires as soon as the new agent registers its handler — no race between "register the handler" and "read the signal."

### View

A linear projection over the tree, plus a write surface. Type signatures: [`view.ts`](./types/view.ts).

A view holds a linear sequence of messages — one selected sibling at each branch point, root to leaf. Subscribe with `view.subscribe(callback)` and re-render from `view.messages` in the callback. The callback fires only when the visible sequence changes.

**ClientView** exposes mutable branch state: `select(messageId)` to switch which branch is shown at a fork, `loadMore()` to pull more history. It also exposes `view.runs` — the runs whose messages are visible in the current projection, independent of `view.messages` — so orchestration code can enumerate active runs without walking messages. It's the factory for new runs: `createRun()`, `createRegenerate(messageId, { autoSelect })`, `createEdit(messageId, { autoSelect })`. `createRegenerate` and `createEdit` fork the tree at the target message; the new run is positioned as a sibling, and by default the view auto-selects the new branch. Pass `{ autoSelect: false }` to fork without switching.

**AgentView** has no `select()` and no pagination. The invocation it was created from pins the branch — the view shows the ancestry from root down to the run's parent, then every message published within the run. The agent needs the full ancestry to pass to the model, so pagination would be a footgun. AgentView's factory produces `createStep()` — the execution surface.

**AgentView starts empty and fills during hydration.** When a view is created before `connect()` has resolved, `view.messages` is empty. It populates as the session materialises the channel and storage. `step.start()` resolves only after hydration completes, so by the time the agent calls `convertToModelMessages(view.messages...)`, the view is populated. If the agent wants to observe ancestry arriving incrementally (rare, but useful for some telemetry patterns), subscribe before `start()`.

### Run

A logical unit of user intent. Type signatures: [`run.ts`](./types/run.ts).

A run opens with `x-ably-run-start` published by the initiator and closes with `x-ably-run-end` published by the agent. In between, it may span one step or many: HITL pauses, workflow hops, and crash retries all happen under the same run ID. A run has five statuses: `active`, `suspended`, `complete`, `aborted`, `failed`.

**ClientRun** is the client-facing handle. It exposes:

- **Lifecycle:** `start()` (publish `x-ably-run-start`; throws `RunAlreadyStarted` if called twice).
- **Content:** `sendMessages(messages)`, `sendParts(parts)`, `sendEvents(events, target?)` — three shapes for three wire vocabularies (see [Codec](#codec)). All three publish against the run.
- **Control:** `abort()`, `pause()`, `resume({ stepId? })`, `retry({ stepId? })` — each publishes the corresponding control signal and returns an `Invocation` the caller POSTs to wake the agent if none is running. All four are **silent no-ops when the signal would have no effect** — e.g. aborting an already-terminal run publishes nothing. Multi-device races are idempotent by construction.
- **Observation:** `when(statuses)` resolves when the run's status enters any of the targeted set (or rejects with `RunClosed` if the session closes first). `toInvocation()` snapshots the run's ID and the last sent message's ID into a serialisable `Invocation`.

**AgentRun** is the agent-facing handle. It exposes `suspend(reason)` (publish `x-ably-run-suspend` with `awaiting-input` or `paused`) and `end(status)` (publish `x-ably-run-end` with one of the terminal statuses). `end()` is idempotent on terminal runs (publishes nothing). `suspend()` is idempotent only on already-suspended runs; on terminal runs it throws `RunAlreadyTerminal` because suspending a terminal run is an impossible transition and a loud programming error.

**`run.initiatorClientId`** carries the client ID of whoever opened the run. Derived from `x-ably-client-id` on `x-ably-run-start` when a backend published on behalf of an end-user, otherwise from the publishing connection. Stable for the lifetime of the run. This is what makes server-side validation work: the end-user's ID survives the HTTP hop into the session even though the SDK connection is the backend's.

**`run.when(statuses)`** resolves when the run's status enters any of a target set. Primary use is orchestration fan-out — a parent agent opens several child runs and `await Promise.all(children.map(c => c.when(['complete', 'failed', 'aborted'])))`. Rejects with `RunClosed` if the session closes first.

The separation between ClientRun and AgentRun enforces who owns what: the initiator opens the run; the agent closes it. The initiator never publishes `x-ably-run-end`; the agent never publishes `x-ably-run-start` (except when a subagent is fanned out from a parent agent, using the agent's session writer directly).

**Concurrency is safe by design.** Two agents invoked for the same run both try to `step.start()`. By Ably's total order one of the `x-ably-step-start` messages has an earlier serial; the later arrives at the subscription first, sees the earlier already-opened step with no matching `step-end`, and publishes `step-end` with status `superseded`. No locking, no consensus, no timeouts — the channel's order is the coordination mechanism.

### Step

One continuous agent execution within a run. Type signatures: [`step.ts`](./types/step.ts).

A step is created from an `AgentView` via `view.createStep()` and then transitions from `pending` to `active` via `step.start(options)`. The `pending` status is in-memory only — it's never materialised on the channel, because a pending step has not published `x-ably-step-start`. `StepState.status` in the tree never reads `pending`.

`start()` does three things: wait for the invocation's preconditions (the message ID, step ID, or signal the agent needs to observe before proceeding), publish `x-ably-step-start`, and resolve. The precondition wait has a default timeout of 60 seconds when neither `timeoutMs` nor `signal` is supplied, which prevents a hop from hanging forever waiting for an invocation message that never arrives. If another agent races the `x-ably-step-start` and wins, `start()` rejects with `StepSuperseded` and the step stays `pending` — no `x-ably-step-start` reached the channel, and the disposer is a no-op.

**Step-start on a suspended run implicitly reactivates it.** If the invocation targets a run currently in `suspended`, a successful `x-ably-step-start` publish transitions the run back to `active`. Publishing `x-ably-resume` is not required to ungate `start()`; the resume control signal exists to *wake* an external agent (drive a new step-start) rather than to gate step-start itself.

**The step owns the abort signal.** `step.signal` is an `AbortSignal` that aborts when either an `x-ably-abort` control signal is observed on the channel for this run, or when a caller-supplied signal passed to `start({ signal })` fires. Wire it into your model call as `abortSignal: step.signal`. The composition happens inside the SDK so callers don't write boilerplate.

**Pause handling.** Register `step.on('pause', handler)`. The handler runs when an `x-ably-pause` signal is observed. Pause signals are **buffered at the step level**: if a signal was observed before the handler was registered (during hydration, for instance), it fires immediately on subscription. This removes the order-sensitive "register before `start()`" footgun.

**Writing.** `step.pipe(stream)` pipes a `ReadableStream` of codec parts through the encoder to the channel, cancelling on abort. `step.sendMessages(messages)`, `step.sendParts(parts)`, and `step.sendEvents(events, target?)` are discrete variants.

**Terminal statuses.** `step.end(status)` publishes `x-ably-step-end` with one of `complete | failed | aborted | paused | superseded`. Idempotent on terminal steps. The `superseded` status is published automatically by the losing step in a race; callers don't pick it.

**Abandonment.** A step can exit its scope without publishing `x-ably-step-end` — an unhandled crash, for instance. The channel leaks an open step. The design handles this passively: when a later `x-ably-step-start` appears in the same run, the session marks the prior open step as `abandoned`. It's a *derived* status, inferred from the absence of a terminal closure, not something the agent sets.

**Disposer as safety net.** `[Symbol.asyncDispose]` catches scope-exit-via-thrown-error paths. If the step is `pending`, disposal is a no-op (nothing is on the channel to close). If the step is `active`, the disposer publishes a terminal `step.end()` — `aborted` if `step.signal.aborted`, else `failed` with cause `StepDisposedBeforeEnd`. If already terminal, pure cleanup. Callers should still call `step.end('complete')` explicitly on the happy path; the disposer exists for the error path.

### MessageNode

One node in the tree. Type signatures: [`message-node.ts`](./types/message-node.ts).

Carries the domain message plus transport metadata:

- `id` — unique message ID from `x-ably-msg-id`.
- `message` — the domain message in the codec's `TMessage` shape.
- `role` — `'user' | 'assistant'` — the protocol-level role derived from the publisher.
- `clientId` — attribution from `x-ably-client-id` or the publishing connection's client ID.
- `parentId` — the prior message in this branch (undefined for roots).
- `children` — IDs of forks at this node.
- `run?` — the run this message belongs to, typed to the session variant.
- `step?` — the step that produced the message (only on agent publishes).
- `streaming` — true while any part is still being appended.

**Protocol role vs domain role.** `node.role` is the transport-level role — who published (`user` for client-initiated publishes, `assistant` for agent publishes). The domain message inside `node.message` carries its own role (Vercel's `UIMessage.role`, Anthropic's content blocks, etc.) which may or may not match. HITL is the cleanest example of divergence: the client publishes an assistant-role UIMessage (domain role) through its user-role connection (protocol role). Filter by `node.role` for transport-level attribution; use the domain role for model context.

**`node.run` carries the handle.** Because `node.run` is typed to the session variant (ClientRun for ClientSession, AgentRun for AgentSession), UI code can write `node.run?.abort()` or `node.run?.sendMessages(...)` directly from a rendered node without a separate lookup through `view.runs`.

### Codec

The translation layer. Type signatures: [`codec.ts`](./types/codec.ts).

A codec is parameterised on three types:

- **`TPart`** — the streaming delta vocabulary. One unit that arrives on the wire during a streaming message (Vercel's `UIMessageChunk`, Anthropic's `content_block_delta`, OpenAI Responses' `response.*.delta`). Parts accumulate into a message.
- **`TMessage`** — the composed domain message. What `view.messages` yields. What `convertToModelMessages` consumes.
- **`TEvent`** — auxiliary operations that are neither streaming chunks nor complete messages: state transitions applied to existing messages, client-authored tool results, HITL approval responses. Defaults to `never` for codecs that don't need it. For the Vercel codec, `TEvent = AI.ToolModelMessage` covers both `addToolApprovalResponse` (via `ToolApprovalResponse` content) and `addToolOutput` (via `ToolResultPart` content) in one native AI SDK shape.

A codec produces three collaborators:

**`Encoder<TPart, TEvent>`** — stateful per-step. `encodePart(part)` opens or appends to a streaming unit and returns the Ably messages to publish. `encodeEvent(event, { messageId? })` produces a single event message, optionally tagged to a target. `close()` flushes the final message for any in-flight streaming unit.

**`Decoder<TPart, TEvent>`** — stateful across a subscription. `decode(message)` returns zero or more `DecodedValue` entries. A streaming unit may emit nothing until enough data has arrived. Each decoded value is tagged `kind: 'part' | 'event'` and carries the message ID it binds to. The decoder sees only content messages — the transport filters out lifecycle and control-signal messages first.

**`Accumulator<TPart, TMessage, TEvent>`** — state reducer. `processPart(part, messageId?)` contributes a part to a message's composed state. `applyEvent(event, messageId?)` looks up a message by ID and mutates its composed state (flipping a tool part from `approval-requested` to `approval-responded`, for instance). `setMessage(messageId, message)` replaces the composed state wholesale — the same-ID republish path. `getMessage(id)` reads current state. `completeMessage(id)` marks a message as no longer streaming.

**The division of labour:**

| Concern | Owner |
|---|---|
| Channel subscription | SDK |
| Lifecycle events (`x-ably-run-*`, `x-ably-step-*`) | SDK |
| Control signals (`x-ably-abort` etc.) | SDK |
| Attribution headers (`x-ably-client-id`, `x-ably-role`, `x-ably-run-id`, `x-ably-step-id`, `x-ably-msg-id`) | SDK |
| Tree construction and events | SDK |
| View projection | SDK |
| Invocation preconditions | SDK |
| Encoding parts and events to wire format | Codec |
| Decoding wire messages to parts and events | Codec |
| Composing parts into complete messages | Codec |
| Codec-specific headers (`x-domain-*`) | Codec |

The codec is the *only* place that understands the domain model. A new codec for a different AI SDK needs only to implement Encoder/Decoder/Accumulator; the transport, tree, views, runs, steps, and everything else work as-is.

### Invocation

A serialisable HTTP pointer. Type signatures: [`invocation.ts`](./types/invocation.ts).

```
{ sessionName, runId, stepId?, messageId? }
```

Carries no history, no message content, no parameters. The agent receives an invocation in its HTTP body, rehydrates it with `Invocation.fromJSON(data)`, creates an agent session against `sessionName`, and calls `session.createView(invocation)`. The view is pinned to `runId` and the step's `start()` waits for `messageId` (and, if set, `stepId`) to be visible before proceeding.

**Preconditions are ordered.** A step won't `start()` until the session has observed the invocation's targets. This is how pause/resume and HITL flow: the client publishes the control signal (or the HITL event), captures the signal's own message ID into the invocation, and POSTs. The next agent's `step.start()` blocks until that exact wire message is visible — guaranteeing the agent sees the approval, the resume, or whatever state change the client just published.

**The decoupling matters.** An invocation is cheap to retry, to replicate, to queue. Durable-execution frameworks can retry indefinitely without consequence: every invocation describes preconditions already on the channel, not state that needs to be replayed. A dropped invocation can be retried from the client's original information, and the agent will either find the run already complete (idempotent) or resume from where the durable state says.

`Invocation` is a merged type+value symbol: the interface defines the instance shape, the const exposes `Invocation.fromJSON(data)`. Consumers write `Invocation.fromJSON(data)` and reference `Invocation` in type position from the same identifier. `fromJSON` is a trust-boundary validator — it throws `InvocationInvalid` when the input doesn't describe a valid invocation (missing `sessionName` or `runId`), so agent entry points can call it on the raw HTTP body without separate validation.

### ControlSignal

SDK-owned and codec-independent. Type signatures: [`control-signal.ts`](./types/control-signal.ts).

Four signal types: `abort`, `pause`, `resume`, `retry`. Each carries a `runId` (always) and optionally a `stepId` (meaningful only on `resume` and `retry` for step-level targeting). Each also carries its own `messageId` — the signal's wire-level ID — which the client uses as an invocation precondition when waking the agent in response to the signal.

Signals are content-free: no domain payload, no codec involvement. That's what lets the transport buffer them, replay them during hydration, and reason about them without knowing the domain model.

Delivered via `Tree.on('control-signal', handler)`. The common step-scoped pause case has a shortcut: `step.on('pause', handler)` delivers the same signal on a simpler handler signature and buffers at the step level.

### Storage

Pluggable interfaces for hydration and persistence. Type signatures: [`storage.ts`](./types/storage.ts).

**`StorageReader`** — `read()` returns an `AsyncIterable<Ably.Message>` yielding messages in serial order. Drained during `connect()`. Used to hydrate sessions from databases, durable-execution framework state, or any other ordered source.

**`StorageWriter`** — `write(message)` is called for every message the session processes (historical during hydration, live after). The writer owns batching, retry budget, and error handling internally. The session awaits each write call but does not itself retry. When the writer has exhausted its retry budget and ultimately fails, the session surfaces `StorageWriteFailed` via `session.on('error')`. This division keeps retry policy in the writer (where the application has context about what's recoverable) and error surfacing in the session (one place to subscribe for all failure modes).

The readiness of these hooks makes the channel one implementation choice among several: a database reader + session with no channel connection is a valid reader; a Postgres-backed writer is a valid persistence target. The protocol is durable-execution-agnostic.

### SessionWriter

The low-level publish surface. Type signatures: [`writer.ts`](./types/writer.ts).

Views, runs, and steps delegate to the writer internally. Direct access to the writer is exposed at the session level for advanced patterns:

- **Server-side validation.** A backend handler publishes `x-ably-run-start` and the user message directly on behalf of the end-user, setting `clientId` to the end-user's clientId so attribution survives the hop. The session is writer-only — no `connect()`, no tree.
- **Orchestration.** A parent agent fanning out to subagents opens child runs with `session.writer.startRun({ runId, clientId })` and publishes into them without creating intermediate view/run objects.
- **Lifecycle-only hops.** Durable-execution workflow stages that only need to publish `x-ably-run-end` or `x-ably-step-end` open a writer-only session, publish, and close.

The writer's methods mirror every publishable wire event:

- **Runs:** `startRun`, `suspendRun`, `endRun`.
- **Steps:** `startStep`, `endStep`.
- **Content:** `sendMessages`, `sendParts`, `sendEvents`.
- **Control:** `abort`, `pause`, `resume`, `retry`.

Every method takes `runId` to target the run (run lifecycle methods return the generated ID). Every method accepts an optional `clientId` override for attribution.

---

## The channel as oplog

The channel is an append-only, totally-ordered log of messages. Every piece of session state — messages, runs, steps, signals, events — is one or more entries on that log. Two participants processing the log from the same starting point arrive at the same state. This is the property that makes sessions durable, multi-device continuity trivial, and durable-execution retries safe.

### Wire message names

Lifecycle events (SDK-owned):

| Name | Purpose |
|---|---|
| `x-ably-run-start` | Open a run. |
| `x-ably-run-suspend` | Transition a run to `suspended` without closing. |
| `x-ably-run-end` | Close a run terminally. |
| `x-ably-step-start` | Open a step. |
| `x-ably-step-end` | Close a step terminally. |

Control signals (SDK-owned):

| Name | Purpose |
|---|---|
| `x-ably-abort` | Abort a run. |
| `x-ably-pause` | Pause a run. |
| `x-ably-resume` | Resume a suspended run, optionally from a specific step. |
| `x-ably-retry` | Retry a terminal run or step. |

Content (codec-owned):

| Name | Purpose |
|---|---|
| `x-ably-message` | A complete domain message (whole-message publish or same-ID republish). |
| `x-ably-event` | A codec event (`TEvent`) — state transition, approval response, tool result. |
| `x-domain-*` | Codec-defined per-part streaming chunks (e.g. Vercel's text/tool/reasoning chunks). |

### Headers

Transport-level headers are in the `x-ably-*` namespace; codec-specific headers go in `x-domain-*` so the two don't collide.

Identity and attribution:

- `x-ably-msg-id` — the message ID. Shared across every chunk of a streaming message, and used as the target of events that bind to an existing message.
- `x-ably-client-id` — optional override of the publishing connection's client ID, used when a backend publishes on behalf of an end-user.
- `x-ably-role` — `user` or `assistant`; the protocol-level role.

Correlation:

- `x-ably-run-id` — set on every message related to a run (content, lifecycle, signals).
- `x-ably-step-id` — set on agent-published content and on step lifecycle events; absent on client publishes and run-lifecycle events.

Structure:

- `x-ably-parent` — the message ID this one is positioned under in the tree (forks use this).
- `x-ably-fork-of` — the message ID this one forks from (regenerate and edit use this).

Lifecycle status:

- `x-ably-status` — on `x-ably-run-suspend` / `x-ably-run-end` / `x-ably-step-end`: one of the terminal or suspend values (`awaiting-input`, `paused`, `complete`, `aborted`, `failed`, `superseded`).

### Read path

```
channel message
  │
  ├─ is lifecycle (x-ably-run-*, x-ably-step-*)
  │     → SDK updates run/step state, emits tree events
  │
  ├─ is control signal (x-ably-abort|pause|resume|retry)
  │     → SDK buffers + delivers via Tree.on('control-signal') / Step.on('pause')
  │
  └─ is content (x-ably-message, x-ably-event, x-domain-*)
        → codec.Decoder.decode(message) → DecodedValue[]
        ├─ kind: 'part'
        │     → codec.Accumulator.processPart(part, messageId)
        │     → tree fires 'message-added' (first part) or 'message-updated' (subsequent)
        │
        └─ kind: 'event'
              → codec.Accumulator.applyEvent(event, messageId)
              → tree fires 'message-updated' if composed state changed
```

### Write path

```
view.createRun() / run.sendMessages() / step.pipe() / run.abort() / ...
  │
  └─ SessionWriter method
        │
        ├─ is lifecycle / control
        │     → SDK encodes directly, adds x-ably-* headers
        │
        └─ is content
              → codec.Encoder.encodePart|encodeEvent → Ably.Message[]
              → SDK attaches x-ably-msg-id, x-ably-run-id, x-ably-step-id, x-ably-client-id, x-ably-role
              → channel.publish
              → message echoes back through the read path (same session sees its own publish)
```

---

## Worked example: basic streaming chat

Before the HITL walkthrough, the shape of the simplest possible round-trip. The client sends one message, the agent streams one response, done. Full example: [`rfc/types/examples/vercel-serverless/basic-chat/`](./types/examples/vercel-serverless/basic-chat/).

1. **Client opens the run.** `view.createRun()` returns a `ClientRun` positioned at the current branch tip. `run.start()` publishes `x-ably-run-start` to the channel.
2. **Client publishes the user message.** `run.sendMessages({ id, role: 'user', parts: [...] })` publishes an `x-ably-message` with `x-ably-msg-id = <id>`, `x-ably-run-id = <runId>`, `x-ably-role = user`. The message ID is caller-supplied (the codec's message type owns it).
3. **Client POSTs the invocation.** `fetch('/api/agent', { body: run.toInvocation().toJSON() })` carries `{ sessionName, runId, messageId }`. `messageId` is the user message's ID — the agent must see it before starting.
4. **Agent wakes.** The handler calls `Invocation.fromJSON(body)`, opens an agent session with the same `sessionName`, calls `session.connect()` (hydrates + subscribes), `view = session.createView(invocation)`, `step = view.createStep()`, `await step.start({ signal: req.signal })`. `start()` waits until the session has observed the user message, then publishes `x-ably-step-start`.
5. **Agent streams.** The handler calls `streamText({ messages: await convertToModelMessages(view.messages.map(n => n.message)), ... })` and `step.pipe(result.toUIMessageStream())`. The codec encodes each chunk into a wire message with `x-ably-msg-id = <assistantId>`, `x-ably-run-id`, `x-ably-step-id`, and publishes. The client sees the chunks arrive via its subscription, the accumulator composes them, views re-render.
6. **Agent closes.** `step.end('complete')` publishes `x-ably-step-end`; `view.run.end('complete')` publishes `x-ably-run-end`. The run is terminal; the session reflects it.

Five wire events for a basic one-message exchange: the run-start, the user message, the step-start, the streaming chunks (one per chunk), the step-end, the run-end. Every header is automatic; the client called four methods, the agent called four.

## Worked example: HITL tool approval

This is the most illuminating scenario for understanding how the pieces compose, because it exercises every layer: views, runs, steps, events, invocations, preconditions, and the codec accumulator. The full example code lives in [`rfc/types/examples/vercel-serverless/hitl-tool-approval/`](./types/examples/vercel-serverless/hitl-tool-approval/).

### Setup

A client and an agent share a session. The agent has a tool that requires user approval before executing. The codec is the Vercel one with `TEvent = AI.ToolModelMessage`.

### Turn 1 — the agent streams and stops

The client publishes `x-ably-run-start`, then its user message (`x-ably-message`), then POSTs an invocation to the agent endpoint with the user message's ID as a precondition.

The agent rehydrates the invocation, opens an agent session, creates a view, creates a step, and calls `step.start({ signal: req.signal, timeoutMs: 60_000 })`. Once the precondition is satisfied and `x-ably-step-start` is published, the agent calls `streamText(...)` and pipes `result.toUIMessageStream()` through the step.

The model chooses to call a tool that has `needsApproval: true`. AI SDK v6 surfaces this as a `tool-${name}` part in state `approval-requested` with an `approval: { id }` field. The codec emits that as streaming chunks on the wire. When the stream ends, the agent calls `step.end('complete')` — the step itself finished normally.

Only *then* does the agent inspect the final assistant message. If any tool part is in state `approval-requested`, it calls `view.run.suspend('awaiting-input')`. If not, it calls `view.run.end('complete')`. The step-end is about the execution; the run-suspend is about whether the user's intent is satisfied yet.

The channel now holds: `x-ably-run-start`, user's `x-ably-message`, `x-ably-step-start`, a sequence of streaming chunks, `x-ably-step-end` (status `complete`), `x-ably-run-suspend` (status `awaiting-input`).

### Turn 2 — the client publishes the approval

The client's view fires `subscribe()`; the UI renders the pending approval prompt. The user clicks approve.

```ts
await run.sendEvents(
  {
    role: 'tool',
    content: [
      { type: 'tool-approval-response', approvalId, approved: true, reason: 'OK to run' },
    ],
  },
  { messageId: assistantMessageId },
);

await fetch('/api/agent', {
  method: 'POST',
  body: JSON.stringify(run.toInvocation().toJSON()),
});
```

On the wire, this is **one `x-ably-event` message**. Headers: `x-ably-msg-id = assistantMessageId`, `x-ably-run-id = runId`, `x-ably-client-id` set. Payload: the native `AI.ToolModelMessage` JSON. No mutation of the assistant message, no full-message republish — one additive op.

### Turn 2 continued — the codec composes state

The channel echoes the event back to the client's subscription (and to any other clients on the session — multi-device gets this for free).

```
  channel → decoder.decode(eventMessage)
         → [{ kind: 'event', event: toolModelMessage, messageId: assistantMessageId }]
         → accumulator.applyEvent(event, assistantMessageId)
```

The accumulator looks up the assistant message by ID, walks its parts, finds the `tool-${name}` part whose `approval.id` matches, and transitions its state to `approval-responded` with `{ id, approved, reason }`. The tree fires `message-updated`. Any view containing the message re-renders.

### Turn 3 — the agent wakes and resumes

The POST from Turn 2 reaches the agent endpoint. The agent rehydrates the invocation (whose `messageId` is the event's wire ID from Turn 2), opens a session, creates a view, creates a step, calls `step.start()`. `start()` blocks until the session observes the event with that ID.

The step publishes `x-ably-step-start`. The agent calls `convertToModelMessages(view.messages.map((n) => n.message))`. AI SDK v6 walks the tool parts: the part whose `approval.approved` is set gets synthesised into a `tool-approval-response` inside a `role: 'tool'` model message. That's what `streamText` consumes — it now executes the tool, streams the result, and eventually closes out normally.

### What this shows

- **The oplog composes.** The wire held one additive event; the composed state is the result of the codec's accumulator applying it to the prior message.
- **Preconditions serialise the HTTP round-trip with the channel.** The new agent doesn't start until it sees the client's event — no race, no missed state.
- **The codec contains the domain knowledge.** The transport doesn't know what a `tool-approval-response` is, and the agent code uses stock AI SDK functions throughout.
- **Multi-device is free.** Another client on the same session name subscribes to the same channel, runs the same decoder + accumulator against the event, and arrives at the same composed state. No coordination, no extra wiring — session state is a pure function of the oplog.

---

## Supported scenarios

Examples for each scenario live under [`rfc/types/examples/`](./types/examples/), with parallel versions for serverless agent endpoints and durable-execution workflows.

- **basic-chat** — The baseline. Session setup, view creation, run lifecycle, streaming a single response.
- **multi-device** — Two clients on the same session name. Both hydrate from history and see the same state; either can abort.
- **regenerate** — `view.createRegenerate(messageId)` forks at a prior assistant message. The original is preserved; the new branch is the default selection.
- **steering** — Client publishes a user message mid-run; the agent observes it on the next loop iteration.
- **prompt-chaining** — One agent output triggers a second agent run. Runs are independent units; chaining is just a new run.
- **retry-after-failure** — Client observes a failed step, publishes `x-ably-retry` with the failed step's ID, and POSTs with the retry signal's message ID as precondition. A new step picks up.
- **abort-and-pause** — Covers both the live case (agent is running and sees the signal) and the offline case (agent crashed, signal is discovered on hydration).
- **hitl-tool-approval** — Walk-through in the section above.
- **server-side-validation** — Backend handler publishes `x-ably-run-start` and the user message on behalf of the user after validating. Writer-only session; client never publishes directly.
- **subagent-fanout** — Parent agent opens multiple child runs concurrently via `session.writer.startRun(...)`; each child has an independent invocation.

---

## Important implementation details

The non-obvious rules that a reader of the types should know up front.

**Same-ID republish vs event.** When you publish a message whose ID already exists in the tree, the transport routes it through `Accumulator.setMessage()` — a whole-message replace. Tree fires `message-updated`. This is the primitive for full-message corrections and cross-step amendments. For **additive state transitions** (HITL approvals, client-authored tool outputs), use `sendEvents(event, { messageId })` instead — the codec's `applyEvent` mutates composed state without replacing the message. Choose based on the semantics: replacing the whole message, or applying a delta to it.

**Pre-existing signals are buffered.** Any control signal observed during hydration (pause, abort, resume, retry) is delivered to handlers registered after hydration completes. The common case is an agent being invoked to handle a pause signal that arrived while no agent was running — the agent's `step.on('pause', ...)` fires immediately on subscription. `step.signal.aborted` is already `true` after `start()` resolves if an abort was waiting.

**Step-supersede is automatic.** If two agents race `step.start()`, the later one observes the earlier `x-ably-step-start` with no matching `step-end` and publishes `step-end` with status `superseded`. The loser's `start()` rejects with `StepSuperseded`. Callers in retry loops can distinguish a legitimate failure (should retry) from a race loss (shouldn't) by catching this specific error code.

**Abandonment is derived.** A crashed step leaves `x-ably-step-start` with no terminal event. When a later `x-ably-step-start` appears in the same run, the session materialises the prior open step as `abandoned`. The agent doesn't have to detect its own crashes; the presence of a subsequent step is evidence.

**Idempotence is pervasive.** `connect()`, `close()`, `AgentRun.end()`, `AgentRun.suspend()` (on already-suspended), step `[Symbol.asyncDispose]`, control-signal publishes on a run where the signal would have no effect — all are idempotent no-ops. This is deliberate: durable-execution frameworks retry code paths, and the SDK is safe under retry without the caller needing guards. `run.start()` is *not* idempotent (it throws `RunAlreadyStarted`) because opening a run twice is an orchestration bug that should be loud.

**Invocation preconditions pair with publishes.** The pattern is always: publish something, capture its message ID, include it in the invocation. For control signals (abort/pause/resume/retry), the returned `Invocation` from the method already has this wired — the caller POSTs it as-is. For HITL events, the caller builds the invocation via `run.toInvocation()` after the event has been published — `toInvocation()` captures the last sent message ID automatically.

**Writer-only sessions skip hydration.** A session that is created but never `connect()`-ed has no tree, no subscription, no memory footprint beyond the Ably client. `session.writer` can still publish. This is how serverless input-validation handlers, orchestration code, and durable-execution lifecycle hops avoid materialising the full session just to publish one event.

**Streaming messages are partially rendered.** `node.streaming === true` indicates that more parts are still expected. The composed `node.message` is the current best-effort state. Subscribe to the view for `message-updated` events and re-render; don't render partial state as if it were final.

**Pause handler buffering is at the step level.** Signals observed before a handler is registered are delivered on first subscription. There's no registration race; you can register handlers any time between `createStep()` and `step.end()`.

---

## Error codes

All SDK-specific errors are `Ably.ErrorInfo` instances with codes in the `104xxx` reserved range. The full enum lives in [`errors.ts`](./types/errors.ts). Groupings:

| Range | Group |
|---|---|
| `104000–104001` | Transport (send failure, subscription error). |
| `104021` | Step disposer safety net. |
| `104100–104101` | Session lifecycle (session closed, hydration failed). |
| `104199–104201` | Run lifecycle (double-start, already-terminal suspend, closed). |
| `104300–104302` | Step lifecycle (superseded, precondition timeout, start aborted). |
| `104400–104402` | View and invocation (view closed, node not found, invalid invocation). |
| `104500` | Storage writer failure. |

Each code corresponds to one specific recoverable or programming-error condition; the error messages and the JSDoc on the enum values describe the exact trigger.

---

## Where to look next

| What | Where |
|---|---|
| Full type signatures for every interface | [`rfc/types/`](./types/) |
| Working example for each supported scenario | [`rfc/types/examples/`](./types/examples/) |
| Original design motivation and problem statement | [`rfc/AIT012.md`](./AIT012.md) |
| Log of design decisions with rationale | [`rfc/decisions.log`](./decisions.log) |
| Canonical error definitions | [`rfc/types/errors.ts`](./types/errors.ts) |
| Wire-level control signal shape | [`rfc/types/control-signal.ts`](./types/control-signal.ts) |

The types directory is organised to match the concept sections of this document — one file per concept, with JSDoc on every exported symbol that repeats the semantics described here. When something in this document seems ambiguous, the types file is the source of truth.
