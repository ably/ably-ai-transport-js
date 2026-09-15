/** Helpers shared by the hooks. */

import * as Ably from 'ably';

import { ErrorCode } from '../errors.js';
import { errorCause, errorMessage } from '../utils.js';

/**
 * The `Ably.ErrorInfo` a failure reaches a hook's state as. The transport
 * throws and rejects with `ErrorInfo`; anything else is wrapped so a consumer
 * always reads one type.
 * @param error - The thrown or rejected value.
 * @param operation - What failed, for the wrapped message.
 * @returns The error info.
 */
export const toErrorInfo = (error: unknown, operation: string): Ably.ErrorInfo =>
  error instanceof Ably.ErrorInfo
    ? error
    : new Ably.ErrorInfo(
        `unable to ${operation}; ${errorMessage(error)}`,
        ErrorCode.InternalError,
        500,
        errorCause(error),
      );
