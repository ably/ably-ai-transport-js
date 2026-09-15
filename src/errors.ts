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
   * fired during a history load or a history page wait.
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
}

/**
 * Returns true if the {@link Ably.ErrorInfo} code matches the provided ErrorCode value.
 * @param errorInfo The error info to check.
 * @param error The error code to compare against.
 * @returns true if the error code matches, false otherwise.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison -- comparing an ErrorInfo's numeric code against the enum is this helper's whole job
export const errorInfoIs = (errorInfo: Ably.ErrorInfo, error: ErrorCode): boolean => errorInfo.code === error;
