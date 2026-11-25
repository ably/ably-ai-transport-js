import * as Ably from '@ably/pubsub-core';

/**
 * Error codes for the AI Transport SDK.
 *
 * A deprecated member shares its code with the member that replaces it, so
 * code that names it still compiles and matches the same errors.
 */
export enum ErrorCode {
  /**
   * Invalid argument provided.
   */
  InvalidArgument = 40003,

  /**
   * The operation was cancelled (Ably 40033): a caller-supplied `AbortSignal`
   * fired during a history load or a history page wait, or a pipe's signal
   * fired, `close()` included. A cancelled pipe has flushed and repaired what
   * it wrote before it rejects with this. The useChat transport ends a reply
   * with this when `useChat` stops it, when `close()` is called, or when a
   * later call reads the channel again after the channel lost continuity. It
   * rejects a call with this when `useChat`'s abort signal fires, or
   * `close()` ends a `sendMessages`, while the call is still waiting. It names
   * the error `AbortError`, so `useChat` reads it as a stop.
   */
  OperationCancelled = 40033,

  /**
   * A write was made to a stream or writer after it was closed (Ably 40036,
   * `stream_closed`): here, an event writer's `write` after its `close`.
   * Nothing is published for the event, and a closed writer does not reopen:
   * open a new one and hand it the event. The code is in Ably's shared range
   * rather than this SDK's, so the Pub/Sub SDK's `MessageStream` can report a
   * write after its `close` with the same code.
   */
  StreamClosed = 40036,

  /**
   * Operation not permitted with the provided capability (Ably 40160).
   * Used when the Ably channel rejects a publish through `send`, or a publish
   * or update an event writer makes, for a capability reason.
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
   * the channel. The first recovery failure is the `cause`. It stops an event
   * writer, whose `flush` and `close` reject with it and whose next `write`
   * throws it; a pipe rejects with `PipeFailed` and this as the `cause`.
   */
  StreamedMessageFinalizeFailed = 104000,

  /**
   * @deprecated Use {@link ErrorCode.WriteFailed}, which has the same code.
   */
  SessionSendFailed = 104005,

  /**
   * A write failed (Ably 104005, `write_failed`): a publish through an agent
   * adaptor's `send` was rejected. A capability rejection surfaces as
   * {@link ErrorCode.InsufficientCapability} instead. The underlying Ably
   * failure is the `cause`. The useChat transport uses it too, when the POST
   * of a turn fails or answers with a status outside 2xx. That error has no
   * `cause`, and for an answer outside 2xx its `statusCode` is that status.
   */
  // eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values -- replaces the deprecated SessionSendFailed, which keeps the code so code naming it still compiles
  WriteFailed = 104005,

  /**
   * A pipe rejected (Ably 104008, `pipe_failed`): the source stream threw (a
   * provider rate limit, a model error, a network failure), the codec could
   * not encode an event, a publish or update failed mid-stream, or the repair
   * of a stream whose append failed also failed. The underlying failure is the
   * `cause`.
   */
  PipeFailed = 104008,

  /**
   * @deprecated Use {@link ErrorCode.MessageDecodeFailed}, which has the same code.
   */
  SessionMessageProcessingFailed = 104009,

  /**
   * The codec threw while the decoder decoded a channel message (Ably 104009,
   * `message_decode_failed`). The message is still delivered with no event,
   * and the decoder carries on. The thrown value is the `cause`. The useChat
   * transport ends a reply that is reading a turn with this when a message
   * arrives live during that turn and cannot be decoded. A message it reads
   * from history that cannot be decoded is only logged, and the reply goes on
   * without it.
   */
  // eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values -- replaces the deprecated SessionMessageProcessingFailed, which keeps the code so code naming it still compiles
  MessageDecodeFailed = 104009,
}

/**
 * Returns true if the {@link Ably.ErrorInfo} code matches the provided ErrorCode value.
 * @param errorInfo The error info to check.
 * @param error The error code to compare against.
 * @returns true if the error code matches, false otherwise.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison -- comparing an ErrorInfo's numeric code against the enum is this helper's whole job
export const errorInfoIs = (errorInfo: Ably.ErrorInfo, error: ErrorCode): boolean => errorInfo.code === error;
