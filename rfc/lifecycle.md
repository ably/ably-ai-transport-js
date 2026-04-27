# Run and step lifecycle

A design document for the run and step lifecycle API. Specifies the full contract for how a client opens a run, how an agent executes it, how abort and pause flow through the signal, how resume and retry work, and how every terminal-state combination is inferred from inputs callers already hold.

Read this after [`api.md`](./api.md). The mental model, the channel-as-oplog framing, and the type-level overview live there; this document is the lifecycle-focused spec — what the caller writes, and what the SDK does.

---

## 1. Overview

A **session** is the durable handle on a conversation. A **run** is the logical unit of user intent inside a session. A **step** is one continuous agent execution inside a run. Sessions are long-lived; runs span one or more agent executions (HITL pauses, crash retries, workflow hops); steps are single contiguous executions with exactly one pair of `x-ably-step-start` / `x-ably-step-end` on the wire.

A run progresses through `active → (suspended? → active?)* → {complete | aborted | failed}`. A step progresses through `pending → active → {complete | failed | aborted | paused | superseded | abandoned}`. Both pairs compose: the run's terminal state is reached by the agent observing whatever mix of step outcomes, signals, and errors it sees and calling `run.end(error?)` or `run.suspend(reason)`. The SDK does the bookkeeping; the caller writes the interesting code.

The full hello-world agent:

```ts
export const POST = async (req: Request): Promise<Response> => {
  const invocation = Invocation.fromJSON((await req.json()) as InvocationData);
  await using session = createAgentSession({ client: ably, sessionName: invocation.sessionName, codec });
  await session.connect();
  await using run = session.createRun(invocation);
  await using step = run.createStep();
  await step.start({ signal: req.signal, timeoutMs: 60_000 });
  try {
    const result = await agent.stream({
      messages: await convertToModelMessages(run.view.messages.map((n) => n.message)),
      abortSignal: step.signal,
    });
    await step.pipe(result.toUIMessageStream());
    await step.end();
    await run.end();
  } catch (error) {
    await step.end(error);
    await run.end(error);
    if (!step.signal.aborted) throw error;
  }
  return new Response(undefined, { status: 202 });
};
```

The catch rethrows only when the error was not caused by a signal (abort or pause). Caller-initiated cancellation returns a 202 — the run's terminal state landed on the channel as expected. Genuine failures bubble to the HTTP framework as 5xx.

Two calls do the classifying: `step.end()` and `run.end()`. Each derives its terminal status from inputs the SDK already holds — the caller's error (or lack of one), the step signal's abort status, the signal's reason, and the last step's recorded signal reason. Every other call (`connect`, `createRun`, `createStep`, `start`, `pipe`) is mechanical.

---

## 2. Core primitives

### Session

Type signatures: [`session.ts`](./types/session.ts).

- `createClientSession(options)` and `createAgentSession(options)` are factory functions. Both return a handle that is not yet live.
- `session.connect()` hydrates from the storage reader (if supplied), subscribes to the channel, and resolves. Idempotent.
- `session.close()` unsubscribes, tears down views, and never rejects. Idempotent.
- `session[Symbol.asyncDispose]()` is equivalent to `close()` — it releases subscriptions and does **not** publish anything. Sessions have no lifecycle on the wire, only local resources.

Sessions can be used writer-only: a session created without `connect()` has `session.writer` for direct publishes with no tree or subscription. This is the serverless server-side-validation pattern.

### Run

Type signatures: [`run.ts`](./types/run.ts).

A run has five statuses:

| Status        | Meaning                                                                       |
| ------------- | ----------------------------------------------------------------------------- |
| `'active'`    | `x-ably-run-start` has landed and no run-end or run-suspend has superseded it. |
| `'suspended'` | A `x-ably-run-suspend` is the latest run-lifecycle event.                     |
| `'complete'`  | A `x-ably-run-end` with status `complete` is the latest run-lifecycle event.  |
| `'aborted'`   | A `x-ably-run-end` with status `aborted`.                                     |
| `'failed'`    | A `x-ably-run-end` with status `failed`.                                      |

A step-start on a `'suspended'` run implicitly returns it to `'active'` (see `step.ts:117-122`) — the resume control signal *wakes an agent*; the new step-start is what transitions the run.

**Creating a run.**

- Client: three verb methods on the view open a run atomically (one batch publish per method) and return a live `ClientRun`:
  - `view.send(messages)` — new run at the current branch tip, publishes the user message(s).
  - `view.regenerate(messageId, opts?)` — forks at the given message; publishes no user message.
  - `view.edit(messageId, messages, opts?)` — forks at the given message, publishes a replacement message.
- Client escape hatch: `view.createRun(opts?)` returns a `ClientRun` that is **not yet live** — the caller drives `run.start()` and `run.sendMessages(...)` manually. Reach for this only when the verb methods don't fit (custom batched publishes, delayed start, etc.).
- Agent: `session.createRun(invocation)` returns an `AgentRun` bound to the run ID the invocation names. The run already exists on the channel; the agent never publishes `x-ably-run-start`.

**Readable state.**

```ts
interface Run<TMessage> {
  readonly id: string;
  readonly status: RunStatus;
  readonly initiatorClientId: string;
  readonly suspendReason?: SuspendReason;
  readonly steps: readonly StepState[];
  readonly messages: readonly MessageNode<TMessage>[];
  when(statuses: RunStatus[]): Promise<RunStatus>;
  toInvocation(): Invocation;
}
```

`run.view` (`AgentRun` only) is the linear read projection for the run: ancestry from root plus this run's messages, in order. It is what the agent passes to the model.

**`run.lastStep`** *(new)* — `StepState | undefined`. The most recent step observed on this run, or `undefined` if no step has ever been materialised. Reads directly from the tree. Available on both `ClientRun` and `AgentRun`. Used by the run terminal classifier and available to callers who want to inspect step outcome without walking `run.steps`.

**Lifecycle.**

- Client: the verb methods (`view.send`/`regenerate`/`edit`) open the run for you and return a live handle. `run.start()` is still exposed for the escape-hatch `view.createRun()` path — publish once; throws `RunAlreadyStarted` on second call.
- Agent: `run.suspend(reason)`, `run.end(error?)`. Both idempotent on the terminal-state they'd land in; `run.suspend()` on a terminal run throws `RunAlreadyTerminal`. `run.end()` is the single-method, single-argument form — see §3.

**Disposal.**

```ts
run[Symbol.asyncDispose](): Promise<void>
```

Releases the local `AgentView` subscription. Does **not** publish `x-ably-run-end` and does not affect channel state. Call `run.end(error?)` explicitly before scope exit.

### Step

Type signatures: [`step.ts`](./types/step.ts).

A step is created from a run and transitions from `pending → active` via `step.start(options)`. The caller composes the model call against the step's signal, publishes output, and ends the step.

**Readable state.**

```ts
interface Step<C extends AnyCodec> {
  readonly id: string;
  readonly status: StepStatus;
  readonly signal: AbortSignal;
  readonly abortSignal: AbortSignal;  // new — see below
  start(options?: StepStartOptions): Promise<void>;
  end(error?: unknown): Promise<void>;
  on(event: 'pause', handler: () => void): void;
  off(event: 'pause', handler: () => void): void;
  pipe(stream: ReadableStream<CodecPart<C>>): Promise<void>;
  sendMessages(messages: CodecMessage<C> | CodecMessage<C>[]): Promise<void>;
  sendParts(parts: CodecPart<C> | CodecPart<C>[]): Promise<void>;
  sendEvents(events: CodecEvent<C> | CodecEvent<C>[], target?: SendEventsTarget): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}
```

**`step.signal` vs `step.abortSignal`.**

- `step.signal` is the **broad** cancellation signal, and is **the default wiring for model SDKs**. It aborts when any of the following happens:
  - An `x-ably-abort` control signal is observed on the channel (`signal.reason === ABORTED`).
  - An `x-ably-pause` control signal is observed on the channel (`signal.reason === PAUSED`).
  - A caller-supplied signal passed to `start({ signal })` fires — the reason is whatever the caller's signal carried (typically `ABORTED` when the runtime's cancellation fires, e.g. `req.signal.reason`).

  Wire this into your model call in the common case: both abort and pause should interrupt the stream.

- `step.abortSignal` is the **narrow opt-in** abort-only signal. It aborts only for hard abort (`x-ably-abort`), step precondition timeout, and the caller-folded `req.signal`. It does **not** fire on pause. Use this when the handler wants pause to not interrupt an in-flight stream — the handler lets the current response finish, then the run classifier picks `suspend('paused')` at `run.end()` time from the observed pause.

Two signals, one abstraction: the caller chooses interruption granularity by picking which signal to pass into the model SDK.

**Pause-as-signal-reason.** The SDK exports two symbol sentinels:

```ts
export const ABORTED: unique symbol;
export const PAUSED: unique symbol;
```

`step.signal.reason` is one of these after `step.signal.aborted` becomes true. Composing `AbortSignal.any([step.signal, pauseCtrl.signal])` is no longer necessary — `abortSignal: step.signal` is correct for both cases in the common handler shape.

**Write methods.** `pipe`, `sendMessages`, `sendParts`, `sendEvents` — all publish content tagged to the step via `x-ably-step-id`. See `step.ts` for full contracts.

**Disposer.** `step[Symbol.asyncDispose]()` is a pessimistic safety net:

- `status === 'pending'` → no-op. `start()` never resolved; no `x-ably-step-start` reached the channel.
- `status === 'active'` → publishes a terminal `x-ably-step-end`:
  - `step.signal.aborted` is true → `step.end('aborted')`.
  - Otherwise → `step.end('failed')` with cause `StepDisposedBeforeEnd` (error code `104021`).
- Terminal → pure cleanup; the idempotent `end()` contract means the prior explicit end is not clobbered.

### Disposer behaviours at a glance

| Scope   | Publishes?                                             | Releases                           |
| ------- | ------------------------------------------------------ | ---------------------------------- |
| Session | Never                                                  | Channel subscription, views        |
| Run     | Never                                                  | Local `AgentView` subscription     |
| Step    | Only when `status === 'active'` (pessimistic terminal) | Signal listeners, stream references |

Run and session disposers are local-only because lifecycle is a durable protocol fact — a leaked disposer must not produce a terminal event. The step disposer is the exception: an active step with no channel terminal would look like a dangling stream, so the SDK publishes a best-effort `'aborted'` or `'failed'` on the caller's behalf.

---

## 3. Terminal state inference

The primary ergonomic change in this RFC: `step.end(error?)` and `run.end(error?)` are **single-method, single-argument** forms that derive their status from inputs the SDK already holds. No explicit-status overload.

### Step inference

`step.end(error?)` routes to:

| Inputs                                                   | Step terminal |
| -------------------------------------------------------- | ------------- |
| `error === undefined`, `!signal.aborted`                 | `'complete'`  |
| `error === undefined`, `signal.aborted` (late)           | `'complete'`  |
| `error !== undefined`, `signal.reason === ABORTED`       | `'aborted'`   |
| `error !== undefined`, `signal.reason === PAUSED`        | `'paused'`    |
| `error !== undefined`, `signal.aborted`, other reason    | `'aborted'`   |
| `error !== undefined`, `!signal.aborted`                 | `'failed'`    |

**Rationale.**

- `error === undefined` → the handler reached a point where it considered the step successful. A late abort or pause that arrives after the handler decided "done" cannot unwind completed work — the observable outcome is a completed response.
- `error !== undefined` and `signal.aborted` → the throw is attributable to the signal. The signal's reason picks which terminal: `PAUSED` for durable pause observed on the channel, anything else (including `ABORTED`, caller-folded `req.signal`, and step-start timeout) for hard abort.
- `error !== undefined` and not aborted → the handler threw for its own reasons. `'failed'` with the caller's error as cause.

**Pending-step no-op.** If `step.end(error)` is called while `status === 'pending'` — `start()` never resolved, so no `x-ably-step-start` reached the channel — the call is a silent no-op, matching the `pending` disposer semantics. Publishing a step-end for a step the channel never saw the step-start for would emit garbage.

**SDK-owned terminals.** `'superseded'` and `'abandoned'` are never caller-facing. The SDK picks `'superseded'` when a concurrent step-start wins the race at `step.start()` time; `'abandoned'` is a tree-side classification for orphaned steps and is never published on the wire. No explicit-status form reaches those terminals.

**On the wire.** Each row above maps to one `x-ably-step-end` publish with `x-ably-status` set to the chosen terminal. On the `'failed'` row, the SDK serialises `error.message` onto the wire headers; when `error` is an `Ably.ErrorInfo`, its `code` is also serialised. Downstream consumers read both for observability. The idempotent contract means a subsequent call is a no-op.

**Disposer interaction.** If the handler exits scope without calling `step.end()` explicitly (an unexpected throw during setup, or a call that skipped the try block), the disposer publishes the pessimistic terminal per §2. The explicit-call path is the primary path; the disposer exists so an unhandled control-flow break does not leak a half-open step on the channel.

### Run inference

`run.end(error?)` routes to:

| Inputs                                                                      | Routes to                 |
| --------------------------------------------------------------------------- | ------------------------- |
| `error` given, `signal.reason === ABORTED`                                  | `run.end('aborted')`      |
| `error` given, `signal.reason === PAUSED` or `lastStep.status === 'paused'` | `run.suspend('paused')`   |
| `error` given, otherwise                                                    | `run.end('failed')`       |
| no `error`, `lastStep?.status === 'paused'`                                 | `run.suspend('paused')`   |
| no `error`, `lastStep?.signalReason === PAUSED`                             | `run.suspend('paused')`   |
| no `error`, otherwise                                                       | `run.end('complete')`     |

The classifier reads **the last step**, not the run as a whole. `StepState.signalReason` (proposed addition — see §6) is whatever `step.signal.reason` held at the moment the step ended, frozen onto the state at `step.end()` time. If the signal never aborted during that step, `signalReason` is `undefined`.

**Rationale.**

- `error` with `ABORTED` reason overrides pause. A hard abort is a caller demand to stop; it wins over a coincident pause.
- `error` with `PAUSED` reason or a `lastStep.status === 'paused'` routes to `suspend`. The run is not terminal; it is paused pending resume.
- `error` otherwise → `'failed'`. The error object is recorded as cause.
- No `error`, `lastStep.status === 'paused'` → the last step ended paused on purpose (case b below). The run is paused.
- No `error`, `lastStep.signalReason === PAUSED` → the step observed pause but completed anyway (case a below). Still `suspend`.
- No `error` otherwise → `'complete'`. The happy path.

**Draining pause with a later step.** In a multi-step run, if step 1 observes pause and completes (`signalReason === PAUSED`, `status === 'complete'`) but the handler then starts step 2 which runs cleanly (`signalReason === undefined`, `status === 'complete'`), `run.end()` reads *step 2* and picks `'complete'`. Step 2's fresh signal state drains the pause: the handler's explicit decision to keep going overrides the earlier pause observation. Users who want to honour the pause either don't start a second step, or call `run.suspend('paused')` explicitly before the second step's scope.

**On the wire.** Each row above maps to exactly one of `x-ably-run-end` (with `complete`/`aborted`/`failed`) or `x-ably-run-suspend` (with `paused`). The `'failed'` row carries the same error-header serialisation as `step.end()` — `error.message` and (for `Ably.ErrorInfo`) `error.code`.

**Ordering with explicit `run.suspend()`.** If the handler calls `run.suspend('awaiting-input')` in the try block and a later catch hits `run.end(error)`, the forward transition from `suspended` to a terminal is legal per `run.ts:351-359`. `run.end()` honours the error and routes to `'failed'`/`'aborted'`/`suspend('paused')` as the inference table says. `run.end()` is idempotent on the status it would otherwise re-pick, not on the status a prior `suspend()` landed.

**Disposer interaction.** `run[Symbol.asyncDispose]` never publishes. The run's terminal publish must come from an explicit `run.end()` or `run.suspend()` call. The LIFO ordering of `await using` guarantees `step[Symbol.asyncDispose]` runs before `run[Symbol.asyncDispose]`, so if the caller skips `run.end()` in the error path, the step disposer still publishes the step terminal correctly — only the run terminal is missing. A later agent hop observes the step terminal and either retries (if the initiator publishes `x-ably-retry`) or leaves the run in the last explicit run state. Run durability is a protocol fact, not a disposer responsibility.

---

## 4. Control signals

Four signals. SDK-owned, codec-independent. Shape fixed by the wire protocol. Type signature: [`control-signal.ts`](./types/control-signal.ts).

| Signal   | Who publishes                                         | What the agent observes                                                           | Carries `stepId`                 |
| -------- | ----------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------- |
| `abort`  | `run.abort()` or `session.writer.abort(options)`      | `step.signal.aborted === true`, `step.signal.reason === ABORTED`                  | No                               |
| `pause`  | `run.pause()` or `session.writer.pause(options)`      | `step.signal.aborted === true` with `reason === PAUSED`; `step.on('pause')` fires | No                               |
| `resume` | `run.resume({ stepId? })` or `session.writer.resume(options)` | Wakes a new agent via the returned `Invocation`; no signal on `step.signal` | Yes — optional checkpoint target |
| `retry`  | `run.retry({ stepId? })` or `session.writer.retry(options)`   | Wakes a new agent via the returned `Invocation`; new step picks up work     | Yes — optional step-level retry  |

Writer paths exist on both `ClientSession` and `AgentSession` per `writer.ts:292-301` — backends that publish control signals on behalf of an end-user use the writer surface and set `clientId` for attribution.

Every signal carries a run ID and its own wire message ID. The client pairs the signal's message ID with an invocation precondition when waking the agent (`run.resume()` and friends return the `Invocation` pre-wired).

`abort` and `pause` are delivered to live agents through `step.signal` (via its reason) and through `step.on('pause')` respectively; they also serve as durable facts for offline observation (an agent invoked later sees the signal on hydration).

`resume` and `retry` do not drive `step.signal` at all — they exist to wake a new agent (drive a new `x-ably-step-start`). The invocation the initiator POSTs carries the signal's message ID as a precondition so the new step cannot start until the signal is visible.

---

## 5. Use-case permutations

Each subsection frames the scenario, shows the agent and client code, enumerates the wire publishes, and highlights anything non-obvious.

### 5.1 Basic chat

One run, one step, streaming response. Full example: [`rfc/types/examples/vercel-serverless/basic-chat/agent.ts`](./types/examples/vercel-serverless/basic-chat/agent.ts) and [`client.ts`](./types/examples/vercel-serverless/basic-chat/client.ts).

**Agent.**

```ts
export const POST = async (req: Request): Promise<Response> => {
  const invocation = Invocation.fromJSON((await req.json()) as InvocationData);
  await using session = createAgentSession({ client: ably, sessionName: invocation.sessionName, codec });
  await session.connect();
  await using run = session.createRun(invocation);
  await using step = run.createStep();
  await step.start({ signal: req.signal, timeoutMs: 60_000 });
  try {
    const result = await agent.stream({
      messages: await convertToModelMessages(run.view.messages.map((n) => n.message)),
      abortSignal: step.signal,
    });
    await step.pipe(result.toUIMessageStream());
    await step.end();
    await run.end();
  } catch (error) {
    await step.end(error);
    await run.end(error);
    if (!step.signal.aborted) throw error;
  }
  return new Response(undefined, { status: 202 });
};
```

**Client.** `onSendClick` opens a run and POSTs the invocation.

```ts
const run = await view.send({ id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] });
await fetch('/api/agent', { method: 'POST', body: JSON.stringify(run.toInvocation().toJSON()) });
```

`view.send()` publishes `x-ably-run-start` and the user message atomically in a single Ably batch — the run either lands fully live with its message, or not at all.

**Wire trace.**

- Client publishes (batched): `x-ably-run-start` + `x-ably-message` (user message).
- Then POSTs the invocation.
- Agent publishes: `x-ably-step-start` → streaming `x-domain-*` chunks → `x-ably-step-end` (complete) → `x-ably-run-end` (complete).

### 5.2 Multi-step run

One run, multiple steps — e.g. a planning step followed by per-task execution steps. Full example: [`rfc/types/examples/vercel-serverless/prompt-chaining/agent.ts`](./types/examples/vercel-serverless/prompt-chaining/agent.ts).

**Agent.**

```ts
await using run = session.createRun(invocation);

try {
  // Step 1: planning
  {
    await using step = run.createStep();
    await step.start({ signal: req.signal, timeoutMs: 60_000 });
    try {
      const result = await agent.stream({ messages: planMessages, abortSignal: step.signal });
      await step.pipe(result.toUIMessageStream());
      await step.end();
    } catch (error) {
      await step.end(error);
      throw error;
    }
  }

  // Step 2: execution, using the plan just produced
  {
    await using step = run.createStep();
    await step.start({ signal: req.signal });
    try {
      const result = await agent.stream({
        messages: await convertToModelMessages(run.view.messages.map((n) => n.message)),
        abortSignal: step.signal,
      });
      await step.pipe(result.toUIMessageStream());
      await step.end();
    } catch (error) {
      await step.end(error);
      throw error;
    }
  }

  await run.end();
} catch (error) {
  await run.end(error);
  if (run.status === 'failed') throw error;
}
```

**Wire trace.** `x-ably-step-start` → chunks → `x-ably-step-end` → `x-ably-step-start` (second) → chunks → `x-ably-step-end` → `x-ably-run-end` (complete).

**Gotcha.** The `{ ... }` blocks are necessary for fresh `await using step` scopes. Each inner try/catch rethrows so the outer catch sees the unwind. `run.end(error)` then reads `lastStep.status` (the failure from whichever step threw) and classifies correctly. The outer `if (run.status === 'failed') throw error` rethrows only for genuine failures; caller-initiated abort or pause returns 202.

### 5.3 Client-authored events mid-run

HITL tool approval — the agent streams a response with a `tool-*` part in `approval-requested` state, ends the step normally, and suspends the run. The client publishes an approval event; a new invocation wakes the agent; a new step continues. Full example: [`rfc/types/examples/vercel-serverless/hitl-tool-approval/agent.ts`](./types/examples/vercel-serverless/hitl-tool-approval/agent.ts) and [`client.ts`](./types/examples/vercel-serverless/hitl-tool-approval/client.ts).

**Agent (turn 1 — request approval).**

```ts
await using run = session.createRun(invocation);
await using step = run.createStep();
await step.start({ signal: req.signal });

try {
  const result = await agent.stream({
    messages: await convertToModelMessages(run.view.messages.map((n) => n.message)),
    abortSignal: step.signal,
  });
  await step.pipe(result.toUIMessageStream());
  await step.end();

  // Inspect the assistant message. If any tool part is in approval-requested
  // state, suspend; otherwise complete.
  const assistant = run.messages.at(-1)?.message;
  const needsApproval = assistant?.parts.some(
    (p) => AI.isToolUIPart(p) && p.state === 'approval-requested',
  );
  if (needsApproval) {
    await run.suspend('awaiting-input');
  } else {
    await run.end();
  }
} catch (error) {
  await step.end(error);
  await run.end(error);
  if (!step.signal.aborted) throw error;
}
```

**Client.**

```ts
await run.sendEvents(
  {
    role: 'tool',
    content: [{ type: 'tool-approval-response', approvalId, approved, reason }],
  },
  { messageId: assistantMessageId },
);
await fetch('/api/agent', {
  method: 'POST',
  body: JSON.stringify(run.toInvocation().toJSON()),
});
```

The invocation's `messageId` precondition is the event's wire message ID, so the next agent waits for it.

**Agent (turn 2 — execute tool).** Same shape as 5.1. `step.start()` blocks until the approval event is visible; `run.view.messages` then contains the updated assistant message with the `approval-responded` state; `agent.stream` synthesises the tool-approval-response model message and continues.

**Wire trace (turn 1).**

- Client publishes: `x-ably-run-start` → user message → invocation POST.
- Agent publishes: `x-ably-step-start` → chunks (including tool part in approval-requested state) → `x-ably-step-end` (complete) → `x-ably-run-suspend` (awaiting-input).

**Gotcha.** `run.suspend('awaiting-input')` is explicit — not inferred. `run.end()` inference would pick `'complete'` (no error, no pause observed). `'awaiting-input'` is an orchestrator-authored decision based on inspecting the stream output; the SDK cannot infer it.

If the catch block later throws (e.g. the agent called `run.suspend('awaiting-input')` in the try, then the request aborted before the `return`), `run.end(error)` transitions suspended → terminal per `run.ts:351-359`. The forward motion is legal; the inference table still applies.

### 5.4 Client aborts an active run

Client clicks stop while the agent is streaming. Full example: [`rfc/types/examples/vercel-serverless/abort-and-pause/agent.ts`](./types/examples/vercel-serverless/abort-and-pause/agent.ts) and [`client.ts`](./types/examples/vercel-serverless/abort-and-pause/client.ts).

**Client.**

```ts
const invocation = await run.abort();
void fetch('/api/agent', {
  method: 'POST',
  body: JSON.stringify(invocation.toJSON()),
}).catch(() => {
  // fire-and-forget: the channel has the durable abort; POST is best-effort wake-up
});
```

**Agent.** Unchanged from 5.1 — the SDK already wires `x-ably-abort` into `step.signal`. The Vercel SDK bubbles an abort error; the catch runs; `step.end(error)` sees `signal.aborted && reason === ABORTED` → publishes `'aborted'`; `run.end(error)` sees `signal.reason === ABORTED` → publishes `'aborted'`.

**Wire trace.** `x-ably-abort` published by client → agent stream throws → `x-ably-step-end` (aborted) → `x-ably-run-end` (aborted).

### 5.5 Pre-existing abort

Client published `x-ably-abort` while no agent was listening (e.g. the previous invocation crashed and no retry has fired; the user clicked stop; the next invocation wakes). Full example: [`rfc/types/examples/vercel-serverless/abort-and-pause/agent.ts`](./types/examples/vercel-serverless/abort-and-pause/agent.ts).

**Agent.** Same handler body as 5.1. The difference is timing: `step.start()` resolves with `step.signal.aborted === true` immediately. The model SDK call receives an already-aborted signal and rejects synchronously with an abort error; the catch runs; `step.end(error)` → `'aborted'`; `run.end(error)` → `'aborted'`.

**Wire trace.** `x-ably-step-start` → `x-ably-step-end` (aborted) → `x-ably-run-end` (aborted). No streaming chunks — the model SDK short-circuited on the pre-aborted signal.

**Gotcha.** The handler *must* check `step.signal.aborted` after `step.start()` resolves, or — equivalently — pass `step.signal` into the model SDK, which does the same check. The `basic-chat` handler does the latter; this is why the pre-existing-abort case works with zero extra code.

### 5.6 View-wide stop

Cancel everything currently active in the view — used for multi-panel chats, subagent fan-outs. Full example: [`rfc/types/examples/vercel-serverless/abort-and-pause/client.ts`](./types/examples/vercel-serverless/abort-and-pause/client.ts).

**Client.**

```ts
const cancellable = view.runs.filter((r) => r.status === 'active' || r.status === 'suspended');
const invocations = await Promise.all(cancellable.map((r) => r.abort()));
for (const invocation of invocations) {
  void fetch('/api/agent', {
    method: 'POST',
    body: JSON.stringify(invocation.toJSON()),
  }).catch(() => {
    /* fire-and-forget */
  });
}
```

**Wire trace.** One `x-ably-abort` per cancellable run, each independently routed to whatever agent wakes.

**Gotcha.** `abort()` is a no-op on terminal runs; the filter avoids wake-up POSTs for runs already done. For runs still in `'active'` or `'suspended'`, each abort publishes unconditionally (`abort()` is a no-op only when the status would make the signal ineffective — i.e. already terminal).

### 5.7 Pause — case (a): step completes, run suspends

The handler wants pause to *not* interrupt the in-flight stream (case a: "let the current response finish, then suspend"). This is where `step.abortSignal` earns its place.

**Agent.**

```ts
await using run = session.createRun(invocation);
await using step = run.createStep();
await step.start({ signal: req.signal });

try {
  const result = await agent.stream({
    messages: await convertToModelMessages(run.view.messages.map((n) => n.message)),
    abortSignal: step.abortSignal,   // narrow — only hard abort, not pause
  });
  await step.pipe(result.toUIMessageStream());
  await step.end();
  await run.end();  // lastStep.signalReason === PAUSED → run.suspend('paused')
} catch (error) {
  await step.end(error);
  await run.end(error);
  if (!step.signal.aborted) throw error;
}
```

**Wire trace.** `x-ably-step-start` → full streaming chunks → `x-ably-step-end` (complete) → `x-ably-run-suspend` (paused).

**Gotcha.** The pause control signal reached the channel while the stream was in flight. `step.signal.aborted` is true with `reason === PAUSED`, but `step.abortSignal.aborted` is false — that's why the stream was not interrupted. `step.end()` sees `error === undefined` and picks `'complete'` (the "late signal ignored" row); the signal reason (`PAUSED`) is frozen onto `StepState.signalReason` as the step finalises. `run.end()` then reads `lastStep.signalReason === PAUSED` and routes to `suspend('paused')`.

### 5.8 Pause — case (b): step pauses mid-flight

The handler wants pause to interrupt the stream so checkpoint state can be captured and resumed later. This is the common case; most handlers don't need case (a).

**Agent.**

```ts
await using run = session.createRun(invocation);
await using step = run.createStep();
await step.start({ signal: req.signal });

try {
  const result = await agent.stream({
    messages: await convertToModelMessages(run.view.messages.map((n) => n.message)),
    abortSignal: step.signal,   // broad — aborts on both abort and pause
  });
  await step.pipe(result.toUIMessageStream());
  await step.end();
  await run.end();
} catch (error) {
  await step.end(error);   // signal.reason === PAUSED → step 'paused'
  await run.end(error);    // lastStep.status === 'paused' → run.suspend('paused')
  if (!step.signal.aborted) throw error;
}
```

**Client resume (later).**

```ts
const invocation = await run.resume({ stepId: lastStep.id });
await fetch('/api/agent', { method: 'POST', body: JSON.stringify(invocation.toJSON()) });
```

**Wire trace (pause).** `x-ably-pause` → stream throws → `x-ably-step-end` (paused) → `x-ably-run-suspend` (paused).

**Wire trace (resume).** `x-ably-resume` (carries `stepId`) → agent wakes → new `x-ably-step-start` → continuation.

**Gotcha.** The paused step's ID is what `resume({ stepId })` references. The resumed agent can load checkpoint state keyed on that step ID (typically from the storage reader) rather than starting from scratch.

### 5.9 Agent error mid-stream

The model SDK throws for a reason unrelated to abort or pause — network error, tool invocation threw, provider returned an error.

**Agent.** Same handler as 5.1. The catch runs with a non-abort-related error; `step.end(error)` sees `!signal.aborted` → `'failed'`; `run.end(error)` sees `lastStep.status === 'failed'` and no pause → `'failed'`.

**Wire trace.** `x-ably-step-start` → some chunks → `x-ably-step-end` (failed, cause carries the original error's `code`/`message`) → `x-ably-run-end` (failed) → the framework sees the rethrown error and returns a 5xx response.

**Gotcha.** The `if (!step.signal.aborted) throw error` guard at the bottom of the catch distinguishes server failures (5xx) from caller-initiated cancellation (202). Abort and pause both set `step.signal.aborted`, so their catch paths return 202 — the channel state is already correct. Any other throw is a server-side failure and must bubble to the HTTP framework.

### 5.10 Retry a failed run

Client observes a failed run in the tree and publishes `x-ably-retry`. Full example: [`rfc/types/examples/vercel-serverless/retry-after-failure/agent.ts`](./types/examples/vercel-serverless/retry-after-failure/agent.ts) and [`client.ts`](./types/examples/vercel-serverless/retry-after-failure/client.ts).

**Client.**

```ts
const invocation = await run.retry();
await fetch('/api/agent', { method: 'POST', body: JSON.stringify(invocation.toJSON()) });
```

**Agent.** Same handler as 5.1. The new invocation wakes a fresh agent. The new step's `step.start()` publishes a new `x-ably-step-start`; the tree records the prior failed step alongside the new active step.

**Wire trace.** `x-ably-retry` → new `x-ably-step-start` → chunks → `x-ably-step-end` (complete) → `x-ably-run-end` (complete).

**Gotcha.** The retried run's status transitions from `'failed'` back through `'active'` on the new step-start. This is unlike the terminal-state-per-wire-message model for `complete`/`aborted` — `failed` is reversible via retry.

### 5.11 Retry a specific step

A multi-step run where only one step failed. The client retries just that step without restarting the whole run.

**Client.**

```ts
const invocation = await run.retry({ stepId: failedStep.id });
await fetch('/api/agent', { method: 'POST', body: JSON.stringify(invocation.toJSON()) });
```

**Agent.** The invocation's `stepId` identifies which step to resume from; the agent can look up checkpoint state keyed on that step ID.

**Wire trace.** `x-ably-retry` (carries `stepId`) → new `x-ably-step-start` → chunks → `x-ably-step-end` (complete) → `x-ably-run-end` (complete).

### 5.12 Regenerate — fork and start a new run

Client forks the tree at a prior assistant message, opening a new run on the new branch. Full example: [`rfc/types/examples/vercel-serverless/regenerate/agent.ts`](./types/examples/vercel-serverless/regenerate/agent.ts) and [`client.ts`](./types/examples/vercel-serverless/regenerate/client.ts).

**Client.**

```ts
const run = await view.regenerate(assistantMessageId);
await fetch('/api/agent', { method: 'POST', body: JSON.stringify(run.toInvocation().toJSON()) });
```

`view.regenerate()` publishes `x-ably-run-start` (with `x-ably-fork-of` set to the regenerate target) atomically and returns the live run. No user message is published — the agent picks up the conversation up to the fork point's parent and produces a new response.

**Edit.** To edit a prior message instead, pass a replacement: `await view.edit(messageId, editedMessage)`. Fork mechanics are identical; the difference is that `edit` publishes the replacement message as part of the same batch.

**Agent.** Unchanged from 5.1 — the agent's `run.view.messages` already reflects the correct branch because the invocation pins the run, and the forked run's parent is set at the regenerate point.

**Wire trace.** Client publishes (batched): `x-ably-run-start` (with `x-ably-fork-of`) [+ `x-ably-message` for edit]. Agent publishes: `x-ably-step-start` → chunks → `x-ably-step-end` → `x-ably-run-end`.

### 5.13 Multi-device idempotence — two clients call `abort()`

Two clients on the same session both click stop for the same run. Full example: [`rfc/types/examples/vercel-serverless/multi-device/`](./types/examples/vercel-serverless/multi-device/).


**Client A.**

```ts
await run.abort();  // publishes x-ably-abort
```

**Client B (a tick later).**

```ts
await run.abort();  // silent no-op — run is already 'aborted'
```

**Wire trace.** One `x-ably-abort` from Client A. The run reaches `'aborted'` via the agent's `x-ably-run-end`. Client B's `abort()` observes the terminal state and publishes nothing.

**Gotcha.** Both clients subscribe to the same channel, so Client B's session has already observed Client A's `x-ably-abort` (and the agent's `x-ably-run-end`) by the time the user's click reaches the handler. `run.abort()` sees the run is terminal and publishes nothing. If the clients *hadn't* observed each other before the second click, both aborts would publish; the duplicate is inert (run is still `'aborted'`) but wastes a wire event. The idempotence guard is best-effort, not a distributed lock.

### 5.14 Step precondition timeout

The agent starts but the invocation's preconditions never materialise (the client never published the expected message, or the channel is slow). `step.start()` rejects with `InvocationPreconditionTimeout` (`104301`).

**Agent.** Same handler body as 5.1. The rejection happens inside the try block; the catch runs.

```ts
try {
  // ...model call never reached
} catch (error) {
  await step.end(error);   // step is 'pending' → no-op (no x-ably-step-start was published)
  await run.end(error);    // no lastStep → classifier picks 'failed'
  if (!step.signal.aborted) throw error;
}
```

**Wire trace.**

- Agent publishes: `x-ably-run-end` (failed). No step-start, no step-end — the step never reached the channel.

**Gotcha.** The step disposer is also a no-op on `'pending'`, which is why the wire trace is clean. The run terminal still publishes, carrying the error's message/code.

### 5.15 Hydration on reconnect

The client disconnects mid-stream and reconnects before the agent finishes. The session hydrates from channel history on reattach; `view.runs` reflects the in-progress or terminal run without the agent republishing anything.

**Client.** Nothing explicit. `session.connect()` handles hydration internally — on reconnect, the Ably channel replays history; the decoder rebuilds the tree; views re-emit their projected state.

**Wire trace.** No new publishes from the client. The agent's original chunks/step-end/run-end are replayed from history; the client's session converges on whatever terminal state landed while it was offline.

**Gotcha.** If the run is still `'active'` when reconnect completes, the client observes the in-progress step and continues receiving chunks as they arrive. If the run had already terminated, the view reflects the terminal status immediately. Hydration is a durable protocol concern — the client never has to ask the agent for "the latest state" because the channel *is* the latest state.

---

## 6. API shape changes summary

Type-level amendments from today's RFC:

- **`step.end(error?: unknown): Promise<void>`** — replaces the current `step.end(status: StepEndStatus)`. Single-method, single-argument form. The explicit-status overload is **removed** — all callers route through the inference table. The SDK still picks `'superseded'` automatically when a race loses; `'abandoned'` remains a tree-side classification for orphaned steps and is never wire-published.
- **`run.end(error?: unknown): Promise<void>`** — replaces the current `run.end(status: RunEndStatus)`. Routes internally to either a run-end publish (complete/aborted/failed) or a run-suspend publish (paused). The explicit-status overload is removed.
- **`run.suspend(reason: SuspendReason): Promise<void>`** — retained. The explicit escape hatch for suspensions the inference classifier cannot derive: `'awaiting-input'` (orchestrator-authored, not pause-driven), and any orchestrator that wants to suspend without throwing. Complements `run.end()` rather than duplicating it.
- **`step.abortSignal: AbortSignal`** — new narrow signal that fires only for hard abort (`x-ably-abort`), step precondition timeout, and caller-folded `req.signal`. Use when the handler wants pause to not interrupt the stream.
- **`step.signal.reason`** — now a tagged sentinel (`ABORTED` or `PAUSED`) after the signal aborts. The step's composed signal fires on both abort and pause; the reason distinguishes.
- **Exported sentinels** `ABORTED` and `PAUSED` — `unique symbol` values exported from the package root, for callers who want to introspect `signal.reason` directly (rare; inference handles the common case).
- **`StepState.signalReason: typeof ABORTED | typeof PAUSED | undefined`** — new readable field on `StepState`. Captured at `step.end()` time: whatever `step.signal.reason` was at that moment gets frozen onto the state. Consumed by the run classifier (`lastStep.signalReason`) and exposed publicly for observability — symmetric with `lastStep.status`.
- **`run.lastStep: StepState | undefined`** — new readable getter on both `ClientRun` and `AgentRun`. Shortcut over `run.steps`; consumed by the run classifier internally and exposed to callers for introspection.
- **No public `run.pauseRequested` or `step.pauseRequested`** — the classifier consults `lastStep.signalReason` and tree state internally. A boolean would add a parallel state namespace without new information.
- **`step.on('pause', handler)`** — retained as a telemetry / side-effect notification hook only. Fires when a pause control signal is observed on the channel. Does **not** participate in the inference classifier; does not drive `step.end`. Typical use: log the pause, write checkpoint state to external storage. The step's terminal status is still decided by the inference table at `step.end()` time — from the error argument plus `step.signal.reason`.
- **`ClientView` gains verb methods** — `view.send(messages)`, `view.regenerate(messageId, opts?)`, and `view.edit(messageId, messages, opts?)` each return `Promise<ClientRun<C>>`. Each opens a run atomically via a single Ably batch publish containing `x-ably-run-start` and (for `send`/`edit`) the user message. Replaces `view.createRegenerate` and `view.createEdit`, which are **removed**. Replaces the common `view.createRun() → run.start() → run.sendMessages(...)` sequence with one call.
- **`view.createRun(options?: CreateRunOptions): ClientRun<C>`** — retained as the advanced escape hatch for callers that need split lifecycle control (delayed start, custom multi-publish batching, etc.). `CreateRunOptions` folds in the fork shape: `{ forkFrom?: string; autoSelect?: boolean }`. Returns a run that is **not yet live**; caller drives `run.start()` and `run.sendMessages(...)` manually.
- **Disposer behaviours confirmed.** `session[Symbol.asyncDispose]` closes subscriptions, no publishes. `run[Symbol.asyncDispose]` releases the local handle, no publishes. `step[Symbol.asyncDispose]` publishes a pessimistic terminal on `'active'` steps (`'aborted'` if `signal.aborted`, else `'failed'` with cause `StepDisposedBeforeEnd`); no-op on `'pending'` and terminal.

---

## 7. Open questions

1. **Wire-level error serialisation scope.** §3 specifies that `step.end('failed')` and `run.end('failed')` serialise `error.message` and (for `Ably.ErrorInfo`) `error.code` onto the wire headers. Should we also serialise `error.name` and/or a truncated `error.stack`? Name is cheap and useful for hydration (reconstructing `new Error(message)` vs `new TypeError(message)`); stack is heavyweight and leaks implementation detail. Leaning `name` yes, `stack` no — confirmation needed before types land.

2. **`StepState.signalReason` visibility.** The classifier consults it internally; the proposed amendment exposes it publicly on `StepState`. Exposing it is symmetric with `lastStep.status` and useful for observability (telemetry, debugging, UI that explains why a run suspended). The alternative — keeping it internal to the classifier — reduces the public surface by one field at the cost of removing the observable rationale. Leaning expose.

3. **Pause observation windowing across steps.** The classifier reads `lastStep.signalReason`, which correctly handles "step 1 saw pause, step 2 drained cleanly → complete" and "single step saw pause, ran to completion → suspend." It does **not** look at pauses observed on prior (already-ended) steps that were superseded. Is there a real scenario where the user wants "a pause seen anywhere in this run's history" to suspend regardless of what the last step did? The current design says no — the handler's decision to start another step is the signal that the pause should drain. Confirmation needed.
