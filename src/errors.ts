import * as Ably from 'ably';

/**
 * Error codes for the AI Transport SDK.
 */
export enum ErrorCode {
  /**
   * The request was invalid.
   */
  BadRequest = 40000,

  /**
   * Invalid argument provided.
   */
  InvalidArgument = 40003,

  /**
   * The requested resource does not exist (Ably 40400) — e.g. the input event
   * an invocation was woken for is not present in the scanned channel history.
   */
  NotFound = 40400,

  /**
   * The operation was cancelled (Ably 40033) — the run was cancelled, or the
   * caller's abort signal fired while the operation was in flight.
   */
  OperationCancelled = 40033,

  /**
   * Operation not permitted with the provided capability (Ably 40160).
   * Used when the Ably channel rejects a publish for a capability reason.
   */
  InsufficientCapability = 40160,

  /**
   * An internal invariant failed (Ably 50000) — the SDK or the Ably service
   * behaved in a way the SDK cannot recover from or explain (e.g. a publish
   * succeeded but returned no serial). Not caused by caller input.
   */
  InternalError = 50000,

  // 104000 - 104999 are reserved for AI Transport SDK errors

  /**
   * Completing or cancelling a streamed message failed — one of its appends was
   * not published, and the follow-up `updateMessage` that would have repaired it
   * by re-sending the accumulated content also failed. The partial is left on
   * the channel. The first recovery failure is the `cause`.
   */
  StreamedMessageFinalizeFailed = 104000,

  /**
   * The transport could not subscribe to and attach its channel during
   * `connect()`. Nothing sends or receives until the attach succeeds; whether a
   * retry helps depends on the `cause` (a transient disconnect clears, a
   * capability or auth rejection does not).
   */
  SessionSubscriptionFailed = 104001,

  /**
   * The run's `onCancel` hook threw while the SDK was processing a cancel
   * message. The SDK never reaches the abort, so the run is **not** cancelled.
   */
  RunCancelHandlerFailed = 104002,

  /**
   * A lifecycle event publish failed, at either tier: a run's `ai-run-start` /
   * `ai-run-suspend` / `ai-run-end`, or a step's `ai-step-start` /
   * `ai-step-end`. The event is not on the channel, so clients do not observe
   * the run or step entering that phase. The underlying publish failure is the
   * `cause`.
   */
  RunLifecycleEventPublishFailed = 104003,

  /**
   * An operation was attempted on a transport or encoder that has already
   * been closed.
   */
  SessionClosed = 104004,

  /**
   * A send failed — the channel publish of an input or steer failed.
   */
  SessionSendFailed = 104005,

  /**
   * The Ably channel lost message continuity — after its initial attach, the
   * channel entered FAILED, SUSPENDED, or DETACHED, or re-attached with
   * `resumed: false`. Active streams can no longer be guaranteed to receive
   * all events.
   */
  SessionContinuityNotGuaranteed = 104006,

  /**
   * An operation was attempted but the channel is not in a usable state
   * (not ATTACHED or ATTACHING).
   */
  SessionChannelNotReady = 104007,

  /**
   * An error occurred while piping a response stream to the channel — either
   * the source event stream threw (e.g. LLM provider rate limit, model error,
   * network failure) or an underlying publish failed mid-stream. Also the
   * fallback code when a run-end reports an error without a code on the wire.
   */
  RunResponseStreamFailed = 104008,

  /**
   * Processing an inbound channel message threw — the codec folding it into
   * session state, or a session-level subscription callback. The subscription
   * survives and the session keeps sending and receiving; only that one
   * message's processing failed. The thrown value is the `cause`.
   */
  SessionMessageProcessingFailed = 104009,

  /**
   * A required event was not found in channel history — a durable
   * invocation's triggering input event (an `AgentTransport.locateInput`
   * miss), or the opening lifecycle event of a run a continuing process
   * re-enters. Retryable: an ordering condition where the event has not yet
   * propagated to history.
   */
  AdoptedRunStartNotObserved = 104010,

  /**
   * Channel history pagination failed after bounded retry — either the initial
   * `channel.history()` call or a subsequent `page.next()` exhausted its
   * retry budget. Also used when a history load fails with an error that is
   * not already an `Ably.ErrorInfo`. The original failure is preserved as
   * `cause` where available.
   */
  SessionHistoryFetchFailed = 104011,

  /**
   * The run's `onSteer` hook threw while the SDK was notifying it that a
   * steering message folded into the run. The steering message has already
   * folded in by then, so the run is unaffected — only the notification failed.
   */
  RunSteerHandlerFailed = 104012,

  /**
   * Routing an inbound cancel message to its target run failed. Not a fault in
   * a developer-supplied hook: the dispatch itself could not complete, so the
   * cancel was neither honoured nor rejected and the run keeps running.
   */
  RunCancelRoutingFailed = 104013,

  /**
   * A step attempt this stream had already forwarded output for started again,
   * so the output already delivered belongs to a superseded attempt and the
   * stream's content is stale. The stream is errored rather than continued,
   * because the consumer's accumulated parts cannot be un-written in place.
   *
   * Recovery is specific to this code: drop the damaged assistant message and
   * resume, and the replay delivers only the canonical attempt's output.
   */
  RunAttemptSuperseded = 104014,
}

/**
 * Returns true if the {@link Ably.ErrorInfo} code matches the provided ErrorCode value.
 * @param errorInfo The error info to check.
 * @param error The error code to compare against.
 * @returns true if the error code matches, false otherwise.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
export const errorInfoIs = (errorInfo: Ably.ErrorInfo, error: ErrorCode): boolean => errorInfo.code === error;
