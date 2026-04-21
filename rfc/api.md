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

function createInvocation(data: InvocationData): Invocation;
```

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
   * The session name. Today this is used as the name of the single channel
   * backing the session; in future a session may span multiple channels and
   * the SDK will derive those channel names from this value.
   */
  name: string;

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
  readonly name: string;

  /** The unfiltered conversation tree. Available before connect(). */
  readonly tree: Tree<TMessage, ClientRun<TMessage>>;

  /**
   * Create a projected view over the tree. Each view has independent branch
   * selection and pagination. Views can be created before or after connect().
   * Call view.close() to release a view when it's no longer needed.
   */
  createView(options?: CreateViewOptions): ClientView<TMessage>;

  /**
   * Hydrate from the storage reader (if provided) and subscribe to the channel
   * for live events. Resolves when hydration is complete and the live
   * subscription is active.
   */
  connect(): Promise<void>;

  /**
   * Unsubscribe from the channel and tear down the tree and all views.
   */
  close(): Promise<void>;

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
   * internally. Exposed for server-side validation handlers, orchestrators,
   * and advanced patterns that need explicit control.
   *
   * Can be used without connect() — publishes directly to the channel.
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
   * Publish one or more complete domain messages to the channel.
   * Encoded via the codec's writeMessages path. Use for user messages,
   * tool results, and other discrete complete messages.
   */
  sendMessages(options: SendMessagesOptions<TMessage>): Promise<SendResult>;

  /**
   * Publish one or more discrete domain events to the channel.
   * Encoded via the codec's writeEvent path. Use for standalone events
   * like data-* that are not complete messages.
   */
  sendEvents(options: SendEventsOptions<TEvent>): Promise<SendResult>;

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
  runId: string;
  reason: SuspendReason;
}

interface EndRunOptions {
  runId: string;
  status: RunEndStatus;
}

interface StartStepOptions {
  runId: string;
}

interface StartStepResult {
  /** The generated step ID. */
  stepId: string;
}

interface EndStepOptions {
  runId: string;
  stepId: string;
  status: StepEndStatus;
}

interface AbortOptions {
  runId: string;
}

interface PauseOptions {
  runId: string;
}

interface ResumeOptions {
  runId: string;
  /** Target a specific step for checkpoint-based resumption. */
  stepId?: string;
  /** Message the agent must observe before starting (e.g. HITL approval). */
  messageId?: string;
}

interface RetryOptions {
  runId: string;
  /** Target a specific step for step-level retry. */
  stepId?: string;
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

interface SendResult {
  /** The IDs assigned to the published messages, in order. */
  messageIds: string[];
}
```

## AgentSession

```ts
interface AgentSession<TEvent, TMessage> {
  /** The session name, as passed to createAgentSession. */
  readonly name: string;

  /**
   * The unfiltered conversation tree. Available as an escape hatch for
   * advanced cases. Most agents read the conversation through the step.
   */
  readonly tree: Tree<TMessage, AgentRun<TMessage>>;

  /**
   * Create a view scoped to the run an invocation names. The view's branch
   * selection is pinned by the invocation's run ID — it shows the linear
   * conversation the run sits on (ancestry from root plus the run's own
   * messages). Call view.createStep() to produce the step that executes
   * the run.
   */
  createView(invocation: Invocation): AgentView<TEvent, TMessage>;

  /**
   * Hydrate from the storage reader (if provided) and subscribe to the channel
   * for live events. Resolves when hydration is complete and the live
   * subscription is active.
   */
  connect(): Promise<void>;

  /**
   * Unsubscribe from the channel and tear down the session.
   */
  close(): Promise<void>;

  [Symbol.asyncDispose](): Promise<void>;

  /**
   * Fires when the session encounters an unrecoverable error — channel
   * detach, failed state, or storage reader/writer failure.
   */
  on(event: 'error', handler: (error: Ably.ErrorInfo) => void): void;
  off(event: 'error', handler: (error: Ably.ErrorInfo) => void): void;

  /**
   * Low-level write surface. Steps delegate to this internally. Exposed for
   * orchestrators and advanced patterns (e.g. subagent fan-out).
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

  on(event: 'message-added', handler: (node: MessageNode<TMessage, TRun>) => void): void;
  on(event: 'message-updated', handler: (node: MessageNode<TMessage, TRun>) => void): void;
  on(event: 'run-started', handler: (run: TRun) => void): void;
  on(event: 'run-updated', handler: (run: TRun) => void): void;
  on(event: 'run-ended', handler: (run: TRun) => void): void;
  on(event: 'step-started', handler: (step: StepState, run: TRun) => void): void;
  on(event: 'step-updated', handler: (step: StepState, run: TRun) => void): void;
  on(event: 'step-ended', handler: (step: StepState, run: TRun) => void): void;

  off(event: 'message-added', handler: (node: MessageNode<TMessage, TRun>) => void): void;
  off(event: 'message-updated', handler: (node: MessageNode<TMessage, TRun>) => void): void;
  off(event: 'run-started', handler: (run: TRun) => void): void;
  off(event: 'run-updated', handler: (run: TRun) => void): void;
  off(event: 'run-ended', handler: (run: TRun) => void): void;
  off(event: 'step-started', handler: (step: StepState, run: TRun) => void): void;
  off(event: 'step-updated', handler: (step: StepState, run: TRun) => void): void;
  off(event: 'step-ended', handler: (step: StepState, run: TRun) => void): void;
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
   * controls (e.g. `node.run?.abort()`, `node.run?.send(...)`) are directly
   * callable from the rendered node.
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
   */
  close(): void;
}

/**
 * Read projection scoped to the client's UI perspective. Branch selection is
 * mutable — the user drives it via select() and loadMore(). Factory for new
 * runs: createRun, createRegenerate, and createEdit all produce a ClientRun
 * positioned by the view's current branch state.
 */
interface ClientView<TMessage> extends View<TMessage, ClientRun<TMessage>> {
  /** Runs whose messages are visible in this view's projection. */
  readonly runs: ReadonlyArray<ClientRun<TMessage>>;

  /** Whether more history is available to load. */
  readonly hasMore: boolean;

  /** Load more history into the view. */
  loadMore(): Promise<void>;

  /**
   * Select a sibling at a branch point, switching which branch this view shows.
   * The messageId must identify an existing node in the tree.
   */
  select(messageId: string): void;

  // --- Run creation (branch-context-aware) ---

  /**
   * Create a new run, positioned at the current branch tip. The run is not
   * yet live — call run.start() to publish `x-ably-run-start` to the channel.
   */
  createRun(): ClientRun<TMessage>;

  /**
   * Create a new run that forks the tree at the given message (regenerate).
   * The original response is preserved alongside the new branch. The run is
   * not yet live — call run.start() to publish `x-ably-run-start`.
   */
  createRegenerate(messageId: string): ClientRun<TMessage>;

  /**
   * Create a new run that forks the tree at the given message (edit).
   * The conversation branches from the edit point. The run is not yet live —
   * call run.start() to publish `x-ably-run-start`.
   */
  createEdit(messageId: string): ClientRun<TMessage>;
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
   * Create the step that executes this view's run. The step is not yet
   * active — call step.start() to wait for the invocation's preconditions
   * and publish `x-ably-step-start`. The gap between createStep and start is
   * the setup window for registering signal handlers (e.g. step.on('pause', ...)).
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
   * `ClientRun<TMessage>` when this node comes from a ClientSession's tree
   * or view, `AgentRun<TMessage>` when it comes from an AgentSession. So
   * `node.run?.abort()`, `node.run?.send(...)`, etc. are directly callable
   * from the rendered node — no need to look up by ID through `view.runs`.
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
}

/** Run as seen from a ClientSession. Adds lifecycle and control methods. */
interface ClientRun<TMessage> extends Run<TMessage> {
  /** Messages belonging to this run, with node.run typed as ClientRun. */
  readonly messages: ReadonlyArray<MessageNode<TMessage, ClientRun<TMessage>>>;

  // --- Lifecycle ---

  /**
   * Publish `x-ably-run-start` to the channel. Call after creating the run
   * via view.createRun/createRegenerate/createEdit and before sending content.
   */
  start(): Promise<void>;

  // --- Content ---

  /**
   * Send a message to this run. The message is published to the channel
   * tagged with this run's ID. Used for the initial user message (after
   * start) and for mid-run steering.
   * Does not require an agent to be running — the message is durable.
   */
  send(message: TMessage): Promise<void>;

  // --- Control signals ---

  /**
   * Abort this run. Publishes an abort control signal to the channel.
   * The agent observes it and closes the run terminally.
   * Does not require an agent to be running — the signal is durable.
   */
  abort(): Promise<void>;

  /**
   * Pause this run. Publishes a pause control signal to the channel.
   * The agent finishes or interrupts its current step and suspends the run.
   */
  pause(): Promise<void>;

  /**
   * Resume this suspended run. Publishes a resume control signal.
   * Optionally targets a specific step for checkpoint-based resumption.
   */
  resume(options?: { stepId?: string }): Promise<void>;

  /**
   * Retry this failed or abandoned run. Publishes a retry control signal.
   * Optionally targets a specific step for step-level retry.
   */
  retry(options?: { stepId?: string }): Promise<void>;

  // --- Invocation ---

  /**
   * Create an invocation from this run's current state. The invocation
   * carries the session name, run ID, and the message ID of the last
   * message sent via run.send() as a precondition.
   *
   * Call after start() and send() to create the invocation the developer
   * delivers to an agent endpoint.
   */
  createInvocation(): Invocation;
}

/** Run as seen from an AgentSession. Adds agent lifecycle methods. */
interface AgentRun<TMessage> extends Run<TMessage> {
  /** Messages belonging to this run, with node.run typed as AgentRun. */
  readonly messages: ReadonlyArray<MessageNode<TMessage, AgentRun<TMessage>>>;

  /**
   * Suspend this run without closing it. Published by the agent when the
   * current step's work requires external input before continuing, or in
   * response to a pause signal.
   */
  suspend(reason: SuspendReason): Promise<void>;

  /**
   * Close this run terminally. Published by the agent when the task
   * completes, is aborted, or fails beyond recovery.
   */
  end(status: RunEndStatus): Promise<void>;
}
```

## Steps

```ts
/** Terminal status for a step. */
type StepEndStatus = 'complete' | 'failed' | 'aborted' | 'paused' | 'superseded';

/** All possible step statuses including non-terminal states. */
type StepStatus = StepEndStatus | 'active' | 'abandoned';

/** Readable step state in the materialised tree. */
interface StepState {
  readonly id: string;
  readonly runId: string;
  readonly status: StepStatus;
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
   * AbortSignal that fires when an abort control signal is observed for
   * this step's run. Wire this into model SDKs, fetch calls, and streams
   * that accept AbortSignal.
   *
   * If the run was aborted before this step started (e.g. during the gap
   * between a crash and a retry), the signal is already aborted when
   * start() resolves. Always check signal.aborted after start() returns.
   */
  readonly signal: AbortSignal;

  /**
   * Wait for all preconditions declared in the view's invocation to be
   * visible in the session, then publish `x-ably-step-start` to the channel.
   * Resolves when the step is active and the view's messages are complete.
   *
   * If a pre-existing abort signal is found in the session (published while
   * no agent was running), signal.aborted will be true after start() resolves.
   * If a pre-existing pause signal is found, the 'pause' handler fires
   * immediately after start() resolves.
   *
   * Rejects if the step is superseded (another `x-ably-step-start` with an
   * earlier serial was observed for the same run). The rejection is an
   * Ably.ErrorInfo with a distinguishable error code.
   */
  start(): Promise<void>;

  /**
   * Publish `x-ably-step-end` with the given status and release step
   * resources (signal listeners, stream references).
   */
  end(status: StepEndStatus): Promise<void>;

  [Symbol.asyncDispose](): Promise<void>;

  /**
   * Register a handler for a pause signal observed on the channel.
   * The agent can checkpoint state and end the step with 'paused', or
   * let the current work complete and end with 'complete'.
   *
   * If a pause signal was already published before this step started,
   * the handler fires immediately after start() resolves.
   */
  on(event: 'pause', handler: () => void): void;

  off(event: 'pause', handler: () => void): void;

  /**
   * Pipe a readable stream through the codec encoder to the channel.
   * Each chunk is encoded and published as it arrives. The step's abort
   * signal is wired in automatically — if the run is aborted mid-pipe,
   * the stream is cancelled.
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
   * Encoded via the codec's writeEvent path. Use for standalone events
   * like data-* that are not complete messages.
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

Minimal send/stream/receive across a durable session. Shows the full lifecycle: session setup, view creation, run start, sending the user message, invoking the agent, and piping the model stream through a step. This is the baseline; later examples elide setup back to this.

```ts
// --- client ---
import * as Ably from 'ably';
import { createClientSession, createInvocation } from '@ably/ai-transport';
import { UIMessageCodec } from '@ably/ai-transport/vercel';
import type * as AI from 'ai';
import type { InvocationData } from '@ably/ai-transport';

const ably = new Ably.Realtime({ authUrl: '/api/ably-token' });
const codec = new UIMessageCodec();

const session = createClientSession<AI.UIMessageChunk, AI.UIMessage>({
  client: ably,
  name: 'session:abc123',
  codec,
});
await session.connect();

const view = session.createView();
view.subscribe(() => {
  // UI reads view.messages and renders them
});

async function invokeAgent(data: InvocationData) {
  await fetch('/api/agent', { method: 'POST', body: JSON.stringify(data) });
}

async function onSendClick(text: string) {
  const run = view.createRun();
  await run.start();
  await run.send({ id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] });
  await invokeAgent(run.createInvocation().toJSON());
}
```

```ts
// --- agent ---
import * as Ably from 'ably';
import { createAgentSession, createInvocation } from '@ably/ai-transport';
import { UIMessageCodec } from '@ably/ai-transport/vercel';
import { streamText } from 'ai';
import { openai } from '@ai-sdk/openai';
import type { InvocationData } from '@ably/ai-transport';

export async function POST(req: Request) {
  const data = (await req.json()) as InvocationData;
  const invocation = createInvocation(data);

  const ably = new Ably.Realtime({ key: process.env.ABLY_KEY! });

  await using session = createAgentSession<AI.UIMessageChunk, AI.UIMessage>({
    client: ably,
    name: invocation.sessionName,
    codec: new UIMessageCodec(),
  });
  await session.connect();

  const view = session.createView(invocation);
  await using step = view.createStep();
  await step.start();

  const result = streamText({
    model: openai('gpt-4o'),
    messages: view.messages.map((n) => n.message),
    abortSignal: step.signal,
  });
  await step.pipe(result.toUIMessageStream());

  await step.end('complete');
  await view.run.end('complete');
  return new Response(null, { status: 202 });
}
```

## Example 2: Aborting a response

Abort is durable state on the session: the client publishes an abort signal, and the agent's `step.signal` fires whether the agent was live or not. Solves **aborts don't work when a task outlives a single continuous agent execution** — the signal sits on the channel until a step observes it.

```ts
// --- client ---
// ...session and view setup as in Example 1
import type { MessageNode } from '@ably/ai-transport';

// Global stop button — aborts the currently active run in a single-conversation UI.
async function onStopClick() {
  const activeRun = view.runs.find((r) => r.status === 'active');
  if (activeRun) await activeRun.abort();
}

// Per-message variant — when the UI renders a stop button on a specific response,
// the handler takes the node the user clicked and aborts THAT node's run directly.
// Use this for multi-run sessions, or when the UI shows distinct conversations side by side.
async function onStopNode(node: MessageNode<AI.UIMessage>) {
  if (node.run?.status === 'active') await node.run.abort();
}
```

```ts
// --- agent ---
// ...agent POST handler as in Example 1, with this body:
await using step = view.createStep();
await step.start();

// If a prior abort was already on the channel, step.signal is already aborted.
if (step.signal.aborted) {
  await step.end('aborted');
  await view.run.end('aborted');
  return new Response(null, { status: 202 });
}

const result = streamText({
  model: openai('gpt-4o'),
  messages: view.messages.map((n) => n.message),
  abortSignal: step.signal, // wires abort directly into the model SDK
});

try {
  await step.pipe(result.toUIMessageStream());
  await step.end('complete');
  await view.run.end('complete');
} catch {
  await step.end('aborted');
  await view.run.end('aborted');
}
```

Pause follows the same durable-state pattern. On the client, `activeRun.pause()` publishes a pause signal. On the agent, the step exposes it as an event:

```ts
// --- agent, inside the POST handler after createStep() ---
step.on('pause', async () => {
  // Interrupt now, or let the current stream finish and end 'complete' naturally.
  await step.end('paused');
  await view.run.suspend('paused');
});
```

## Example 3: Steering a running agent

A user sends a follow-up while the agent is still responding. The agent's `view.messages` updates live because the view subscribes to the tree, so the next iteration of the agent loop sees the new input. Solves **no live control of a running agent** — no cancel-and-restart, the in-progress work survives.

```ts
// --- client ---
// ...session and view setup as in Example 1
import type { MessageNode } from '@ably/ai-transport';

// User types a follow-up while the previous response is still streaming.
// Single-conversation UI: steer the one active run.
async function onSteerClick(text: string) {
  const activeRun = view.runs.find((r) => r.status === 'active');
  if (!activeRun) return;
  await activeRun.send({
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text }],
  });
}

// Per-message variant — e.g. the UI shows a "reply here" affordance on a specific
// assistant response. The handler targets THAT node's run.
async function onSteerAtNode(node: MessageNode<AI.UIMessage>, text: string) {
  if (node.run?.status !== 'active') return;
  await node.run.send({
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text }],
  });
}
```

```ts
// --- agent ---
// ...agent setup as in Example 1

await using step = view.createStep();
await step.start();

// Loop until no new user input arrives between iterations.
// Track the tail user message id — robust to the agent's own messages being appended during pipe.
const latestUserId = () => view.messages.findLast((n) => n.message.role === 'user')?.id;
let lastUserId = latestUserId();
while (!step.signal.aborted) {
  const result = streamText({
    model: openai('gpt-4o'),
    messages: view.messages.map((n) => n.message),
    abortSignal: step.signal,
  });
  await step.pipe(result.toUIMessageStream());

  const currentUserId = latestUserId();
  if (currentUserId === lastUserId) break;
  lastUserId = currentUserId;
}

await step.end('complete');
await view.run.end('complete');
```

## Example 4: HITL tool approval

The agent proposes a tool call, suspends the run pending approval, and a later invocation (with a `messageId` precondition) picks up after the client publishes the approval. Solves **turns can't be suspended** — a run spans multiple agent executions separated by `x-ably-run-suspend`.

```ts
// --- client ---
// ...session and view setup as in Example 1
import type { MessageNode } from '@ably/ai-transport';

// UI renders view.messages. When a node's domain message contains a tool-call
// part on a suspended run, the UI renders an approve/deny prompt for that
// specific node and passes it to the handler. The run is read straight off
// the node — no lookup by ID.
async function onApprove(toolCallNode: MessageNode<AI.UIMessage>, approved: boolean) {
  const run = toolCallNode.run;
  if (!run || run.status !== 'suspended') return;

  const approvalMessageId = crypto.randomUUID();
  await run.send({
    id: approvalMessageId,
    role: 'user',
    parts: [{ type: 'text', text: approved ? 'approved' : 'denied' }],
  });
  // Resume with the approval message as precondition — the agent waits for it
  // to be visible before starting, so the conversation it reads includes the approval.
  await invokeAgent({
    sessionName: session.name,
    runId: run.id,
    messageId: approvalMessageId,
  });
}
```

```ts
// --- agent ---
// ...agent setup as in Example 1

await using step = view.createStep();
await step.start();

const result = streamText({
  model: openai('gpt-4o'),
  messages: view.messages.map((n) => n.message),
  tools: {
    deleteFile: {
      /* ... */
    },
  },
  abortSignal: step.signal,
});
await step.pipe(result.toUIMessageStream());
await step.end('complete');

// Did the model request a tool? Suspend the run until the user approves.
const last = view.messages[view.messages.length - 1].message;
const proposedTool = last.parts.find((p) => p.type.startsWith('tool-'));
if (proposedTool) {
  await view.run.suspend('awaiting-input');
} else {
  await view.run.end('complete');
}
return new Response(null, { status: 202 });
```

## Example 5: Regenerating a response

`view.createRegenerate(messageId)` forks the tree. The original response is preserved alongside the new branch; `view.select` switches which sibling is shown. Solves the **conversation branching** side of the tree abstraction — multiple runs coexist on the same parent.

```ts
// --- client ---
// ...session and view setup as in Example 1

async function onRegenerateClick(assistantMessageId: string) {
  const run = view.createRegenerate(assistantMessageId);
  await run.start();
  await invokeAgent(run.createInvocation().toJSON());
}

async function onSelectBranchClick(messageId: string) {
  view.select(messageId); // view.messages now reflects the selected sibling
}

// UI reads view.messages; for each node, parentId + session.tree.getMessage(parentId).children.length
// tells it whether siblings exist so it can show branch-switcher controls.
view.subscribe(() => {
  // UI reads view.messages and sibling counts via session.tree
});
```

```ts
// --- agent ---
// Agent code is unchanged from Example 1. The run carries the forked parentId;
// the agent reads view.messages, which already reflects the correct branch.
```

## Example 6: Multi-device continuity

Two clients open the same session (same session name). Both hydrate from channel history, see identical state, and either device can abort a running run. Solves **multi-device continuity** — the session follows the user, not the connection.

```ts
// --- phone ---
// ...session setup as in Example 1, using session name 'session:abc123'

// User starts a long-running research task, then puts the phone down.
const run = view.createRun();
await run.start();
await run.send({ id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: '...' }] });
await invokeAgent(run.createInvocation().toJSON());
```

```ts
// --- laptop (opened minutes later, same session:abc123) ---
const session = createClientSession<AI.UIMessageChunk, AI.UIMessage>({
  client: ably,
  name: 'session:abc123',
  codec,
});
await session.connect(); // Hydrates from channel history

const view = session.createView();
view.subscribe(() => {
  // UI reads view.messages and view.runs
});

// The in-flight run is visible in view.runs. The user can abort from here —
// either globally (pattern below) or by rendering a stop button on a specific
// message and calling node.run?.abort() directly, as in Example 2's
// per-message variant.
async function onStopClick() {
  const active = view.runs.find((r) => r.status === 'active');
  if (active) await active.abort();
}
```

## Example 7: Retry after failure

A step ends `failed`. The client observes it and calls `run.retry()`; a fresh invocation starts a new step with a new step ID. Total order by serial resolves any race. Solves **retrying an agent produces competing outputs with no canonical winner** — steps are ID'd per attempt, non-complete output is identifiable.

```ts
// --- client ---
// ...session and view setup as in Example 1

session.tree.on('step-ended', async (step, run) => {
  if (step.status !== 'failed') return;
  await run.retry({ stepId: step.id });
  await invokeAgent({ sessionName: session.name, runId: run.id, stepId: step.id });
});
```

```ts
// --- agent ---
// ...agent setup as in Example 1

await using step = view.createStep();
try {
  await step.start();
  const result = streamText({
    model: openai('gpt-4o'),
    messages: view.messages.map((n) => n.message),
    abortSignal: step.signal,
  });
  await step.pipe(result.toUIMessageStream());
  await step.end('complete');
  await view.run.end('complete');
} catch (err) {
  // If step.start() rejected because a winning concurrent step exists,
  // the step was already marked superseded. Otherwise: mark the attempt
  // as failed so the retry signal has something to target.
  await step.end('failed');
}
```

## Example 8: Server-side input validation

The client POSTs the user's input to the backend instead of publishing directly. The route validates, then uses `session.writer` (without `connect()`) to publish `x-ably-run-start` and the user message on the client's behalf. Solves **the user's message is published by the server, not the client** by making server-side publish an explicit, deliberate pattern rather than the default, and **hydration is available only to the client, and only from the channel** by giving the server the same session primitives.

```ts
// --- client ---
// ...session and view setup as in Example 1

async function onSendClick(text: string): Promise<{ ok: boolean; reason?: string }> {
  const res = await fetch('/api/validate-and-send', {
    method: 'POST',
    body: JSON.stringify({ sessionName: session.name, text }),
    // The request is authenticated however the app authenticates users
    // (cookies, bearer tokens, etc.); the backend uses that identity to set
    // x-ably-client-id on the publish.
  });
  if (!res.ok) return { ok: false, reason: 'input rejected' };
  const invocationData = (await res.json()) as InvocationData;
  await invokeAgent(invocationData);
  return { ok: true };
}
```

```ts
// --- server route (validation + publish on behalf of client) ---
export async function POST(req: Request): Promise<Response> {
  const { sessionName, text } = (await req.json()) as { sessionName: string; text: string };
  if (!passesModeration(text)) return new Response('rejected', { status: 400 });

  const userClientId = getAuthenticatedUserClientId(req); // app-specific auth
  const ably = new Ably.Realtime({ key: process.env.ABLY_KEY! });
  const session = createClientSession<AI.UIMessageChunk, AI.UIMessage>({
    client: ably,
    name: sessionName,
    codec: new UIMessageCodec(),
  });
  // Note: no connect() — writer publishes directly to the channel.

  // Pass clientId so x-ably-client-id on x-ably-run-start and the user
  // message attributes both to the end-user rather than to this backend
  // connection.
  const { runId } = await session.writer.startRun({ clientId: userClientId });
  const { messageIds } = await session.writer.sendMessages({
    runId,
    clientId: userClientId,
    messages: { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] },
  });

  const data: InvocationData = { sessionName, runId, messageId: messageIds[0] };
  return Response.json(data);
}
```

## Example 9: Durable execution (Vercel Workflow DevKit)

One run spans multiple durable-execution stages, each one a distinct step. The framework re-drives a failed stage; each retry opens a new `x-ably-step-start`, and prior attempts are marked superseded or abandoned — no phantom output. Solves **durable-execution workflows fragment into disconnected turns** and the **hydration from external state** gap: a `storageReader` backed by the workflow's framework state materialises the session on each stage boundary.

```ts
// --- durable workflow (one run, one step per stage) ---
import { createWorkflow, step as workflowStep } from '@vercel/workflow';
import { streamText } from 'ai';
import type { Step, AgentView, Invocation } from '@ably/ai-transport';

async function runStep<T>(
  invocation: Invocation,
  fn: (step: Step<AI.UIMessageChunk, AI.UIMessage>, view: AgentView<AI.UIMessageChunk, AI.UIMessage>) => Promise<T>,
): Promise<T> {
  await using session = createAgentSession<AI.UIMessageChunk, AI.UIMessage>({
    client: ably,
    name: invocation.sessionName,
    codec: new UIMessageCodec(),
    storageReader: workflowStateReader(invocation.runId), // hydrate from framework state, not channel history
  });
  await session.connect();
  const view = session.createView(invocation);
  await using step = view.createStep();
  await step.start();
  return fn(step, view);
}

export const researchWorkflow = createWorkflow(async (invocation: InvocationData) => {
  const inv = createInvocation(invocation);

  // Stage 1: plan. Fails -> framework retries this stage; a new x-ably-step-start supersedes the old.
  const plan = await workflowStep.do('plan', () =>
    runStep(inv, async (step, view) => {
      const result = streamText({
        model: openai('gpt-4o'),
        messages: view.messages.map((n) => n.message),
        abortSignal: step.signal,
      });
      await step.pipe(result.toUIMessageStream());
      await step.end('complete');
      return extractPlan(view.messages);
    }),
  );

  // Stage 2: execute. A fresh step within the same run, reading the plan from the session.
  await workflowStep.do('execute', () =>
    runStep(inv, async (step, view) => {
      const result = streamText({
        model: openai('gpt-4o'),
        messages: view.messages.map((n) => n.message),
        abortSignal: step.signal,
      });
      await step.pipe(result.toUIMessageStream());
      await step.end('complete');
      await view.run.end('complete');
    }),
  );
});
```

## Example 10: Subagent fan-out

A parent agent spawns concurrent child runs by opening new runs via `session.writer.startRun` and POSTing to the subagent endpoint. When the parent's step is aborted, `step.signal` cascades via `session.writer.abort` to each child run. Solves the **unit of concurrency within a session** shortfall — multiple runs coexist, and parent-child abort cascade is explicit.

```ts
// --- parent agent ---
// ...agent setup as in Example 1

await using step = view.createStep();
await step.start();

// Plan subtasks from the user's input, then fan out one run per subtask.
const subtasks = planSubtasks(view.messages.map((n) => n.message));
const childRunIds: string[] = [];

for (const subtask of subtasks) {
  const { runId } = await session.writer.startRun({});
  await session.writer.sendMessages({
    runId,
    messages: { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: subtask }] },
  });
  childRunIds.push(runId);
  // Fire-and-forget: subagents run in parallel. Errors surface on the channel as x-ably-run-end with status: failed.
  void fetch('/api/subagent', {
    method: 'POST',
    body: JSON.stringify({ sessionName: session.name, runId }),
  });
}

// Cascade abort: parent aborted -> abort every child run too.
step.signal.addEventListener('abort', () => {
  for (const runId of childRunIds) void session.writer.abort({ runId });
});

// Wait for every child run to terminate, then summarise and close.
await Promise.all(childRunIds.map((id) => waitForRunEnd(session, id)));
await step.end(step.signal.aborted ? 'aborted' : 'complete');
await view.run.end(step.signal.aborted ? 'aborted' : 'complete');
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

**View as write-handle factory (composition over configuration)**: The view creates the write handle because it holds the branch context needed to position it. On the client, `view.createRun()` appends to the current branch tip and `view.createRegenerate()` forks at a node; on the agent, `view.createStep()` produces the step that executes the view's run. The returned handle is the developer's primary interface for doing work on that run. For reconnection and multi-device, `ClientView.runs` provides discovery of existing runs; on the agent, `AgentView.run` exposes the single run the invocation named.

**Explicit hydration via view.messages**: The agent gets the linear conversation through `view.messages.map(n => n.message)` — the projection is visible at the call site, not hidden behind a convenience property. This makes "where does the conversation come from?" answerable from the code itself: the view is scoped by the invocation, it projects the tree along the run's ancestry, and the developer passes the result to the model. No "scoped to the run" ambiguity.

**Invocation as primitive (one obvious way to do each thing)**: Every operation that needs an agent returns an invocation. Every agent entry point consumes one. There's one bridge between client and agent, and it's typed.

**AbortSignal (composition over configuration)**: The platform primitive composes with every model SDK, fetch call, and stream. No custom cancellation API to learn. Pre-existing signals (abort published while no agent was running) are reflected in the signal's state after `start()`, so the same check (`signal.aborted`) works for both live and historical abort.

**Two subscription patterns (tree vs view)**: The tree uses `on`/`off` for granular, typed events because each event type has a distinct signature. The view uses `subscribe`/unsubscribe for state-oriented observation because the consumer doesn't need to know what changed, just that it did. These serve different purposes — tree events are for event processing (debug panels, telemetry), view subscriptions are for re-rendering (UI, React hooks).

## Trade-offs accepted

**Two session types instead of one**: Two types to learn. Accepted because the alternatives (one type with runtime errors, or conditional types) are worse.

**Views must be explicitly created**: No default view means one extra call for the common case. Accepted because implicit defaults create "is it special?" questions and lifecycle ambiguity.

**Raw session methods alongside view methods**: The session exposes granular write methods that most developers never call directly. These exist for server-side validation, subagent fan-out, and advanced orchestration. They are the primitives that view methods compose — not an alternative path. Documented as low-level.

**No automatic non-complete step filtering**: Developers must check `node.step.status` themselves. Accepted because automatic filtering hides information and makes debugging harder. The rendering code is straightforward.

**Agent lifecycle is manual**: The agent must call `step.end()` then `view.run.end()` in sequence. Missing either leaves state on the channel. Accepted because the agent controls the semantics (a step can end `complete` while the run stays open for a next step). The `Disposable` protocol on `Step` and a `runStep` helper pattern (shown in the durable-execution example) reduce the risk of resource leaks.

**Extra object on the agent side**: The agent creates both a view and a step rather than a single `createStep(invocation)` object. Two-line overhead versus one. Accepted because the extra line buys structural symmetry with the client and makes the hydration mechanism (`view.messages.map(n => n.message)`) legible at the call site — which is the concern that surfaced the asymmetry in the first place.

**Abort cascade is the invoker's responsibility**: The SDK does not track parent-child run relationships. The invoker must cascade abort to child runs manually. Accepted per the RFC design — the SDK provides the primitives (run.end, step.signal), the orchestrator composes them.
