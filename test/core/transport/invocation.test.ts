import { describe, expect, it } from 'vitest';

import { Invocation, type InvocationData } from '../../../src/core/transport/invocation.js';

describe('Invocation', () => {
  const data: InvocationData = {
    runId: 'run-1',
    invocationId: 'inv-1',
    inputEventId: 'ev-1',
    sessionName: 'chat-session',
  };

  describe('toJSON', () => {
    it('returns the wire shape carrying the invocation identity', () => {
      const invocation = Invocation.fromJSON(data);
      expect(invocation.toJSON()).toEqual(data);
    });

    it('round-trips through fromJSON', () => {
      const roundTripped = Invocation.fromJSON(Invocation.fromJSON(data).toJSON());
      expect(roundTripped.runId).toBe(data.runId);
      expect(roundTripped.invocationId).toBe(data.invocationId);
      expect(roundTripped.inputEventId).toBe(data.inputEventId);
      expect(roundTripped.sessionName).toBe(data.sessionName);
    });

    it('is picked up by JSON.stringify as the toJSON hook', () => {
      const invocation = Invocation.fromJSON(data);
      // The canonical app pattern is JSON.stringify(run.toInvocation().toJSON()),
      // but the toJSON() name also makes JSON.stringify(invocation) work directly.
      const serialised = JSON.stringify(invocation);
      expect(JSON.parse(serialised)).toEqual(data);
    });
  });
});
