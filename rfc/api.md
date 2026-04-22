# API Design: Durable Sessions

API surface for the durable sessions design described in [AIT012](./AIT012.md). Design decisions captured in [decisions.log](./decisions.log).

## Entry points

```ts
function createClientSession<TEvent, TMessage>(
  options: SessionOptions<TEvent, TMessage>,
): ClientSession<TEvent, TMessage>;

function createAgentSession<TEvent, TMessage>(
  options: SessionOptions<TEvent, TMessage>,
): AgentSession<TEvent, TMessage>;
```

An `Invocation` is rehydrated from a wire payload via the static
`Invocation.fromJSON(data)` factory on the merged `Invocation` namespace (see
[Invocation](#invocation)). There is no bare `createInvocation` function.

## Session options

```ts
interface SessionOptions<TEvent, TMessage> {
  /**
   * The Ably Realtime client. The SDK derives the channel(s) it needs from
   * the session name. Taking a client (rather than a pre-constructed channel)
   * lets the SDK tag it with an `ably-agent` header for usage attribution and
   * leaves room to evolve a session into multiple channels in future without
   * a breaking change.
   */
  client: Ably.Realtime;

  /**
   * The session name. Matches `InvocationData.sessionName` so the value that
   * names the session on both ends of an HTTP hop is identically typed.
   * Today this is used as the name of the single channel backing the session;
   * in future a session may span multiple channels and the SDK will derive
   * those channel names from this value.
   */
  sessionName: string;

  /** Codec that translates between domain events and channel operations. */
  codec: Codec<TEvent, TMessage>;

  /** Loads historical state into the session during connect(). Omit for a fresh session. */
  storageReader?: StorageReader;

  /** Receives channel messages as the session processes them, for external persistence. */
  storageWriter?: StorageWriter;

  /** Logger instance. */
  logger?: Logger;
}
```

## ClientSession

```ts
interface ClientSession<TEvent, TMessage> {
  /** The session name, as passed to createClientSession. */
  readonly sessionName: string;

  /** The unfiltered conversation tree. Available before connect(). */
  readonly tree: Tree<TMessage, ClientRun<TEvent, TMessage>>;

  /**
   * Create a projected view over the tree. Each view has independent branch
   * selection and pagination. Views can be created before connect() — the
   * view pends hydration and fills in as the session materialises the
   * channel. Call view.close() to release a view when it's no longer needed.
   */
  createView(options?: CreateViewOptions): ClientView<TEvent, TMessage>;

  /**
   * Hydrate from the storage reader (if provided) and subscribe to the channel
   * for live events. Resolves when hydration is complete and the live
   * subscription is active.
   *
   * Idempotent: calling connect() a second time is a no-op and resolves
   * immediately so that workflow retries are not hostile.
   */
  connect(): Promise<void>;

  /**
   * Unsubscribe from the channel and tear down the tree and all views.
   * Idempotent and never rejects — callers can safely call close() in
   * error-handling paths without wrapping it in try/catch.
   */
  close(): Promise<void>;

  /**
   * Symbol.asyncDispose — equivalent to `close()`. Closes subscriptions and
   * releases views; no publish side effects.
   */
  [Symbol.asyncDispose](): Promise<void>;

  /**
   * Fires when the session encounters an unrecoverable error — channel
   * detach, failed state, or storage reader/writer failure.
   */
  on(event: 'error', handler: (error: Ably.ErrorInfo) => void): void;
  off(event: 'error', handler: (error: Ably.ErrorInfo) => void): void;

  /**
   * Low-level write surface for publishing lifecycle events, messages, and
   * signals directly to the channel. Views and runs delegate to this
   * internally. Exposed at the top level (not demoted behind `.advanced`) so
   * server-side validation handlers and orchestrators can reach it directly.
   *
   * A session created without calling `connect()` can be used writer-only —
   * the writer publishes directly to the channel without hydrating the tree
   * or subscribing. This is the "lifecycle-only" idiom used by the server-
   * side validation and durable-execution `endRun` hop examples.
   */
  readonly writer: SessionWriter<TEvent, TMessage>;
}
```

## SessionWriter

The low-level write surface shared by both session types. Every publishable
event type has its own method. Views, runs, and steps delegate to this
internally.

```ts
interface SessionWriter<TEvent, TMessage> {
  // --- Run lifecycle ---

  /** Publish x-ably-run-start. Returns the generated run ID. */
  startRun(options: StartRunOptions): Promise<StartRunResult>;

  /** Publish x-ably-run-suspend. */
  suspendRun(options: SuspendRunOptions): Promise<void>;

  /** Publish x-ably-run-end. */
  endRun(options: EndRunOptions): Promise<void>;

  // --- Step lifecycle ---

  /** Publish x-ably-step-start. Returns the generated step ID. */
  startStep(options: StartStepOptions): Promise<StartStepResult>;

  /** Publish x-ably-step-end. */
  endStep(options: EndStepOptions): Promise<void>;

  // --- Content ---

  /**
   * Publish one or more complete domain messages to the channel. Encoded via
   * the codec's writeMessages path. Use for user messages, tool results, and
   * other discrete complete messages.
   *
   * Message IDs are supplied by the caller on each message (e.g. the Vercel
   * codec uses `UIMessage.id`). The writer does not assign IDs and does not
   * return them; this matches `run.sendMessages()` so the send surface is
   * uniform.
   */
  sendMessages(options: SendMessagesOptions<TMessage>): Promise<void>;

  /**
   * Publish one or more discrete domain events to the channel. Encoded via
   * the codec's writeEvent path. Use for standalone events like `data-*`
   * that are not complete messages.
   *
   * Event IDs, where the domain events carry them, are supplied by the
   * caller. The writer does not assign IDs and does not return them.
   */
  sendEvents(options: SendEventsOptions<TEvent>): Promise<void>;

  // --- Control signals ---

  /** Publish an abort signal targeting a run. */
  abort(options: AbortOptions): Promise<void>;

  /** Publish a pause signal targeting a run. */
  pause(options: PauseOptions): Promise<void>;

  /** Publish a resume signal targeting a run. */
  resume(options: ResumeOptions): Promise<void>;

  /** Publish a retry signal targeting a run. */
  retry(options: RetryOptions): Promise<void>;
}
```

### SessionWriter types

```ts
interface CreateViewOptions {
  /**
   * Initial branch selection: a map of parent message ID to selected child
   * message ID. Omit for default selection (latest child at each branch).
   */
  initialSelection?: Record<string, string>;
}

interface StartRunOptions {
  /** Parent message ID for tree positioning. */
  parentId?: string;

  /**
   * Override the run's initiator clientId. Sent as `x-ably-client-id` on
   * `x-ably-run-start`. Use this in server-side input validation handlers
   * where the backend publishes `x-ably-run-start` with its own connection
   * but the run should be attributed to the end-user. When omitted, the
   * publishing connection's clientId is used (the common case).
   */
  clientId?: string;
}

interface StartRunResult {
  /** The generated run ID. */
  runId: string;
}

interface SuspendRunOptions {
  /** The run to suspend. */
  runId: string;
  /** Why the run is being suspended. */
  reason: SuspendReason;
}

interface EndRunOptions {
  /** The run to end. */
  runId: string;
  /** Terminal status to record on `x-ably-run-end`. */
  status: RunEndStatus;
}

interface StartStepOptions {
  /** The run the new step belongs to. */
  runId: string;
}

interface StartStepResult {
  /** The generated step ID. */
  stepId: string;
}

interface EndStepOptions {
  /** The run the step belongs to. */
  runId: string;
  /** The step to end. */
  stepId: string;
  /** Terminal status to record on `x-ably-step-end`. */
  status: StepEndStatus;
}

interface AbortOptions {
  /** The run to abort. */
  runId: string;
  /**
   * Override the attribution clientId sent as `x-ably-client-id`. Use this
   * in backend orchestrators publishing abort on behalf of an end-user
   * (the control signal is observable on the channel, so attribution still
   * matters for audit and UI display). When omitted, the publishing
   * connection's clientId is used.
   */
  clientId?: string;
}

interface PauseOptions {
  /** The run to pause. */
  runId: string;
  /** Override the attribution clientId. See AbortOptions.clientId. */
  clientId?: string;
}

interface ResumeOptions {
  /** The run to resume. */
  runId: string;
  /** Target a specific step for checkpoint-based resumption. */
  stepId?: string;
  /** Message the agent must observe before starting (e.g. HITL approval). */
  messageId?: string;
  /** Override the attribution clientId. See AbortOptions.clientId. */
  clientId?: string;
}

interface RetryOptions {
  /** The run to retry. */
  runId: string;
  /** Target a specific step for step-level retry. */
  stepId?: string;
  /** Override the attribution clientId. See AbortOptions.clientId. */
  clientId?: string;
}

interface SendMessagesOptions<TMessage> {
  /** One or more domain messages to encode and publish. */
  messages: TMessage | TMessage[];
  /** The run these messages belong to. */
  runId: string;
  /** Parent message ID for tree positioning. */
  parentId?: string;

  /**
   * Override the attribution clientId sent as `x-ably-client-id`. Use this
   * in backend publishers that forward user input on behalf of an end-user
   * (server-side input validation). When omitted, the publishing
   * connection's clientId is used.
   */
  clientId?: string;
}

interface SendEventsOptions<TEvent> {
  /** One or more domain events to encode and publish. */
  events: TEvent | TEvent[];
  /** The run these events belong to. */
  runId: string;
  /** Parent message ID for tree positioning. */
  parentId?: string;

  /**
   * Override the attribution clientId sent as `x-ably-client-id`. See
   * SendMessagesOptions.clientId.
   */
  clientId?: string;
}
```

Run-scoped callers (on `ClientRun`) already carry the run as the receiver, so
the writer's option types are also exported with the redundant `runId`
stripped. These aliases are derived via `Omit` so any future additions to the
writer's option types flow through automatically:

```ts
type ClientRunAbortOptions = Omit<AbortOptions, 'runId'>;
type ClientRunPauseOptions = Omit<PauseOptions, 'runId'>;
type ClientRunResumeOptions = Omit<ResumeOptions, 'runId'>;
type ClientRunRetryOptions = Omit<RetryOptions, 'runId'>;
```

## AgentSession

```ts
interface AgentSession<TEvent, TMessage> {
  /** The session name, as passed to createAgentSession. */
  readonly sessionName: string;

  /**
   * The unfiltered conversation tree. Available as an escape hatch for
   * advanced cases. Most agents read the conversation through the step.
   */
  readonly tree: Tree<TMessage, AgentRun<TMessage>>;

  /**
   * Create a view scoped to the run an invocation names. The view's branch
   * selection is pinned by the invocation's run ID — it shows the linear
   * conversation the run sits on (ancestry from root plus the run's own
   * messages). Views can be created before connect() — the view pends
   * hydration and fills in as the session materialises the channel. Call
   * view.createStep() to produce the step that executes the run.
   */
  createView(invocation: Invocation): AgentView<TEvent, TMessage>;

  /**
   * Hydrate from the storage reader (if provided) and subscribe to the channel
   * for live events. Resolves when hydration is complete and the live
   * subscription is active.
   *
   * Idempotent: calling connect() a second time is a no-op and resolves
   * immediately so that workflow retries are not hostile.
   */
  connect(): Promise<void>;

  /**
   * Unsubscribe from the channel and tear down the session.
   * Idempotent and never rejects — callers can safely call close() in
   * error-handling paths without wrapping it in try/catch.
   */
  close(): Promise<void>;

  /**
   * Symbol.asyncDispose — equivalent to `close()`. Closes subscriptions and
   * releases views; no publish side effects.
   */
  [Symbol.asyncDispose](): Promise<void>;

  /**
   * Fires when the session encounters an unrecoverable error — channel
   * detach, failed state, or storage reader/writer failure.
   */
  on(event: 'error', handler: (error: Ably.ErrorInfo) => void): void;
  off(event: 'error', handler: (error: Ably.ErrorInfo) => void): void;

  /**
   * Low-level write surface. Steps delegate to this internally. Exposed at
   * the top level for orchestrators and advanced patterns (e.g. subagent
   * fan-out, lifecycle-only hops).
   *
   * A session created without calling `connect()` can be used writer-only —
   * the writer publishes directly to the channel without hydrating the tree
   * or subscribing. This is the "lifecycle-only" durable-execution pattern
   * (see plan §5.7).
   */
  readonly writer: SessionWriter<TEvent, TMessage>;
}
```

## Tree

```ts
interface Tree<TMessage, TRun extends Run<TMessage> = Run<TMessage>> {
  /** All message nodes across all branches, ordered by serial. */
  readonly messages: ReadonlyArray<MessageNode<TMessage, TRun>>;

  /** All runs across all branches. */
  readonly runs: ReadonlyArray<TRun>;

  /** Look up a message node by ID. */
  getMessage(id: string): MessageNode<TMessage, TRun> | undefined;

  /** Look up a run by ID. */
  getRun(id: string): TRun | undefined;

  // --- Granular events ---

  on(event: 'message-added' | 'message-updated', handler: (node: MessageNode<TMessage, TRun>) => void): void;
  on(event: 'run-started' | 'run-updated' | 'run-ended', handler: (run: TRun) => void): void;
  on(event: 'step-started' | 'step-updated' | 'step-ended', handler: (step: StepState, run: TRun) => void): void;

  off(event: 'message-added' | 'message-updated', handler: (node: MessageNode<TMessage, TRun>) => void): void;
  off(event: 'run-started' | 'run-updated' | 'run-ended', handler: (run: TRun) => void): void;
  off(event: 'step-started' | 'step-updated' | 'step-ended', handler: (step: StepState, run: TRun) => void): void;
}
```

## View

A view is a linear projection over the tree and the factory for a write handle
(a run on the client, a step on the agent). The base `View` contract is the
same on both sides — `messages`, `subscribe`, `close` — and each session type
extends it with a role-appropriate branch-selection policy and write-handle
factory.

```ts
/**
 * Base read projection over a session's tree. A view holds a linear sequence
 * of messages — one selected sibling at each branch point, ordered from root
 * to leaf — and a state-oriented subscription for observing changes to that
 * sequence. Both ClientView and AgentView share this contract.
 */
interface View<TMessage, TRun extends Run<TMessage> = Run<TMessage>> {
  /**
   * Messages visible in this view's projection — one selected sibling at each
   * branch point, ordered linearly. Includes all messages regardless of step
   * status; use message.step.status to filter in rendering or before passing
   * to a model.
   *
   * Each node's `run` is typed to the session's run variant, so per-message
   * controls (e.g. `node.run?.abort()`, `node.run?.sendMessages(...)`) are
   * directly callable from the rendered node.
   */
  readonly messages: ReadonlyArray<MessageNode<TMessage, TRun>>;

  /**
   * Subscribe to view state changes. The callback fires whenever the visible
   * output changes — messages added, updated, or removed from the projection.
   * Returns an unsubscribe function.
   *
   * This is the primary subscription for UI rendering (client) and for
   * reacting to ancestry fill-in and steering messages (agent). React hooks
   * build on this via useSyncExternalStore. The Tree uses on/off for granular
   * typed events; the View uses subscribe/unsubscribe for state-oriented
   * observation — different patterns because they serve different purposes.
   */
  subscribe(callback: () => void): () => void;

  /**
   * Release this view's subscriptions and resources. After close(), the view
   * no longer updates and should not be read. Session.close() closes all
   * views automatically.
   *
   * Idempotent — calling close() a second time is a no-op.
   */
  close(): void;
}

/**
 * Optional behaviour for {@link ClientView.createRegenerate} and
 * {@link ClientView.createEdit}.
 */
interface CreateForkOptions {
  /**
   * Whether the view should switch selection to the new branch as soon as
   * the fork is created. Defaults to `true` — the common UI pattern where
   * regenerating or editing a message should immediately display the new
   * branch. Pass `{ autoSelect: false }` to leave the current selection
   * untouched (e.g. when forking multiple branches for later navigation).
   */
  autoSelect?: boolean;
}

/**
 * Read projection scoped to the client's UI perspective. Branch selection is
 * mutable — the user drives it via select() and loadMore(). Factory for new
 * runs: createRun, createRegenerate, and createEdit all produce a ClientRun
 * positioned by the view's current branch state.
 *
 * The generic carries `TEvent` as well as `TMessage` for symmetry with
 * `AgentView` and for forward compatibility with future event-typed
 * client-side operations.
 */
interface ClientView<TEvent, TMessage> extends View<TMessage, ClientRun<TEvent, TMessage>> {
  /** Runs whose messages are visible in this view's projection. */
  readonly runs: ReadonlyArray<ClientRun<TEvent, TMessage>>;

  /** Whether more history is available to load. */
  readonly hasMore: boolean;

  /** Load more history into the view. */
  loadMore(): Promise<void>;

  /**
   * Select a sibling at a branch point, switching which branch this view shows.
   *
   * @throws `Ably.ErrorInfo` with code `ErrorCode.ViewNodeNotFound` when
   *   `messageId` does not identify any node in the tree.
   */
  select(messageId: string): void;

  // --- Run creation (branch-context-aware) ---

  /**
   * Create a new run, positioned at the current branch tip. The run is not
   * yet live — call run.start() to publish `x-ably-run-start` to the channel.
   */
  createRun(): ClientRun<TEvent, TMessage>;

  /**
   * Create a new run that forks the tree at the given message (regenerate).
   * The original response is preserved alongside the new branch. By default
   * the view selects the new branch immediately; pass `{ autoSelect: false }`
   * to leave selection untouched. The run is not yet live — call run.start()
   * to publish `x-ably-run-start`.
   */
  createRegenerate(messageId: string, options?: CreateForkOptions): ClientRun<TEvent, TMessage>;

  /**
   * Create a new run that forks the tree at the given message (edit). The
   * conversation branches from the edit point. By default the view selects
   * the new branch immediately; pass `{ autoSelect: false }` to leave
   * selection untouched. The run is not yet live — call run.start() to
   * publish `x-ably-run-start`.
   */
  createEdit(messageId: string, options?: CreateForkOptions): ClientRun<TEvent, TMessage>;
}

/**
 * Read projection scoped to the run an agent invocation names. Branch
 * selection is pinned by the invocation's run ID — the view shows the
 * ancestry from root down to the run's parent, then every message published
 * within the run. This is the conversation the agent passes to the model.
 *
 * view.messages begins empty and fills in as the session materialises the
 * channel; it is complete once step.start() has resolved. Subscribe to
 * receive updates as the projection populates during hydration and as
 * steering messages arrive during execution.
 *
 * No mutable branch selection and no pagination — the invocation has
 * already determined the branch, and the agent needs the full ancestry
 * to pass to the model.
 */
interface AgentView<TEvent, TMessage> extends View<TMessage, AgentRun<TMessage>> {
  /**
   * The run this view is scoped to. The step created from this view
   * executes work against this run. Use view.run.end() / view.run.suspend()
   * to manage run lifecycle.
   */
  readonly run: AgentRun<TMessage>;

  /**
   * Create a step that executes this view's run. The step is not yet
   * active — call step.start() to wait for the invocation's preconditions
   * and publish `x-ably-step-start`. The gap between createStep and start is
   * the setup window for registering signal handlers (e.g. step.on('pause', ...)).
   *
   * Each call returns a fresh {@link Step}; multiple steps per view are
   * permitted. A run can span multiple steps, each publishing its own
   * step-start/step-end pair. Precondition-wait is a view-level state, so
   * in practice only the first step in a view blocks on it — once the view
   * has materialised the invocation's preconditions, later steps see an
   * already-satisfied condition and `start()` proceeds immediately.
   */
  createStep(): Step<TEvent, TMessage>;
}
```

## MessageNode

```ts
interface MessageNode<TMessage, TRun extends Run<TMessage> = Run<TMessage>> {
  /** Unique message ID (from the `x-ably-msg-id` header). */
  readonly id: string;

  /** The domain message in the codec's representation. */
  readonly message: TMessage;

  /**
   * The participant type that produced this message (from the `x-ably-role`
   * header). Client-initiated publishes are `user`; agent-initiated publishes
   * are `assistant`. This is the protocol role, which may differ from the
   * role the codec encodes inside the domain message — use this when filtering
   * or attributing at the transport level.
   */
  readonly role: 'user' | 'assistant';

  /**
   * The clientId this message is attributed to. Taken from the
   * `x-ably-client-id` header when present (a backend publishing on behalf
   * of an end-user), otherwise from the publishing connection's
   * `message.clientId`. Use this for UI attribution, access checks, and
   * filtering to a specific user's activity.
   */
  readonly clientId: string;

  /**
   * The run this message belongs to. Typed to the session's run variant:
   * `ClientRun<TEvent, TMessage>` when this node comes from a ClientSession's
   * tree or view, `AgentRun<TMessage>` when it comes from an AgentSession. So
   * `node.run?.abort()`, `node.run?.sendMessages(...)`, etc. are directly
   * callable from the rendered node — no need to look up by ID through
   * `view.runs`.
   *
   * Undefined only when the node represents a message published before any
   * run was observed (e.g. during mid-hydration).
   */
  readonly run?: TRun;

  /**
   * The step that produced this message, if any. Only present on
   * agent-published messages. Use step.status to filter out messages
   * from non-complete steps (failed, abandoned, superseded).
   */
  readonly step?: StepState;

  /** Whether any part of this message is still being streamed. */
  readonly streaming: boolean;

  /** Parent message ID in the tree. Undefined for root messages. */
  readonly parentId?: string;

  /** Child message IDs (branches). Empty for leaf messages. */
  readonly children: ReadonlyArray<string>;
}
```

The package exports pre-bound aliases for the common run-variant specialisations
so callers rarely need to spell out the second generic by hand:

```ts
type ClientMessageNode<TEvent, TMessage> = MessageNode<TMessage, ClientRun<TEvent, TMessage>>;
type AgentMessageNode<TMessage> = MessageNode<TMessage, AgentRun<TMessage>>;
```

## Runs

```ts
/** Run status. */
type RunStatus = 'active' | 'suspended' | 'complete' | 'aborted' | 'failed';

/** Reason a run was suspended. */
type SuspendReason = 'awaiting-input' | 'paused';

/** Terminal status for ending a run. */
type RunEndStatus = 'complete' | 'aborted' | 'failed';

/** Readable run state, common to both client and agent. */
interface Run<TMessage> {
  readonly id: string;
  readonly status: RunStatus;

  /**
   * The clientId of the participant that opened this run. Taken from the
   * `x-ably-client-id` header on `x-ably-run-start` when a backend published
   * on behalf of an end-user; otherwise taken from the publishing
   * connection's `message.clientId`. Stable for the lifetime of the run.
   */
  readonly initiatorClientId: string;

  /** Present when status is 'suspended'. */
  readonly suspendReason?: SuspendReason;

  /** Steps within this run, ordered by serial. */
  readonly steps: ReadonlyArray<StepState>;

  /**
   * Messages belonging to this run. Each node's `run` is typed to the
   * session's run variant (specialised in ClientRun / AgentRun).
   */
  readonly messages: ReadonlyArray<MessageNode<TMessage>>;

  /**
   * Resolve when the run's status enters any of the targeted states.
   * Replaces hand-rolled `waitForRunEnd` patterns and closes the
   * subscribe-after-fetch race in fan-out orchestration.
   *
   * Pass exactly the statuses the caller cares about — no preset strings
   * like `'terminal'` or `'settled'`, because those vocabularies introduce
   * a second state namespace without adding information the caller doesn't
   * already have.
   *
   * @example
   * await run.when(['complete', 'failed', 'aborted']);              // former "terminal"
   * await run.when(['complete', 'failed', 'aborted', 'suspended']); // former "settled"
   *
   * @throws `Ably.ErrorInfo` with code `ErrorCode.RunClosed` when the
   *   session closes before the run reaches one of the targeted states.
   */
  when(statuses: RunStatus[]): Promise<RunStatus>;

  /**
   * Snapshot the run's current state into an {@link Invocation} the caller
   * can serialize and POST to an agent endpoint. Carries the session name,
   * this run's ID, and — when present — the message ID of the last message
   * sent into the run, so the agent can wait for that message to be visible
   * before starting its step.
   *
   * Exposed on the base `Run` interface so both client and agent code can
   * construct invocations; the agent uses it when fanning out to subagents
   * that own child runs it created via `session.writer.startRun(...)`.
   */
  toInvocation(): Invocation;
}

/**
 * Run as seen from a ClientSession. Adds lifecycle and control methods.
 *
 * The generic order `<TEvent, TMessage>` matches `ClientView` and
 * `Codec<TEvent, TMessage>` so per-run publish methods for messages
 * (`sendMessages`) and for discrete events (`sendEvents`) are typed uniformly
 * across the send surface.
 */
interface ClientRun<TEvent, TMessage> extends Run<TMessage> {
  /** Messages belonging to this run, with node.run typed as ClientRun. */
  readonly messages: ReadonlyArray<MessageNode<TMessage, ClientRun<TEvent, TMessage>>>;

  // --- Lifecycle ---

  /**
   * Publish `x-ably-run-start` to the channel. Call after creating the run
   * via view.createRun/createRegenerate/createEdit and before sending content.
   *
   * @throws `Ably.ErrorInfo` with code `ErrorCode.RunAlreadyStarted` when
   *   called twice on the same run. Lifecycle calls are orchestrator-
   *   authored; programming errors should be loud.
   */
  start(): Promise<void>;

  // --- Content ---

  /**
   * Publish one or more complete domain messages to this run. Encoded via
   * the codec's writeMessages path. Use for the initial user message (after
   * start), mid-run steering, and HITL tool-result re-entry.
   *
   * Message IDs are owned by the caller — for the Vercel codec, `UIMessage.id`
   * is required and is reused as the transport-level `x-ably-msg-id`; no ID
   * is generated by the SDK. Messages are tagged with this run's ID. Does
   * not require an agent to be running — the message is durable.
   *
   * Accepts a single message or an array, matching `Step.sendMessages` and
   * `SessionWriter.sendMessages` so the send surface is uniform.
   */
  sendMessages(messages: TMessage | TMessage[]): Promise<void>;

  /**
   * Publish one or more discrete domain events through the codec encoder.
   * Encoded via the codec's writeEvent path. Use for standalone events like
   * `data-*` that are not complete messages. Tagged to this run.
   *
   * Accepts a single event or an array, matching `Step.sendEvents` and
   * `SessionWriter.sendEvents`. The run-scoped variant has no step
   * attribution — events publish against the run itself rather than a step
   * within it.
   */
  sendEvents(events: TEvent | TEvent[]): Promise<void>;

  // --- Control signals ---

  /**
   * Abort this run. Publishes an abort control signal to the channel so a
   * running agent can observe it and close the run terminally.
   *
   * Returns the {@link Invocation} targeting this run; the caller POSTs it
   * to an agent endpoint when no agent is currently running (the channel
   * signal alone is only effective if an agent is listening; otherwise the
   * caller must wake one via the invocation). Returning the invocation
   * uniformly across all four control methods lets every control-signal
   * call site follow the same two-step "publish, then optionally POST"
   * pattern.
   *
   * Silent no-op when the signal would have no effect — i.e. when the run
   * is already in a terminal status (`'complete' | 'aborted' | 'failed'`).
   * Valid on `'active'` and `'suspended'` runs. Multi-device races are
   * idempotent by default.
   */
  abort(): Promise<Invocation>;

  /**
   * Pause this run. Publishes a pause control signal so the agent finishes
   * or interrupts its current step and suspends the run. See
   * {@link ClientRun.abort} for the `Invocation` return rationale. Silent
   * no-op when the signal would have no effect — i.e. when the run is
   * already `'suspended'` or has reached a terminal status. Valid only on
   * `'active'` runs.
   */
  pause(): Promise<Invocation>;

  /**
   * Resume this suspended run. Publishes a resume control signal, optionally
   * targeting a specific step for checkpoint-based resumption. See
   * {@link ClientRun.abort} for the `Invocation` return rationale. Silent
   * no-op when the signal would have no effect — i.e. when the run is
   * `'active'` or has reached a terminal status. Valid only on `'suspended'`
   * runs.
   */
  resume(options?: { stepId?: string }): Promise<Invocation>;

  /**
   * Retry this failed or abandoned run. Publishes a retry control signal,
   * optionally targeting a specific step for step-level retry. See
   * {@link ClientRun.abort} for the `Invocation` return rationale. Silent
   * no-op when the signal would have no effect — i.e. when the run is
   * still `'active'` or `'suspended'` (nothing to retry). Valid on
   * terminal runs (`'complete' | 'aborted' | 'failed'`).
   */
  retry(options?: { stepId?: string }): Promise<Invocation>;
}

/** Run as seen from an AgentSession. Adds agent lifecycle methods. */
interface AgentRun<TMessage> extends Run<TMessage> {
  /** Messages belonging to this run, with node.run typed as AgentRun. */
  readonly messages: ReadonlyArray<MessageNode<TMessage, AgentRun<TMessage>>>;

  /**
   * Suspend this run without closing it. Published by the agent when the
   * current step's work requires external input before continuing, or in
   * response to a pause signal.
   *
   * Idempotent on a run that is already suspended — publishes nothing and
   * resolves `void`. Durable retries and multi-replica races fold into
   * one effective transition without a guard.
   *
   * @throws `Ably.ErrorInfo` with code `ErrorCode.RunAlreadyTerminal` when
   *   called on a run that has already reached a terminal status. A
   *   suspend is forward motion, so suspending a terminal run is
   *   impossible and remains a loud programming error.
   */
  suspend(reason: SuspendReason): Promise<void>;

  /**
   * Close this run terminally. Published by the agent when the task
   * completes, is aborted, or fails beyond recovery.
   *
   * Idempotent on a run that has already reached a terminal status —
   * publishes nothing and resolves `void`. Re-publishing a terminal is
   * redundant, not a programming error; durable retries and the step
   * disposer both rely on this.
   */
  end(status: RunEndStatus): Promise<void>;
}
```

## Steps

```ts
/** Terminal status for a step. */
type StepEndStatus = 'complete' | 'failed' | 'aborted' | 'paused' | 'superseded';

/**
 * All possible step statuses including non-terminal states.
 *
 * `'pending'` is the pre-start status of a local step handle — a step
 * returned by `view.createStep()` before `start()` has resolved. It is
 * only reachable through a live in-memory handle; `'pending'` is never
 * materialised on the channel.
 */
type StepStatus = StepEndStatus | 'pending' | 'active' | 'abandoned';

/** Readable step state in the materialised tree. */
interface StepState {
  readonly id: string;
  readonly runId: string;
  readonly status: StepStatus;
}

/** Options accepted by {@link Step.start}. */
interface StepStartOptions {
  /**
   * Abort the precondition wait after this many milliseconds. Defaults to
   * `60_000` when neither `timeoutMs` nor `signal` is supplied — prevents
   * a hop from hanging forever waiting for an invocation message that
   * never arrives.
   */
  timeoutMs?: number;

  /**
   * Caller-supplied abort signal folded into {@link Step.signal}. After
   * `start()` resolves, `step.signal.aborted` becomes true whenever this
   * signal fires OR when an `x-ably-run-abort` control signal is observed
   * on the channel. Callers wire runtime-owned cancellation in here
   * (`req.signal` in serverless handlers, a WDK `abortSignal` in durable
   * execution) — the SDK does not introspect the runtime and composes
   * only what the caller hands it.
   */
  signal?: AbortSignal;
}

/**
 * The agent's active write handle for one continuous execution within a run.
 * Created from an AgentView via view.createStep(). The view carries the
 * invocation and exposes the conversation to pass to the model; the step is
 * the execution surface — it owns the abort signal, the pause handler, and
 * the write methods (pipe, sendMessages, sendEvents).
 *
 * Both Session and Step implement AsyncDisposable for scope-based cleanup
 * in serverless functions:
 *
 *   await using step = view.createStep();
 */
interface Step<TEvent, TMessage> {
  /** The step's unique ID, generated when the step is created. */
  readonly id: string;

  /**
   * Current status of the step — mirrors {@link StepState.status} once the
   * step is materialised on the channel. A freshly created step handle is
   * `'pending'` until {@link Step.start} resolves, at which point it
   * transitions to `'active'`. If `start()` rejects, the handle remains
   * `'pending'` and the disposer is a no-op.
   */
  readonly status: StepStatus;

  /**
   * Aborts when any of the following happens:
   *   - An `x-ably-run-abort` control signal is observed on the channel
   *     (the durable "run aborted" fact).
   *   - A signal passed to {@link Step.start} via `start({ signal })` fires
   *     (the caller folds in runtime-owned cancellation: `req.signal` in
   *     serverless handlers, a WDK `abortSignal` in durable execution).
   *
   * Wire into your model call as `abortSignal: step.signal`. No explicit
   * composition at call sites for the common case.
   *
   * If the run was aborted before this step started (e.g. during the gap
   * between a crash and a retry), the signal is already aborted when
   * {@link Step.start} resolves. Always check `signal.aborted` after
   * `start()` returns.
   */
  readonly signal: AbortSignal;

  /**
   * Wait for all preconditions declared in the view's invocation to be
   * visible in the session, then publish `x-ably-step-start` to the channel.
   * Resolves when the step is active and the view's messages are complete.
   *
   * If a pre-existing abort signal is found in the session (published while
   * no agent was running), `signal.aborted` will be true after `start()`
   * resolves. If a pre-existing pause signal is found, any `'pause'` handler
   * already registered fires immediately after `start()` resolves; handlers
   * registered later also receive the buffered signal on first subscription
   * (see {@link Step.on}).
   *
   * On successful resolution the step transitions from `'pending'` to
   * `'active'`. If `start()` rejects, the step remains `'pending'` — no
   * `x-ably-step-start` reached the channel, and the disposer is a no-op.
   *
   * @throws `Ably.ErrorInfo` with code:
   *   - `ErrorCode.StepSuperseded` — another `x-ably-step-start` with an
   *     earlier serial was observed for the same run (a sibling hop won).
   *   - `ErrorCode.InvocationPreconditionTimeout` — the precondition wait
   *     exceeded `timeoutMs`.
   *   - `ErrorCode.StepStartAborted` — the caller-supplied `options.signal`
   *     fired before preconditions were met.
   */
  start(options?: StepStartOptions): Promise<void>;

  /**
   * Publish `x-ably-step-end` with the given status and release step
   * resources (signal listeners, stream references).
   *
   * Idempotent on a step that has already reached a terminal status —
   * publishes nothing and resolves `void`. Supports the
   * retry-after-failure pattern where `step.end('failed')` is called
   * unconditionally in a catch block even though `step.start()` may
   * have already left the step terminal via `StepSuperseded`.
   */
  end(status: StepEndStatus): Promise<void>;

  /**
   * Symbol.asyncDispose — pessimistic safety net. Behaviour depends on
   * {@link Step.status} at dispose time:
   *
   *   - `'pending'` → no-op. `start()` never resolved, so the channel has
   *     no record of this step; publishing `x-ably-step-end` without a
   *     prior `x-ably-step-start` would put garbage on the wire.
   *   - `'active'` → publishes a terminal `x-ably-step-end` so the channel
   *     state does not leak a half-open step:
   *     - `step.signal.aborted` is true → publishes `step.end('aborted')`.
   *     - Otherwise → publishes `step.end('failed')` with cause
   *       `ErrorCode.StepDisposedBeforeEnd` (`104021`).
   *   - Terminal (any `StepEndStatus`) → pure cleanup, no publish. The
   *     idempotent `end()` contract means an explicit earlier
   *     `end('complete')` is not clobbered.
   *
   * Callers still call `step.end('complete')` explicitly on the happy path;
   * the disposer exists to close out runs that leave scope via a thrown
   * error.
   */
  [Symbol.asyncDispose](): Promise<void>;

  /**
   * Register a handler for a pause signal observed on the channel. The
   * agent can checkpoint state and end the step with `'paused'`, or let the
   * current work complete and end with `'complete'`.
   *
   * Pause signals are buffered: any pause observed before a handler is
   * registered (including signals materialised during `start()`) is
   * delivered synchronously to the handler on first subscription. This
   * removes the order-sensitive "register before `start()`" footgun —
   * handlers can be registered at any point and will still see prior
   * pauses.
   */
  on(event: 'pause', handler: () => void): void;

  off(event: 'pause', handler: () => void): void;

  /**
   * Pipe a readable stream through the codec encoder to the channel. Each
   * chunk is encoded and published as it arrives. The step's abort signal
   * is wired in automatically — if the run is aborted mid-pipe, the stream
   * is cancelled.
   */
  pipe(stream: ReadableStream<TEvent>): Promise<void>;

  /**
   * Publish one or more complete domain messages through the codec encoder.
   * Encoded via the codec's writeMessages path. Use for complete messages
   * like tool results or structured responses.
   */
  sendMessages(messages: TMessage | TMessage[]): Promise<void>;

  /**
   * Publish one or more discrete domain events through the codec encoder.
   * Encoded via the codec's writeEvent path. Use for standalone events like
   * `data-*` that are not complete messages.
   */
  sendEvents(events: TEvent | TEvent[]): Promise<void>;
}
```

## Invocation

```ts
/**
 * A typed data structure carrying preconditions for an agent invocation.
 * Produced by client-side operations that need an agent to act. The developer
 * owns the HTTP transport; the SDK defines the contract on both sides.
 *
 * Construct one from a wire payload via Invocation.fromJSON; construct one
 * from a live run via `run.toInvocation()` (see
 * {@link Run.toInvocation}).
 */
interface Invocation {
  /** The session name the agent should open. */
  readonly sessionName: string;

  /** The run ID the agent should act on. */
  readonly runId: string;

  /** Optional step ID — targets a specific prior step for resumption. */
  readonly stepId?: string;

  /** Optional message ID — the agent waits for this message to be visible. */
  readonly messageId?: string;

  /** Serialize to a plain object for HTTP transport. */
  toJSON(): InvocationData;
}

/** Plain object representation of an invocation, suitable for JSON serialization. */
interface InvocationData {
  sessionName: string;
  runId: string;
  stepId?: string;
  messageId?: string;
}
```

### Invocation.fromJSON

`Invocation` is both a type and a value — TypeScript declaration merging binds
the interface above to a `const` of the same name that exposes the static
construction path. Agent entry points use `Invocation.fromJSON(data)` to
rehydrate the typed handle from an incoming HTTP body.

```ts
interface InvocationConstructor {
  /**
   * Rehydrate an {@link Invocation} from its serialized form.
   *
   * @throws `Ably.ErrorInfo` with code `ErrorCode.InvocationInvalid` when
   *   `data` does not describe a valid invocation (e.g. missing
   *   `sessionName` or `runId`).
   */
  fromJSON(data: InvocationData): Invocation;
}

declare const Invocation: InvocationConstructor;
```

See [Runs](#runs) for `run.toInvocation()`, the instance-method counterpart
available on both `ClientRun` and `AgentRun`.

## Error codes

All SDK-specific error codes live in the reserved `104xxx` range per
[.claude/rules/ERRORS.md](../.claude/rules/ERRORS.md). HTTP `statusCode`
values on each `Ably.ErrorInfo` are derived case-by-case rather than by
slicing the numeric code.

```ts
enum ErrorCode {
  // Transport
  TransportSendFailed = 104000,
  TransportSubscriptionError = 104001,

  // Step disposer safety net
  StepDisposedBeforeEnd = 104021,

  // Session lifecycle
  SessionClosed = 104100,
  HydrationFailed = 104101,

  // Run lifecycle
  RunAlreadyStarted = 104199,
  RunAlreadyTerminal = 104200,
  RunClosed = 104201,

  // Step lifecycle
  StepSuperseded = 104300,
  InvocationPreconditionTimeout = 104301,
  StepStartAborted = 104302,

  // View / invocation
  ViewClosed = 104400,
  ViewNodeNotFound = 104401,
  InvocationInvalid = 104402,

  // Storage
  StorageWriteFailed = 104500,
}
```

| Code     | Name                            | Meaning                                                                                                                                                                                                      |
| -------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `104000` | `TransportSendFailed`           | Publishing a message or event through the transport failed.                                                                                                                                                  |
| `104001` | `TransportSubscriptionError`    | The underlying Ably channel subscription failed.                                                                                                                                                             |
| `104021` | `StepDisposedBeforeEnd`         | `Step[Symbol.asyncDispose]` fired while the step was still active with no explicit `end()`; attached as `cause` on the disposer's `step.end('failed')` publish.                                              |
| `104100` | `SessionClosed`                 | The session has been closed; the requested operation is no longer valid.                                                                                                                                     |
| `104101` | `HydrationFailed`               | Hydration from the configured `StorageReader` failed.                                                                                                                                                        |
| `104199` | `RunAlreadyStarted`             | `run.start()` was called on a run that has already been started.                                                                                                                                             |
| `104200` | `RunAlreadyTerminal`            | `AgentRun.suspend()` was called on a run that is terminal — a forward-motion transition that is impossible. (`end()` and `suspend()` on already-satisfied states are idempotent and do not raise this code.) |
| `104201` | `RunClosed`                     | `run.when()` rejected because the session closed before the targeted status was reached.                                                                                                                     |
| `104300` | `StepSuperseded`                | `step.start()` rejected because a later `x-ably-step-start` for the same run won arbitration.                                                                                                                |
| `104301` | `InvocationPreconditionTimeout` | `step.start()` timed out waiting for the invocation's preconditions to become visible.                                                                                                                       |
| `104302` | `StepStartAborted`              | `step.start()` was aborted by the caller-supplied `AbortSignal` before it resolved.                                                                                                                          |
| `104400` | `ViewClosed`                    | The view has been closed; the requested operation is no longer valid.                                                                                                                                        |
| `104401` | `ViewNodeNotFound`              | `view.select()` was called with a message ID that does not exist in the tree.                                                                                                                                |
| `104402` | `InvocationInvalid`             | `Invocation.fromJSON()` was called with data that does not describe a valid invocation.                                                                                                                      |
| `104500` | `StorageWriteFailed`            | The configured `StorageWriter` exhausted its retry budget; surfaced via `session.on('error')`.                                                                                                               |

## StorageReader and StorageWriter

```ts
/**
 * Loads historical state into a session during connect(). The SDK ships a
 * channel history provider as the default. Developers implement this for
 * external stores (database, cache) or durable-execution framework state.
 *
 * The session materialises from whatever the reader yields, regardless of
 * source. Two sessions hydrated from different sources with the same data
 * arrive at the same state.
 */
interface StorageReader {
  /**
   * Yield encoded channel messages in serial order.
   * The session materialises each message as it arrives.
   */
  read(): AsyncIterable<Ably.Message>;
}

/**
 * Receives channel messages as the session processes them, for external
 * persistence. The writer decides what to persist, how to batch, and how
 * to handle errors. The session does not retry on write failure.
 */
interface StorageWriter {
  /**
   * Called for each channel message the session processes, including both
   * historical messages (during hydration) and live messages.
   */
  write(message: Ably.Message): Promise<void>;
}
```

## Codec

```ts
/**
 * Translation layer between domain events and channel operations. The codec
 * is an interface — the session and transport depend on the codec contract
 * and know nothing about the domain model.
 *
 * TEvent is the granular domain event type (e.g., a UIMessageChunk).
 * TMessage is the assembled domain message type (e.g., a UIMessage).
 */
interface Codec<TEvent, TMessage> {
  /** Creates an encoder for producing channel messages from domain events. */
  createEncoder(): Encoder<TEvent>;

  /** Creates a decoder for consuming channel messages into domain events. */
  createDecoder(): Decoder<TEvent>;

  /** Creates an accumulator for assembling events into messages. */
  createAccumulator(): Accumulator<TEvent, TMessage>;
}
```

---

# Usage examples

## Example 1: Basic chat

Minimal send/stream/receive across a durable session. Shows the full lifecycle:
session setup, view creation, run start, sending the user message, invoking
the agent, and piping the model stream through a step. This is the baseline;
later examples elide setup back to this.

```ts
// --- client ---
import * as Ably from 'ably';
import type * as AI from 'ai';
import { createClientSession } from '@ably/ai-transport';
import type { InvocationData } from '@ably/ai-transport';
import { UIMessageCodec } from '@ably/ai-transport/vercel';

const ably = new Ably.Realtime({ authUrl: '/api/ably-token' });
const codec = new UIMessageCodec();

const session = createClientSession<AI.UIMessageChunk, AI.UIMessage>({
  client: ably,
  sessionName: 'session:abc123',
  codec,
});
await session.connect();

const view = session.createView();
view.subscribe(() => {
  // UI reads view.messages and renders them
});

const invokeAgent = async (data: InvocationData): Promise<void> => {
  await fetch('/api/agent', { method: 'POST', body: JSON.stringify(data) });
};

const onSendClick = async (text: string): Promise<void> => {
  const run = view.createRun();
  await run.start();
  await run.sendMessages({
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text }],
  });
  await invokeAgent(run.toInvocation().toJSON());
};
```

Four low-level calls on the client. The SDK does not generate message IDs —
the caller owns `UIMessage.id`.

```ts
// --- agent ---
import type * as Ably from 'ably';
import type * as AI from 'ai';
import { convertToModelMessages, stepCountIs, ToolLoopAgent } from 'ai';

import { createAgentSession, Invocation } from '@ably/ai-transport';
import type { Codec, InvocationData } from '@ably/ai-transport';

declare const ably: Ably.Realtime;
declare const codec: Codec<AI.UIMessageChunk, AI.UIMessage>;
declare const openai: (model: string) => AI.LanguageModel;
declare const tools: AI.ToolSet;

const agent = new ToolLoopAgent({
  model: openai('gpt-4o'),
  tools,
  stopWhen: stepCountIs(20),
});

export const POST = async (req: Request): Promise<Response> => {
  const data = (await req.json()) as InvocationData;
  const invocation = Invocation.fromJSON(data);

  await using session = createAgentSession<AI.UIMessageChunk, AI.UIMessage>({
    client: ably,
    sessionName: invocation.sessionName,
    codec,
  });
  await session.connect();

  const view = session.createView(invocation);
  await using step = view.createStep();
  await step.start({ signal: req.signal, timeoutMs: 60_000 });

  try {
    const result = await agent.stream({
      messages: await convertToModelMessages(view.messages.map((n) => n.message)),
      abortSignal: step.signal,
    });
    await step.pipe(result.toUIMessageStream());
    await step.end('complete');
    await view.run.end('complete');
  } catch (err) {
    await view.run.end(step.signal.aborted ? 'aborted' : 'failed');
    throw err;
  }

  return new Response(undefined, { status: 202 });
};
```

`req.signal` is folded into `step.signal` via `start({ signal })`. The model
call wires a single `abortSignal: step.signal`. The catch branch uses
`step.signal.aborted` to pick terminal status; the step disposer publishes
`x-ably-step-end` automatically if the `try` body throws before `step.end`.

## Example 2: Aborting a response

Abort is durable state on the session: the client publishes an abort signal,
and the agent's `step.signal` fires whether the agent was live or not. Per
plan §5.3, control signals on `ClientRun` return an `Invocation` the caller
POSTs to the agent endpoint to guarantee the lifecycle state lands when no
agent is currently running. Each control signal is a silent no-op when the
signal would have no effect (e.g. `pause()` on a run that's already
suspended), so call sites don't need status guards.

```ts
// --- client ---
import type * as AI from 'ai';
import type { ClientRun, ClientView } from '@ably/ai-transport';

// View-wide stop — aborts every cancellable run. `abort()` is a no-op on
// terminal runs, so filter out the already-done ones to avoid redundant
// wake-up POSTs.
const onStopAllClick = async (view: ClientView<AI.UIMessageChunk, AI.UIMessage>): Promise<void> => {
  const cancellable = view.runs.filter((r) => r.status === 'active' || r.status === 'suspended');
  const invocations = await Promise.all(cancellable.map(async (r) => r.abort()));
  for (const invocation of invocations) {
    void fetch('/api/agent', {
      method: 'POST',
      body: JSON.stringify(invocation.toJSON()),
    });
  }
};

// Stop a specific run — called from a run-scoped UI control (e.g. a
// stop button rendered inside a specific conversation thread).
const onStopRun = async (run: ClientRun<AI.UIMessageChunk, AI.UIMessage>): Promise<void> => {
  const invocation = await run.abort();
  void fetch('/api/agent', {
    method: 'POST',
    body: JSON.stringify(invocation.toJSON()),
  });
};

// Pause a specific run.
const onPauseRun = async (run: ClientRun<AI.UIMessageChunk, AI.UIMessage>): Promise<void> => {
  const invocation = await run.pause();
  void fetch('/api/agent', {
    method: 'POST',
    body: JSON.stringify(invocation.toJSON()),
  });
};

// Resume a specific suspended run. Awaits the POST so the UI learns the
// agent endpoint accepted the wake-up.
const onResumeRun = async (run: ClientRun<AI.UIMessageChunk, AI.UIMessage>): Promise<void> => {
  const invocation = await run.resume();
  await fetch('/api/agent', {
    method: 'POST',
    body: JSON.stringify(invocation.toJSON()),
  });
};
```

On the agent, abort and pause produce different terminal states, so the
handler composes `step.signal` with a local pause controller:

```ts
// --- agent ---
export const POST = async (req: Request): Promise<Response> => {
  const data = (await req.json()) as InvocationData;
  const invocation = Invocation.fromJSON(data);

  await using session = createAgentSession<AI.UIMessageChunk, AI.UIMessage>({
    client: ably,
    sessionName: invocation.sessionName,
    codec,
  });
  await session.connect();

  const view = session.createView(invocation);
  await using step = view.createStep();

  const pauseCtrl = new AbortController();
  let paused = false;
  step.on('pause', () => {
    paused = true;
    pauseCtrl.abort();
  });

  await step.start({ signal: req.signal, timeoutMs: 60_000 });

  // A prior abort already on the channel leaves step.signal aborted.
  if (step.signal.aborted) {
    await step.end('aborted');
    await view.run.end('aborted');
    return new Response(undefined, { status: 202 });
  }

  try {
    const result = await agent.stream({
      messages: await convertToModelMessages(view.messages.map((n) => n.message)),
      abortSignal: AbortSignal.any([step.signal, pauseCtrl.signal]),
    });
    await step.pipe(result.toUIMessageStream());

    if (paused) {
      await step.end('paused');
      await view.run.suspend('paused');
    } else {
      await step.end('complete');
      await view.run.end('complete');
    }
  } catch (err) {
    if (paused) {
      await step.end('paused');
      await view.run.suspend('paused');
    } else {
      await view.run.end(step.signal.aborted ? 'aborted' : 'failed');
    }
    throw err;
  }

  return new Response(undefined, { status: 202 });
};
```

## Example 3: Steering a running agent

A user sends a follow-up while the agent is still responding. The agent's
`view.messages` updates live because the view subscribes to the tree, so the
next iteration of the agent loop sees the new input. Solves **no live control
of a running agent** — no cancel-and-restart, the in-progress work survives.

```ts
// --- client ---
import type * as AI from 'ai';
import type { ClientRun, ClientView, MessageNode } from '@ably/ai-transport';

// Single-conversation UI: steer the one active run.
const onSteerClick = async (view: ClientView<AI.UIMessageChunk, AI.UIMessage>, text: string): Promise<void> => {
  const activeRun = view.runs.find((r) => r.status === 'active');
  if (!activeRun) return;
  await activeRun.sendMessages({
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text }],
  });
};

// Per-message variant — e.g. the UI shows a "reply here" affordance on a
// specific assistant response. The handler targets THAT node's run.
const onSteerAtNode = async (
  node: MessageNode<AI.UIMessage, ClientRun<AI.UIMessageChunk, AI.UIMessage>>,
  text: string,
): Promise<void> => {
  if (node.run?.status !== 'active') return;
  await node.run.sendMessages({
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text }],
  });
};
```

```ts
// --- agent ---
export const POST = async (req: Request): Promise<Response> => {
  const data = (await req.json()) as InvocationData;
  const invocation = Invocation.fromJSON(data);

  await using session = createAgentSession<AI.UIMessageChunk, AI.UIMessage>({
    client: ably,
    sessionName: invocation.sessionName,
    codec,
  });
  await session.connect();

  const view = session.createView(invocation);
  await using step = view.createStep();
  await step.start({ signal: req.signal, timeoutMs: 60_000 });

  // Track the tail user message id — robust to the agent's own messages
  // being appended during pipe.
  const latestUserId = (): string | undefined => view.messages.findLast((n) => n.message.role === 'user')?.id;
  let lastUserId = latestUserId();

  try {
    while (!step.signal.aborted) {
      const result = await agent.stream({
        messages: await convertToModelMessages(view.messages.map((n) => n.message)),
        abortSignal: step.signal,
      });
      await step.pipe(result.toUIMessageStream());

      const currentUserId = latestUserId();
      if (currentUserId === lastUserId) break;
      lastUserId = currentUserId;
    }

    await step.end('complete');
    await view.run.end('complete');
  } catch (err) {
    await view.run.end(step.signal.aborted ? 'aborted' : 'failed');
    throw err;
  }

  return new Response(undefined, { status: 202 });
};
```

## Example 4: HITL tool approval

The agent proposes a tool call, suspends the run pending approval, and a later
invocation (with a `messageId` precondition) picks up after the client
publishes the approval. The approval targets a specific `toolCallId` via the
Vercel-layer `pendingToolCalls` helper (plan §4) — a pure function over
`run.messages` that surfaces every `input-available` tool part on the last
assistant message.

```ts
// --- client ---
import type * as AI from 'ai';
import { pendingToolCalls } from '@ably/ai-transport/vercel';
import type { ClientRun } from '@ably/ai-transport';

const approveToolCall = async (
  run: ClientRun<AI.UIMessageChunk, AI.UIMessage>,
  toolCallId: string,
  output: unknown,
): Promise<void> => {
  if (run.status !== 'suspended') return;
  const pending = pendingToolCalls(run.messages).find((tc) => tc.toolCallId === toolCallId);
  if (!pending) return;

  await run.sendMessages({
    id: crypto.randomUUID(),
    role: 'user',
    parts: [
      {
        type: `tool-${pending.toolName}`,
        toolCallId,
        state: 'output-available',
        input: pending.input,
        output,
      },
    ],
  });

  await fetch('/api/agent', {
    method: 'POST',
    body: JSON.stringify(run.toInvocation().toJSON()),
  });
};

const denyToolCall = async (
  run: ClientRun<AI.UIMessageChunk, AI.UIMessage>,
  toolCallId: string,
  reason: string,
): Promise<void> => {
  if (run.status !== 'suspended') return;
  const pending = pendingToolCalls(run.messages).find((tc) => tc.toolCallId === toolCallId);
  if (!pending) return;

  await run.sendMessages({
    id: crypto.randomUUID(),
    role: 'user',
    parts: [
      {
        type: `tool-${pending.toolName}`,
        toolCallId,
        state: 'output-error',
        input: pending.input,
        errorText: reason,
      },
    ],
  });

  await fetch('/api/agent', {
    method: 'POST',
    body: JSON.stringify(run.toInvocation().toJSON()),
  });
};
```

```ts
// --- agent ---
export const POST = async (req: Request): Promise<Response> => {
  const data = (await req.json()) as InvocationData;
  const invocation = Invocation.fromJSON(data);

  await using session = createAgentSession<AI.UIMessageChunk, AI.UIMessage>({
    client: ably,
    sessionName: invocation.sessionName,
    codec,
  });
  await session.connect();

  const view = session.createView(invocation);
  await using step = view.createStep();
  await step.start({ signal: req.signal, timeoutMs: 60_000 });

  try {
    const result = streamText({
      model: openai('gpt-4o'),
      messages: await convertToModelMessages(view.messages.map((n) => n.message)),
      tools,
      abortSignal: step.signal,
    });
    await step.pipe(result.toUIMessageStream());
    await step.end('complete');

    // Did the model request a tool? Suspend the run until the user approves.
    const last = view.messages.findLast((n) => n.message.role === 'assistant');
    const proposedTool = last?.message.parts.find((p) => p.type.startsWith('tool-'));
    await (proposedTool ? view.run.suspend('awaiting-input') : view.run.end('complete'));
  } catch (err) {
    await view.run.end(step.signal.aborted ? 'aborted' : 'failed');
    throw err;
  }

  return new Response(undefined, { status: 202 });
};
```

## Example 5: Regenerating a response

`view.createRegenerate(messageId)` forks the tree. The original response is
preserved alongside the new branch; by default the view auto-selects the new
branch (pass `{ autoSelect: false }` to leave selection untouched). Solves the
**conversation branching** side of the tree abstraction — multiple runs
coexist on the same parent.

```ts
// --- client ---
import type * as AI from 'ai';
import type { ClientSession, ClientView, InvocationData } from '@ably/ai-transport';

const invokeAgent = async (data: InvocationData): Promise<void> => {
  await fetch('/api/agent', { method: 'POST', body: JSON.stringify(data) });
};

// Fork at the response the user wants redone. The view auto-selects the new
// branch — no explicit view.select() needed.
const onRegenerateClick = async (
  view: ClientView<AI.UIMessageChunk, AI.UIMessage>,
  assistantMessageId: string,
): Promise<void> => {
  const run = view.createRegenerate(assistantMessageId);
  await run.start();
  await invokeAgent(run.toInvocation().toJSON());
};

// Branch switcher UI.
const onSelectBranchClick = (view: ClientView<AI.UIMessageChunk, AI.UIMessage>, messageId: string): void => {
  view.select(messageId);
};

// UI reads view.messages; for each node, parentId + session.tree.getMessage(parentId).children.length
// tells it whether siblings exist so it can show branch-switcher controls.
const wireBranchSwitcher = (
  session: ClientSession<AI.UIMessageChunk, AI.UIMessage>,
  view: ClientView<AI.UIMessageChunk, AI.UIMessage>,
): (() => void) =>
  view.subscribe(() => {
    for (const node of view.messages) {
      if (!node.parentId) continue;
      const parent = session.tree.getMessage(node.parentId);
      if (parent && parent.children.length > 1) {
        // UI renders a branch-switcher for this node using parent.children.
      }
    }
  });
```

```ts
// --- agent ---
// Agent code is unchanged from Example 1. The run carries the forked parentId;
// the agent reads view.messages, which already reflects the correct branch.
```

## Example 6: Multi-device continuity

Two clients open the same session (same session name). Both hydrate from
channel history, see identical state, and either device can abort a running
run. Solves **multi-device continuity** — the session follows the user, not
the connection.

```ts
// --- phone ---
const startFromPhone = async (text: string): Promise<void> => {
  const session = createClientSession<AI.UIMessageChunk, AI.UIMessage>({
    client: ably,
    sessionName: 'session:abc123',
    codec,
  });
  await session.connect();

  const view = session.createView();
  const run = view.createRun();
  await run.start();
  await run.sendMessages({
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text }],
  });
  await invokeAgent(run.toInvocation().toJSON());
};
```

```ts
// --- laptop (opened minutes later, same session:abc123) ---
const resumeFromLaptop = async (): Promise<ClientView<AI.UIMessageChunk, AI.UIMessage>> => {
  const session = createClientSession<AI.UIMessageChunk, AI.UIMessage>({
    client: ably,
    sessionName: 'session:abc123',
    codec,
  });
  await session.connect(); // hydrates from channel history

  const view = session.createView();
  view.subscribe(() => {
    // UI reads view.messages and view.runs
  });
  return view;
};

// The in-flight run is visible in view.runs. The user can abort from here —
// either globally (pattern below) or by rendering a stop button on a specific
// message and calling node.run?.abort() directly, as in Example 2.
const onStopClick = async (view: ClientView<AI.UIMessageChunk, AI.UIMessage>): Promise<void> => {
  const active = view.runs.find((r) => r.status === 'active');
  if (!active) return;
  const invocation = await active.abort();
  void fetch('/api/agent', {
    method: 'POST',
    body: JSON.stringify(invocation.toJSON()),
  });
};
```

## Example 7: Retry after failure

A step ends `failed`. The client observes it, publishes a retry control signal
targeting that step, and POSTs the returned invocation; a fresh invocation
starts a new step with a new step ID, and the total order by serial resolves
any race.

```ts
// --- client ---
import type { ClientSession } from '@ably/ai-transport';

const wireRetryOnFailure = (session: ClientSession<AI.UIMessageChunk, AI.UIMessage>): void => {
  session.tree.on('step-ended', (step, run) => {
    if (step.status !== 'failed') return;
    void (async (): Promise<void> => {
      const invocation = await run.retry({ stepId: step.id });
      await fetch('/api/agent', {
        method: 'POST',
        body: JSON.stringify(invocation.toJSON()),
      });
    })();
  });
};
```

```ts
// --- agent ---
export const POST = async (req: Request): Promise<Response> => {
  const data = (await req.json()) as InvocationData;
  const invocation = Invocation.fromJSON(data);

  await using session = createAgentSession<AI.UIMessageChunk, AI.UIMessage>({
    client: ably,
    sessionName: invocation.sessionName,
    codec,
  });
  await session.connect();

  const view = session.createView(invocation);
  await using step = view.createStep();

  try {
    await step.start({ signal: req.signal, timeoutMs: 60_000 });
    const result = await agent.stream({
      messages: await convertToModelMessages(view.messages.map((n) => n.message)),
      abortSignal: step.signal,
    });
    await step.pipe(result.toUIMessageStream());
    await step.end('complete');
    await view.run.end('complete');
  } catch {
    // If step.start() rejected with StepSuperseded, the step is already
    // terminal; end('failed') is a no-op in that case. Otherwise mark the
    // attempt failed so the retry signal has something to target.
    await step.end('failed');
  }

  return new Response(undefined, { status: 202 });
};
```

## Example 8: Server-side input validation

The client POSTs the user's input to the backend instead of publishing
directly. The route validates, then uses `session.writer` (without calling
`connect()`) to publish `x-ably-run-start` and the user message on the
client's behalf. The caller owns the message ID — the writer does not return
IDs.

```ts
// --- client ---
import type { ClientSession, InvocationData } from '@ably/ai-transport';

const invokeAgent = async (data: InvocationData): Promise<void> => {
  await fetch('/api/agent', { method: 'POST', body: JSON.stringify(data) });
};

const onSendClick = async (
  session: ClientSession<AI.UIMessageChunk, AI.UIMessage>,
  text: string,
): Promise<{ ok: boolean; reason?: string }> => {
  const res = await fetch('/api/validate-and-send', {
    method: 'POST',
    body: JSON.stringify({ sessionName: session.sessionName, text }),
    // The request is authenticated however the app authenticates users
    // (cookies, bearer tokens, etc.); the backend uses that identity to set
    // x-ably-client-id on the publish.
  });
  if (!res.ok) return { ok: false, reason: 'input rejected' };
  const invocationData = (await res.json()) as InvocationData;
  await invokeAgent(invocationData);
  return { ok: true };
};
```

```ts
// --- server route (validation + publish on behalf of client) ---
interface ValidateAndSendBody {
  sessionName: string;
  text: string;
}

export const POST = async (req: Request): Promise<Response> => {
  const { sessionName, text } = (await req.json()) as ValidateAndSendBody;
  if (!passesModeration(text)) return new Response('rejected', { status: 400 });

  const userClientId = getAuthenticatedUserClientId(req); // app-specific auth
  const session = createClientSession<AI.UIMessageChunk, AI.UIMessage>({
    client: ably,
    sessionName,
    codec,
  });
  // Note: no connect() — writer publishes directly to the channel.

  // Pass clientId so x-ably-client-id on x-ably-run-start and the user
  // message attributes both to the end-user rather than to this backend
  // connection. The caller owns the message ID so the invocation can
  // reference it without reading anything back from the writer.
  const { runId } = await session.writer.startRun({ clientId: userClientId });
  const messageId = crypto.randomUUID();
  await session.writer.sendMessages({
    runId,
    clientId: userClientId,
    messages: {
      id: messageId,
      role: 'user',
      parts: [{ type: 'text', text }],
    },
  });

  const data: InvocationData = { sessionName, runId, messageId };
  return Response.json(data);
};
```

## Example 9: Durable execution (Vercel Workflow DevKit)

One run spans multiple durable-execution stages, each one a distinct step. The
framework re-drives a failed stage; each retry opens a new `x-ably-step-start`,
and losing attempts reject `step.start()` with `ErrorCode.StepSuperseded`. A
`storageReader` backed by the workflow's framework state materialises the
session on each stage boundary.

The run's closing publish runs as its own writer-only hop (plan §5.7): no
`connect()`, no tree hydration — `session.writer.endRun` publishes
`x-ably-run-end` directly, then the session is closed.

```ts
// --- durable workflow (one run, one step per hop) ---
import * as Ably from 'ably';
import type * as AI from 'ai';
import { convertToModelMessages, stepCountIs } from 'ai';
import { DurableAgent } from '@workflow/ai/agent';
import { getWritable } from 'workflow';

import { createAgentSession, ErrorCode, Invocation } from '@ably/ai-transport';
import type { Codec, InvocationData, StorageReader } from '@ably/ai-transport';

declare const ably: Ably.Realtime;
declare const codec: Codec<AI.UIMessageChunk, AI.UIMessage>;
declare const tools: AI.ToolSet;
declare const workflowStateReader: (runId: string) => StorageReader;

const agent = new DurableAgent({ model: 'openai/gpt-4o', tools });

const MAX_STEPS = 20;

const isErrorInfoWithCode = (value: unknown, code: ErrorCode): boolean =>
  value instanceof Ably.ErrorInfo && value.code === code;

export const runAgentHop = async (
  invocationData: InvocationData,
  { abortSignal: wdkSignal }: { abortSignal: AbortSignal },
): Promise<AI.FinishReason> => {
  'use step';

  const invocation = Invocation.fromJSON(invocationData);

  await using session = createAgentSession<AI.UIMessageChunk, AI.UIMessage>({
    client: ably,
    sessionName: invocation.sessionName,
    codec,
    storageReader: workflowStateReader(invocation.runId),
  });
  await session.connect();

  const view = session.createView(invocation);
  await using step = view.createStep();

  try {
    await step.start({ signal: wdkSignal, timeoutMs: 60_000 });
  } catch (e) {
    // Losing hop: a later x-ably-step-start for the same run won arbitration.
    // Exit cleanly and let the winner publish the terminal state.
    if (isErrorInfoWithCode(e, ErrorCode.StepSuperseded)) return 'stop';
    throw e;
  }

  try {
    const bridge = new TransformStream<AI.UIMessageChunk, AI.UIMessageChunk>();
    const readable: ReadableStream<AI.UIMessageChunk> = bridge.readable;
    const [, result] = await Promise.all([
      step.pipe(readable),
      agent.stream({
        messages: await convertToModelMessages(view.messages.map((n) => n.message)),
        writable: bridge.writable,
        stopWhen: stepCountIs(1),
        abortSignal: step.signal,
      }),
    ]);

    await step.end('complete');

    const lastStep = result.steps.at(-1);
    return lastStep?.finishReason ?? 'stop';
  } catch (err) {
    await view.run.end(step.signal.aborted ? 'aborted' : 'failed');
    throw err;
  }
};

// Lifecycle-only hop: no connect(), no tree hydration — the writer publishes
// x-ably-run-end directly to the channel (plan §5.7).
export const endRun = async (invocationData: InvocationData): Promise<void> => {
  'use step';

  const session = createAgentSession<AI.UIMessageChunk, AI.UIMessage>({
    client: ably,
    sessionName: invocationData.sessionName,
    codec,
  });
  await session.writer.endRun({ runId: invocationData.runId, status: 'complete' });
  await session.close();
};

export const agentWorkflow = async (invocationData: InvocationData): Promise<void> => {
  'use workflow';

  getWritable<AI.UIMessageChunk>();

  for (let i = 0; i < MAX_STEPS; i++) {
    const finishReason = await runAgentHop(invocationData, {
      abortSignal: new AbortController().signal,
    });
    if (finishReason !== 'tool-calls') {
      await endRun(invocationData);
      return;
    }
  }
};
```

Whether the caller passes `wdkSignal` to `step.start` controls the durable-
cancel story: passing it folds WDK cancellation into the step's abort path;
omitting it treats WDK retries as invisible to the agent.

## Example 10: Subagent fan-out

A parent agent spawns concurrent child runs by opening new runs via
`session.writer.startRun` and POSTing to the subagent endpoint. When the
parent's step is aborted, `step.signal` cascades via `session.writer.abort`
to each child run — listeners are attached per-child so late-spawned children
still receive the cascade. `run.when(['complete', 'failed', 'aborted'])`
closes the subscribe-after-fetch race by registering before the fetch and
awaiting after it.

```ts
// --- parent agent ---
import type * as Ably from 'ably';
import type * as AI from 'ai';
import { convertToModelMessages, jsonSchema, stepCountIs, tool, ToolLoopAgent } from 'ai';

import { createAgentSession, Invocation } from '@ably/ai-transport';
import type { Codec, InvocationData } from '@ably/ai-transport';

declare const ably: Ably.Realtime;
declare const codec: Codec<AI.UIMessageChunk, AI.UIMessage>;
declare const openai: (model: string) => AI.LanguageModel;

export const POST = async (req: Request): Promise<Response> => {
  const data = (await req.json()) as InvocationData;
  const invocation = Invocation.fromJSON(data);

  await using session = createAgentSession<AI.UIMessageChunk, AI.UIMessage>({
    client: ably,
    sessionName: invocation.sessionName,
    codec,
  });
  await session.connect();

  const view = session.createView(invocation);
  await using step = view.createStep();
  await step.start({ signal: req.signal, timeoutMs: 60_000 });

  const spawnSubagent = tool({
    description:
      'Delegate a subtask to a fresh subagent. Returns the subagent\u2019s final text once the run completes.',
    inputSchema: jsonSchema<{ task: string }>({
      type: 'object',
      properties: { task: { type: 'string' } },
      required: ['task'],
    }),
    execute: async ({ task }) => {
      const { runId } = await session.writer.startRun({});
      await session.writer.sendMessages({
        runId,
        messages: {
          id: crypto.randomUUID(),
          role: 'user',
          parts: [{ type: 'text', text: task }],
        },
      });

      const childRun = session.tree.getRun(runId);
      if (!childRun) throw new Error('unreachable');

      await fetch('/api/subagent', {
        method: 'POST',
        body: JSON.stringify(childRun.toInvocation().toJSON()),
      });

      // Per-child abort cascade, registered after the child exists so
      // late-spawned children still receive the parent's abort.
      const offCascade = (): void => void session.writer.abort({ runId });
      step.signal.addEventListener('abort', offCascade);

      const finalStatus = await childRun.when(['complete', 'failed', 'aborted']);
      step.signal.removeEventListener('abort', offCascade);

      const finalMessage = childRun.messages.findLast((n) => n.message.role === 'assistant');
      const text = finalMessage?.message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';
      return { runId, status: finalStatus, text };
    },
  });

  const orchestrator = new ToolLoopAgent({
    model: openai('gpt-4o'),
    tools: { spawnSubagent },
    stopWhen: stepCountIs(20),
  });

  try {
    const result = await orchestrator.stream({
      messages: await convertToModelMessages(view.messages.map((n) => n.message)),
      abortSignal: step.signal,
    });
    await step.pipe(result.toUIMessageStream());

    const outcome = step.signal.aborted ? 'aborted' : 'complete';
    await step.end(outcome);
    await view.run.end(outcome);
  } catch (err) {
    await view.run.end(step.signal.aborted ? 'aborted' : 'failed');
    throw err;
  }

  return new Response(undefined, { status: 202 });
};
```

```ts
// --- subagent endpoint ---
// Standard agent handler (as in Example 1). Reads its run from the invocation,
// runs to completion, closes its own run with view.run.end(). No knowledge of
// the parent relationship — just another run on the session.
```

---

# Design rationale

## Principles applied

**Session as root object (callers should not need to understand internals)**: The session is the single entry point. Developers don't need to understand the relationship between channels, trees, codecs, and streams. They create a session and work with views and runs.

**Separate client/agent sessions (types are documentation)**: The type system prevents misuse. A client session can't publish `x-ably-step-start`. An agent session can't send user messages through a view. The types make illegal states unrepresentable.

**Symmetric session → view → write-handle hierarchy**: Both sides instantiate a session, derive a view from it, and create a write handle from the view. `session.createView()` mirrors `session.createView(invocation)`. `view.createRun()` mirrors `view.createStep()`. `run.start()` mirrors `step.start()`. A developer who learns one side already knows the shape of the other. The client's view has mutable branch selection because the user drives it; the agent's view is pinned because the invocation already named the branch — same abstraction, role-appropriate policy.

**View as write-handle factory (composition over configuration)**: The view creates the write handle because it holds the branch context needed to position it. On the client, `view.createRun()` appends to the current branch tip and `view.createRegenerate()` forks at a node (auto-selecting the new branch by default); on the agent, `view.createStep()` produces a step that executes the view's run (multiple steps per view permitted — each publishes its own step-start/step-end pair).

**Low-level verbs are safe without helpers**: `session.writer`, `view.createStep`, `run.start/sendMessages/sendEvents`, and agent `run.end/suspend` cover every worked-example scenario. Only two helpers survived scrutiny — `run.when(statuses)` and control signals returning `Invocation` — because both collapse real multi-step orchestration into one call. Higher-level wrappers like `runStep`, `handleInvocation`, `view.send`, `view.continueRun`, `view.spawnChildRun`, and `view.activeRun` were considered and dropped for partial coverage.

**Uniform send surface**: Send methods are named identically wherever they appear — `Step.sendMessages` / `Step.sendEvents`, `SessionWriter.sendMessages` / `SessionWriter.sendEvents`, `ClientRun.sendMessages` / `ClientRun.sendEvents`. Each accepts a single value or an array, and each splits messages (codec `writeMessages`) from discrete events (codec `writeEvent`). `view.send*` is deliberately absent — views are read projections; write via `view.createRun()` → `run.sendMessages(...)`.

**Explicit hydration via view.messages**: The agent gets the linear conversation through `view.messages.map(n => n.message)` — the projection is visible at the call site, not hidden behind a convenience property.

**Invocation as primitive (one obvious way to do each thing)**: Every operation that needs an agent produces an invocation. Construct one from wire data via `Invocation.fromJSON(data)`; snapshot one from a live run via `run.toInvocation()`. Control signals (`abort`, `pause`, `resume`, `retry`) return the `Invocation` targeting the run so every call site follows the same two-step "publish, then optionally POST" pattern.

**Signal fold — one abort observation point**: `step.signal` is aborted when an `x-ably-run-abort` lands on the channel OR when a caller-supplied signal fires (via `step.start({ signal })`). The agent wires a single `abortSignal: step.signal` into the model SDK; no `AbortSignal.any` boilerplate at the call site for the common case. The SDK never introspects `req.signal` or WDK signals — it composes only what the caller hands it.

**Pessimistic step disposer — no silent success, no fabricated channel state**: `Step[Symbol.asyncDispose]` publishes a terminal `x-ably-step-end` only when the step is `'active'` — `'aborted'` if `step.signal.aborted`, otherwise `'failed'` with cause `ErrorCode.StepDisposedBeforeEnd` (`104021`). A `'pending'` step (one where `start()` never resolved) disposes as a no-op so the channel never sees a step-end without its step-start. Terminal steps dispose as pure cleanup. The disposer is a safety net for thrown errors, never a replacement for explicit `step.end('complete')`.

**Two subscription patterns (tree vs view)**: The tree uses `on`/`off` for granular, typed events because each event type has a distinct signature. The view uses `subscribe`/unsubscribe for state-oriented observation because the consumer doesn't need to know what changed, just that it did.

## Trade-offs accepted

**Two session types instead of one**: Two types to learn. Accepted because the alternatives (one type with runtime errors, or conditional types) are worse.

**Views must be explicitly created**: No default view means one extra call for the common case. Accepted because implicit defaults create "is it special?" questions and lifecycle ambiguity.

**Raw session methods alongside view methods**: The session exposes granular write methods that most developers never call directly. These exist for server-side validation, subagent fan-out, and advanced orchestration. They are the primitives that view methods compose — not an alternative path.

**No automatic non-complete step filtering**: Developers must check `node.step.status` themselves. Accepted because automatic filtering hides information and makes debugging harder.

**Agent lifecycle is manual**: The agent must call `step.end()` then `view.run.end()` in sequence. Missing either leaves state on the channel. Accepted because the agent controls the semantics (a step can end `complete` while the run stays open for a next step); the pessimistic step disposer catches thrown errors.

**Extra object on the agent side**: The agent creates both a view and a step rather than a single `createStep(invocation)` object. Two-line overhead versus one. Accepted because the extra line buys structural symmetry with the client and makes the hydration mechanism (`view.messages.map(n => n.message)`) legible at the call site.

**Abort cascade is the invoker's responsibility**: The SDK does not track parent-child run relationships. The invoker must cascade abort to child runs manually. Accepted per the RFC design — the SDK provides the primitives (run.end, step.signal, session.writer.abort), the orchestrator composes them.
