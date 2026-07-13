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
   * The operation was cancelled (Ably 40033) — the run was cancelled, the
   * caller's abort signal fired, or the session began closing while the
   * operation was in flight.
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
   * Encoder recovery failed during flush — one or more updateMessage calls
   * could not recover a failed append pipeline.
   */
  EncoderRecoveryFailed = 104000,

  /**
   * The session's channel subscription failed — the subscribe/attach step
   * failed, or a session-level subscription callback threw unexpectedly.
   */
  SessionSubscriptionError = 104001,

  /**
   * A run-scoped developer callback threw while the SDK invoked it — the
   * `onCancel` hook processing a cancel message, or the `onSteer` hook
   * notifying that a steering message folded into the run.
   */
  CancelListenerError = 104002,

  /**
   * A publish within a run failed (lifecycle event, message, or event).
   */
  RunLifecycleError = 104003,

  /**
   * An operation was attempted on a session, view, or encoder that has already
   * been closed.
   */
  SessionClosed = 104004,

  /**
   * A send failed — the channel publish failed, or (in the Vercel chat
   * transport) the HTTP POST to the agent endpoint failed (network error or
   * non-2xx response).
   */
  SessionSendFailed = 104005,

  /**
   * The Ably channel lost message continuity — after its initial attach, the
   * channel entered FAILED, SUSPENDED, or DETACHED, or re-attached with
   * `resumed: false`. Active streams can no longer be guaranteed to receive
   * all events.
   */
  ChannelContinuityLost = 104006,

  /**
   * An operation was attempted but the channel is not in a usable state
   * (not ATTACHED or ATTACHING).
   */
  ChannelNotReady = 104007,

  /**
   * An error occurred while piping a response stream to the channel — either
   * the source event stream threw (e.g. LLM provider rate limit, model error,
   * network failure) or an underlying publish failed mid-stream. Also the
   * fallback code when a run-end reports an error without a code on the wire.
   */
  StreamError = 104008,

  /**
   * A fresh process adopting an open run via {@link AdoptedRun.load} waited for
   * that run's `ai-run-start` to be observed on the channel — across the live
   * subscription and the bounded history scan — but the `timeoutMs` bound lapsed
   * (or the channel exhausted) without seeing it. Retryable: a workflow-ordering
   * error where the open activity's run-start has not yet propagated. Any
   * history-fetch failure is preserved as `cause`.
   */
  InputEventNotFound = 104010,

  /**
   * Channel history pagination failed after bounded retry — either the initial
   * `channel.history()` call or a subsequent `page.next()` exhausted its
   * retry budget. Also used when a history load fails with an error that is
   * not already an `Ably.ErrorInfo`. The original failure is preserved as
   * `cause` where available.
   */
  HistoryFetchFailed = 104011,
}

/**
 * Returns true if the {@link Ably.ErrorInfo} code matches the provided ErrorCode value.
 * @param errorInfo The error info to check.
 * @param error The error code to compare against.
 * @returns true if the error code matches, false otherwise.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
export const errorInfoIs = (errorInfo: Ably.ErrorInfo, error: ErrorCode): boolean => errorInfo.code === error;
