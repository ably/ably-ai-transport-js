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

  // 104000 - 104999 are reserved for AI Transport SDK errors

  /**
   * Encoder recovery failed after flush — one or more updateMessage calls
   * could not recover a failed append pipeline.
   */
  EncoderRecoveryFailed = 104000,
}

/**
 * Returns true if the {@link Ably.ErrorInfo} code matches the provided ErrorCode value.
 * @param errorInfo The error info to check.
 * @param error The error code to compare against.
 * @returns true if the error code matches, false otherwise.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
export const errorInfoIs = (errorInfo: Ably.ErrorInfo, error: ErrorCode): boolean => errorInfo.code === error;
