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

/** Options for publishing one or more discrete domain events via {@link SessionWriter.sendEvents}. */
export interface SendEventsOptions<TEvent> {
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

/** Result of {@link SessionWriter.sendMessages} or {@link SessionWriter.sendEvents}. */
export interface SendResult {
  /** The IDs assigned to the published messages, in order. */
  messageIds: string[];
}

/** Options for {@link SessionWriter.abort}. */
export interface AbortOptions {
  /** The run to abort. */
  runId: string;
}

/** Options for {@link SessionWriter.pause}. */
export interface PauseOptions {
  /** The run to pause. */
  runId: string;
}

/** Options for {@link SessionWriter.resume}. */
export interface ResumeOptions {
  /** The run to resume. */
  runId: string;
  /** Target a specific step for checkpoint-based resumption. */
  stepId?: string;
  /** Message the agent must observe before starting (e.g. HITL approval). */
  messageId?: string;
}

/** Options for {@link SessionWriter.retry}. */
export interface RetryOptions {
  /** The run to retry. */
  runId: string;
  /** Target a specific step for step-level retry. */
  stepId?: string;
}

/**
 * The low-level write surface shared by both session types. Every
 * publishable event type has its own method. Views, runs, and steps
 * delegate to this internally. Exposed for server-side validation
 * handlers, orchestrators, and advanced patterns that need explicit
 * control.
 */
export interface SessionWriter<TEvent, TMessage> {
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
