import { describe, expect, it } from 'vitest';

import { Invocation, type InvocationData } from '../../../src/core/transport/invocation.js';
import { ErrorCode } from '../../../src/errors.js';

describe('Invocation', () => {
  // The body carries no run-id — run identity lives on the channel (the agent
  // mints a fresh run-id, or reads a continuation's off the triggering input).
  const data: InvocationData = {
    inputEventId: 'ev-1',
    channelName: 'chat-session',
  };

  describe('toJSON', () => {
    it('returns the wire shape carrying the invocation identity', () => {
      const invocation = Invocation.fromJSON(data);
      expect(invocation.toJSON()).toEqual(data);
    });

    it('round-trips through fromJSON', () => {
      const roundTripped = Invocation.fromJSON(Invocation.fromJSON(data).toJSON());
      expect(roundTripped.inputEventId).toBe(data.inputEventId);
      expect(roundTripped.channelName).toBe(data.channelName);
    });

    it('is picked up by JSON.stringify as the toJSON hook', () => {
      const invocation = Invocation.fromJSON(data);
      // The canonical app pattern is JSON.stringify(run.toInvocation().toJSON()),
      // but the toJSON() name also makes JSON.stringify(invocation) work directly.
      const serialised = JSON.stringify(invocation);
      expect(JSON.parse(serialised)).toEqual(data);
    });
  });

  describe('fromJSON validation', () => {
    // A trust boundary in two directions: the body arrives over HTTP from a
    // client, and under a durable framework out of a workflow history written
    // by an older SDK. Without these guards a missing field reaches
    // `client.channels.get(undefined)` deep inside an activity.
    it('rejects a missing channelName', () => {
      expect(() => Invocation.fromJSON({ ...data, channelName: '' })).toThrowErrorInfoWithCode(
        ErrorCode.InvalidArgument,
      );
    });

    it('rejects a missing inputEventId', () => {
      expect(() => Invocation.fromJSON({ ...data, inputEventId: '' })).toThrowErrorInfoWithCode(
        ErrorCode.InvalidArgument,
      );
    });
  });
});
