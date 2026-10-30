/**
 * The error the chat transport stops a call or a reply with, and the reasons
 * it gives.
 */

import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';

/** Why a call or a reply stops when its abort signal fires. */
export const ABORTED = 'its abort signal fired';

/** Why a call or a reply stops when the chat transport is closed. */
export const CLOSED = 'the chat transport was closed';

/** Why a reply stops when the channel lost continuity and a later call read the channel again. */
export const LOST_CONTINUITY = 'the channel lost continuity, and a later call read it again';

/**
 * The error a stream or a call ends with when it is stopped:
 * `OperationCancelled`, named `AbortError` like an aborted fetch, so `useChat`
 * treats it as a stop rather than a failure.
 * @param operation - What was stopped, for the message.
 * @param reason - Why it stopped.
 * @returns The error.
 */
export const stoppedError = (operation: string, reason: string): Ably.ErrorInfo => {
  const error = new Ably.ErrorInfo(`unable to ${operation}; ${reason}`, ErrorCode.OperationCancelled, 400);
  error.name = 'AbortError';
  return error;
};
