import * as Ably from 'ably';

/**
 * Error codes for the AI Transport SDK.
 *
 * Custom SDK-specific codes live in the reserved `104xxx` range. New codes
 * are added as the features that need them are implemented.
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

  // --- Encoder ---

  /**
   * The encoder's recovery path failed: a `message.append` rejected, and
   * the fallback `updateMessage` carrying the accumulated buffer also
   * rejected. The streamed message's content cannot be reconstructed on
   * the wire — receivers may see truncated content.
   */
  EncoderRecoveryFailed = 104000,

  // --- Transport ---

  /** The underlying Ably channel subscription failed or lost continuity. */
  TransportSubscriptionError = 104001,

  // --- Session lifecycle ---

  /** The session has been closed; the requested operation is no longer valid. */
  SessionClosed = 104100,

  /**
   * Hydrating the session's tree from channel history failed during
   * {@link ClientSession.connect}/{@link AgentSession.connect}. The cause
   * (the underlying `channel.history` rejection) is preserved on
   * `Ably.ErrorInfo.cause`.
   */
  HydrationFailed = 104101,

  // --- Invocation ---

  /** The invocation data passed to {@link Invocation.fromJSON} is missing required fields or has wrong-typed values. */
  InvocationInvalid = 104402,

  // --- Step ---

  /**
   * `Step.start` was aborted before the step-start was confirmed on the
   * channel — either the caller-supplied `start({ signal })` fired or the
   * configured `timeoutMs` elapsed.
   */
  StepStartAborted = 104302,

  /**
   * `AgentSession.createRun` timed out (or was aborted) waiting for the
   * invocation's preconditions to materialise on the session — the run-start
   * for the invocation's `runId` (and, when set, the message named by
   * `messageId`) never arrived from channel history or live delivery.
   */
  InvocationPreconditionTimeout = 104301,
}

/**
 * Returns true if the {@link Ably.ErrorInfo} code matches the provided ErrorCode value.
 * @param errorInfo The error info to check.
 * @param error The error code to compare against.
 * @returns true if the error code matches, false otherwise.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
export const errorInfoIs = (errorInfo: Ably.ErrorInfo, error: ErrorCode): boolean => errorInfo.code === error;
