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

    it('omits runId from the wire shape when the invocation carries none', () => {
      const invocation = Invocation.fromJSON({ inputEventId: 'ev-1', sessionName: 'chat-session' });
      expect(invocation.runId).toBeUndefined();
      expect('runId' in invocation.toJSON()).toBe(false);
    });

    it('omits a minted invocationId from the wire shape (the agent mints its own)', () => {
      // A fresh client pointer carries no invocation-id. The minted id is
      // internal, so it must not leak into the POST body — the agent's POST
      // handler mints the authoritative one.
      const invocation = Invocation.fromJSON({ inputEventId: 'ev-1', sessionName: 'chat-session' });
      expect(invocation.invocationId).toBeDefined();
      expect('invocationId' in invocation.toJSON()).toBe(false);
      expect(invocation.toJSON()).toEqual({ inputEventId: 'ev-1', sessionName: 'chat-session' });
    });

    it('re-emits a supplied invocationId on the wire shape', () => {
      // A body that did carry an invocation-id round-trips it.
      const invocation = Invocation.fromJSON({
        invocationId: 'inv-supplied',
        inputEventId: 'ev-1',
        sessionName: 'chat-session',
      });
      expect(invocation.toJSON().invocationId).toBe('inv-supplied');
    });
  });

  describe('identity minting', () => {
    it('mints an invocationId when the body omits one', () => {
      const invocation = Invocation.fromJSON({ inputEventId: 'ev-1', sessionName: 'chat-session' });
      expect(invocation.invocationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('mints a distinct invocationId per construction', () => {
      const a = Invocation.fromJSON({ inputEventId: 'ev-1', sessionName: 'chat-session' });
      const b = Invocation.fromJSON({ inputEventId: 'ev-1', sessionName: 'chat-session' });
      expect(a.invocationId).not.toBe(b.invocationId);
    });

    it('honours a supplied invocationId rather than minting', () => {
      const invocation = Invocation.fromJSON({
        invocationId: 'inv-supplied',
        inputEventId: 'ev-1',
        sessionName: 'chat-session',
      });
      expect(invocation.invocationId).toBe('inv-supplied');
    });

    it('leaves runId undefined when omitted and honours it when supplied', () => {
      expect(Invocation.fromJSON({ inputEventId: 'ev-1', sessionName: 's' }).runId).toBeUndefined();
      expect(Invocation.fromJSON({ runId: 'run-9', inputEventId: 'ev-1', sessionName: 's' }).runId).toBe('run-9');
    });
  });
});
