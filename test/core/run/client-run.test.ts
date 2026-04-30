import { describe, expect, it } from 'vitest';

import type { Codec } from '../../../src/core/codec/index.js';
import { createClientRun } from '../../../src/core/run/index.js';

type StubCodec = Codec<string, string>;

describe('createClientRun', () => {
  it('exposes the supplied id, status, and initiatorClientId', () => {
    const run = createClientRun<StubCodec>({
      id: 'r-1',
      status: 'active',
      initiatorClientId: 'alice',
      sessionName: 's-1',
      messageId: 'm-1',
    });

    expect(run.id).toBe('r-1');
    expect(run.status).toBe('active');
    expect(run.initiatorClientId).toBe('alice');
  });

  describe('toInvocation', () => {
    it('builds an Invocation carrying sessionName, runId, and messageId when present', () => {
      const run = createClientRun<StubCodec>({
        id: 'r-1',
        status: 'active',
        initiatorClientId: 'alice',
        sessionName: 's-1',
        messageId: 'm-1',
      });

      const inv = run.toInvocation();

      expect(inv.sessionName).toBe('s-1');
      expect(inv.runId).toBe('r-1');
      expect(inv.messageId).toBe('m-1');
      expect(inv.stepId).toBeUndefined();
    });

    it('omits messageId from the invocation when not supplied', () => {
      const run = createClientRun<StubCodec>({
        id: 'r-1',
        status: 'active',
        initiatorClientId: 'alice',
        sessionName: 's-1',
      });

      const inv = run.toInvocation();

      expect(inv.messageId).toBeUndefined();
      expect(Object.keys(inv.toJSON())).toEqual(['sessionName', 'runId']);
    });

    it('toJSON of the produced invocation round-trips back through Invocation.fromJSON', () => {
      const run = createClientRun<StubCodec>({
        id: 'r-1',
        status: 'active',
        initiatorClientId: 'alice',
        sessionName: 's-1',
        messageId: 'm-1',
      });

      const json = run.toInvocation().toJSON();

      expect(json).toEqual({ sessionName: 's-1', runId: 'r-1', messageId: 'm-1' });
    });

    it('returns a fresh invocation on each call', () => {
      const run = createClientRun<StubCodec>({
        id: 'r-1',
        status: 'active',
        initiatorClientId: 'alice',
        sessionName: 's-1',
      });

      expect(run.toInvocation()).not.toBe(run.toInvocation());
    });
  });
});
