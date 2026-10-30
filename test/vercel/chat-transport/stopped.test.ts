import { describe, expect, it } from 'vitest';

import { ErrorCode } from '../../../src/errors.js';
import { stoppedError } from '../../../src/vercel/chat-transport/stopped.js';

describe('stoppedError', () => {
  it('is OperationCancelled, named AbortError so useChat reads it as a stop', () => {
    const error = stoppedError('read the turn', 'its abort signal fired');
    expect(error).toBeErrorInfo({
      code: ErrorCode.OperationCancelled,
      statusCode: 400,
      message: 'unable to read the turn; its abort signal fired',
    });
    expect(error.name).toBe('AbortError');
  });
});
