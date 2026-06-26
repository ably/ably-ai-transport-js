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
   * Operation not permitted with the provided capability (Ably 40160).
   * Used when the Ably channel rejects a publish for a capability reason.
   */
  InsufficientCapability = 40160,

  // 104000 - 104999 are reserved for AI Transport SDK errors

  /**
   * Encoder recovery failed during flush — one or more updateMessage calls
   * could not recover a failed append pipeline.
   */
  EncoderRecoveryFailed = 104000,

  /**
   * A session-level channel subscription callback threw unexpectedly.
   */
  SessionSubscriptionError = 104001,

  /**
   * Cancel listener or onCancel hook threw while processing a cancel message.
   */
  CancelListenerError = 104002,

  /**
   * A publish within a run failed (lifecycle event, message, or event).
   */
  RunLifecycleError = 104003,

  /**
   * An operation was attempted on a session that has already been closed.
   */
  SessionClosed = 104004,

  /**
   * The HTTP POST to the agent endpoint failed (network error or non-2xx response).
   */
  SessionSendFailed = 104005,

  /**
   * The Ably channel lost message continuity — the channel entered FAILED,
   * SUSPENDED, or DETACHED, or re-attached with `resumed: false`. Active
   * streams can no longer be guaranteed to receive all events.
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
   * network failure) or an underlying publish failed mid-stream.
   */
  StreamError = 104008,

  /**
   * Channel history pagination failed after bounded retry — either the initial
   * `channel.history()` call or a subsequent `page.next()` exhausted its
   * retry budget. The original failure is preserved as `cause`.
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
