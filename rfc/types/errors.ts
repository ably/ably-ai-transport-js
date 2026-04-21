/**
 * Error codes raised by the Durable Sessions API.
 *
 * Custom codes live in the reserved `104xxx` range per
 * `.claude/rules/ERRORS.md`. The HTTP `statusCode` on each
 * `Ably.ErrorInfo` is derived case-by-case rather than by slicing the
 * numeric code (104xxx is not a valid HTTP status).
 */
export enum ErrorCode {
  /** Publishing a message or event through the transport failed. */
  TransportSendFailed = 104000,
  /** The underlying Ably channel subscription failed. */
  TransportSubscriptionError = 104001,

  // --- Step disposer safety net ---

  /**
   * The step's `[Symbol.asyncDispose]` fired while the step was still
   * active and no explicit `end()` had been called — published as the
   * `cause` of the disposer's `step.end('failed')` publish.
   */
  StepDisposedBeforeEnd = 104021,

  // --- Session lifecycle ---

  /** The session has been closed; the requested operation is no longer valid. */
  SessionClosed = 104100,
  /** Hydration from the configured `StorageReader` failed. */
  HydrationFailed = 104101,

  // --- Run lifecycle ---

  /** `run.start()` was called on a run that has already been started. */
  RunAlreadyStarted = 104199,
  /**
   * `AgentRun.suspend()` was called on a run that has already reached a
   * terminal status — the forward-motion transition is impossible. `end()`
   * and `suspend()` on terminal/suspended states are idempotent no-ops and
   * do not raise this code.
   */
  RunAlreadyTerminal = 104200,
  /** `run.when()` rejected because the session closed before the targeted status was reached. */
  RunClosed = 104201,

  // --- Step lifecycle ---

  /**
   * `step.start()` rejected because another `x-ably-step-start` with an
   * earlier serial was observed for the same run — a later hop won.
   */
  StepSuperseded = 104300,
  /**
   * `step.start()` timed out waiting for the invocation's preconditions
   * to become visible in the session.
   */
  InvocationPreconditionTimeout = 104301,
  /** `step.start()` was aborted by a caller-supplied `AbortSignal` before it resolved. */
  StepStartAborted = 104302,

  // --- View / invocation ---

  /** The view has been closed; the requested operation is no longer valid. */
  ViewClosed = 104400,
  /** `view.select()` was called with a message ID that does not exist in the tree. */
  ViewNodeNotFound = 104401,
  /** `Invocation.fromJSON()` was called with data that does not describe a valid invocation. */
  InvocationInvalid = 104402,

  // --- Storage ---

  /** The configured `StorageWriter` exhausted its retry budget; surfaced via `session.on('error')`. */
  StorageWriteFailed = 104500,
}
