import * as Ably from 'ably';

/**
 * Error codes for the AI Transport SDK.
 *
 * The `Session*` member names mirror the canonical identifiers in the
 * ably-common error registry (`session_subscription_failed`, `session_closed`,
 * …), so they are kept even though this SDK's own vocabulary says "transport".
 * Read `Session` as "transport" throughout.
 */
export enum ErrorCode {
  /**
   * Invalid argument provided.
   */
  InvalidArgument = 40003,

  /**
   * The operation was cancelled (Ably 40033) — a caller-supplied `AbortSignal`
   * fired during a history load, a history page wait, or an input locate.
   */
  OperationCancelled = 40033,

  /**
   * Operation not permitted with the provided capability (Ably 40160).
   * Used when the Ably channel rejects a publish for a capability reason.
   */
  InsufficientCapability = 40160,

  /**
   * The requested resource does not exist (Ably 40400) — e.g. the input event
   * an invocation was woken for is not present in the scanned channel history.
   */
  NotFound = 40400,

  /**
   * The operation conflicted with the current state of what it addressed
   * (Ably 40900), so it could not be completed.
   *
   * One situation raises it: a step attempt a stream had already forwarded
   * output for started again, so what the consumer has accumulated belongs to
   * a superseded attempt and conflicts with the run as it now stands. The
   * stream is errored rather than continued, because accumulated parts cannot
   * be un-written in place.
   *
   * Recovery is specific to this code: drop the damaged assistant message and
   * resume, and the replay delivers only the canonical attempt's output.
   */
  Conflict = 40900,

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
   * message — the SDK never reaches the abort, so the run is **not** cancelled
   * and keeps running. A failure to route the cancel to its run at all is
   * {@link ErrorCode.RunCancelRoutingFailed} instead.
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
   * An operation was attempted on a transport or encoder that has already been
   * closed.
   */
  SessionClosed = 104004,

  /**
   * A publish to the channel was rejected. Raised on the input and steer write
   * paths; a capability rejection surfaces as
   * {@link ErrorCode.InsufficientCapability} instead. The underlying Ably
   * failure is the `cause`.
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
   * An error occurred while piping a response stream to the channel — either
   * the source event stream threw (e.g. LLM provider rate limit, model error,
   * network failure) or an underlying publish failed mid-stream.
   *
   * Also the fallback a consumer sees for an errored run-end whose `error-code`
   * header it cannot use — absent, or present but not a positive integer. So a
   * run that failed for an unrelated reason still surfaces under this code when
   * its terminal did not carry a usable one.
   */
  RunResponseStreamFailed = 104008,

  /**
   * Processing an inbound channel message threw — the codec decoding it, or a
   * transport-level subscription callback. The subscription survives and the
   * transport keeps sending and receiving; only that one message's processing
   * failed. The thrown value is the `cause`.
   */
  SessionMessageProcessingFailed = 104009,

  /**
   * Channel history pagination failed after bounded retry — either the initial
   * `channel.history()` call or a subsequent `page.next()` exhausted its
   * retry budget. The original failure is preserved as `cause` where
   * available.
   */
  SessionHistoryFetchFailed = 104011,

  /**
   * The run's `onSteer` hook threw while the SDK was notifying it that a
   * steering message arrived for the run. The steer is already recorded on the
   * run by then, so the run is unaffected; only the notification failed.
   */
  RunSteerHandlerFailed = 104012,

  /**
   * An inbound cancel message could not be delivered to the run it targets —
   * the dispatch itself failed before any hook ran. The cancel is neither
   * carried out nor rejected, so the run keeps running as though the message
   * had not arrived. A cancel that reached its run but whose `onCancel` hook
   * threw is {@link ErrorCode.RunCancelHandlerFailed} instead.
   */
  RunCancelRoutingFailed = 104013,
}

/**
 * Returns true if the {@link Ably.ErrorInfo} code matches the provided ErrorCode value.
 * @param errorInfo The error info to check.
 * @param error The error code to compare against.
 * @returns true if the error code matches, false otherwise.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison -- comparing an ErrorInfo's numeric code against the enum is this helper's whole job
export const errorInfoIs = (errorInfo: Ably.ErrorInfo, error: ErrorCode): boolean => errorInfo.code === error;
