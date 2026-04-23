import type { RunEndStatus, SuspendReason } from './run.js';
import type { StepEndStatus } from './step.js';

/** Options for opening a new run via {@link SessionWriter.startRun}. */
export interface StartRunOptions {
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

/** Result of {@link SessionWriter.startRun}. */
export interface StartRunResult {
  /** The generated run ID. */
  runId: string;
}

/** Options for {@link SessionWriter.suspendRun}. */
export interface SuspendRunOptions {
  /** The run to suspend. */
  runId: string;
  /** Why the run is being suspended. */
  reason: SuspendReason;
}

/** Options for {@link SessionWriter.endRun}. */
export interface EndRunOptions {
  /** The run to end. */
  runId: string;
  /** Terminal status to record on `x-ably-run-end`. */
  status: RunEndStatus;
}

/** Options for {@link SessionWriter.startStep}. */
export interface StartStepOptions {
  /** The run the new step belongs to. */
  runId: string;
}

/** Result of {@link SessionWriter.startStep}. */
export interface StartStepResult {
  /** The generated step ID. */
  stepId: string;
}

/** Options for {@link SessionWriter.endStep}. */
export interface EndStepOptions {
  /** The run the step belongs to. */
  runId: string;
  /** The step to end. */
  stepId: string;
  /** Terminal status to record on `x-ably-step-end`. */
  status: StepEndStatus;
}

/** Options for publishing one or more complete domain messages via {@link SessionWriter.sendMessages}. */
export interface SendMessagesOptions<TMessage> {
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

/** Options for publishing one or more discrete domain parts via {@link SessionWriter.sendParts}. */
export interface SendPartsOptions<TPart> {
  /** One or more domain parts to encode and publish. */
  parts: TPart | TPart[];
  /** The run these parts belong to. */
  runId: string;
  /** Parent message ID for tree positioning. */
  parentId?: string;

  /**
   * Override the attribution clientId sent as `x-ably-client-id`. See
   * SendMessagesOptions.clientId.
   */
  clientId?: string;
}

/** Options for {@link SessionWriter.abort}. */
export interface AbortOptions {
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

/** Options for {@link SessionWriter.pause}. */
export interface PauseOptions {
  /** The run to pause. */
  runId: string;

  /**
   * Override the attribution clientId sent as `x-ably-client-id`. See
   * {@link AbortOptions.clientId}.
   */
  clientId?: string;
}

/** Options for {@link SessionWriter.resume}. */
export interface ResumeOptions {
  /** The run to resume. */
  runId: string;
  /** Target a specific step for checkpoint-based resumption. */
  stepId?: string;
  /** Message the agent must observe before starting (e.g. HITL approval). */
  messageId?: string;

  /**
   * Override the attribution clientId sent as `x-ably-client-id`. See
   * {@link AbortOptions.clientId}.
   */
  clientId?: string;
}

/** Options for {@link SessionWriter.retry}. */
export interface RetryOptions {
  /** The run to retry. */
  runId: string;
  /** Target a specific step for step-level retry. */
  stepId?: string;

  /**
   * Override the attribution clientId sent as `x-ably-client-id`. See
   * {@link AbortOptions.clientId}.
   */
  clientId?: string;
}

/**
 * Run-scoped shape of {@link RetryOptions} — the same options without the
 * redundant `runId`, for callers that already hold the run as a receiver
 * (e.g. run-level retry helpers layered on top of the writer). Derived
 * via `Omit` so any future additions to {@link RetryOptions} flow through
 * automatically.
 */
export type ClientRunRetryOptions = Omit<RetryOptions, 'runId'>;

/**
 * Run-scoped shape of {@link ResumeOptions} — the same options without the
 * redundant `runId`. Derived via `Omit` for drift prevention.
 */
export type ClientRunResumeOptions = Omit<ResumeOptions, 'runId'>;

/**
 * Run-scoped shape of {@link AbortOptions} — the same options without the
 * redundant `runId`. Derived via `Omit` for drift prevention.
 */
export type ClientRunAbortOptions = Omit<AbortOptions, 'runId'>;

/**
 * Run-scoped shape of {@link PauseOptions} — the same options without the
 * redundant `runId`. Derived via `Omit` for drift prevention.
 */
export type ClientRunPauseOptions = Omit<PauseOptions, 'runId'>;

/**
 * The low-level write surface shared by both session types. Every
 * publishable event type has its own method. Views, runs, and steps
 * delegate to this internally. Exposed for server-side validation
 * handlers, orchestrators, and advanced patterns that need explicit
 * control.
 */
export interface SessionWriter<TPart, TMessage> {
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
   * Publish one or more complete domain messages to the channel. Encoded
   * via the codec's writeMessages path. Use for user messages, tool
   * results, HITL approval responses, and other discrete complete messages.
   *
   * Message IDs are supplied by the caller on each message (e.g. the
   * Vercel codec uses `UIMessage.id`). The writer does not assign IDs
   * and does not return them; this matches `run.sendMessages()` so the
   * send surface is uniform.
   *
   * **Same-ID republish is an in-place update.** When a message is published
   * whose ID already identifies a node in the session, the transport routes
   * it through {@link Accumulator.setMessage} and the tree fires
   * `'message-updated'` (not `'message-added'`). Publishing a message with
   * a fresh ID appends a new node.
   *
   * The protocol-level role recorded on the resulting tree node is derived
   * from the publishing connection (or an explicit `clientId` override);
   * the domain-level role inside `TMessage` is opaque to the transport and
   * may differ.
   */
  sendMessages(options: SendMessagesOptions<TMessage>): Promise<void>;

  /**
   * Publish one or more discrete domain parts to the channel. Encoded via
   * the codec's writePart path. Use for standalone parts like `data-*`
   * that are not complete messages.
   *
   * Part IDs, where the domain parts carry them, are supplied by the
   * caller. The writer does not assign IDs and does not return them.
   */
  sendParts(options: SendPartsOptions<TPart>): Promise<void>;

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
