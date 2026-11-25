import * as Ably from '@ably/pubsub-core';
import { describe, expect, it } from 'vitest';

import { ErrorCode, errorInfoIs } from '../src/errors.js';

describe('ErrorCode', () => {
  describe('deprecated members', () => {
    it.each([
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- the test is that the deprecated name still works
      ['SessionSendFailed', 'WriteFailed', ErrorCode.SessionSendFailed, ErrorCode.WriteFailed],
      [
        'SessionMessageProcessingFailed',
        'MessageDecodeFailed',
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- the test is that the deprecated name still works
        ErrorCode.SessionMessageProcessingFailed,
        ErrorCode.MessageDecodeFailed,
      ],
    ])('%s has the code of %s, so an error matches either name', (_old, current, deprecated, replacement) => {
      const error = new Ably.ErrorInfo('unable to test; reason', replacement, 500);

      expect(deprecated).toBe(replacement);
      expect(errorInfoIs(error, deprecated)).toBe(true);
      // The member that replaces it is declared last, so a code reads back as its current name.
      expect(ErrorCode[replacement]).toBe(current);
    });
  });
});
