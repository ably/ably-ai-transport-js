import type * as Ably from 'ably';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EVENT_RUN_END,
  EVENT_RUN_START,
  HEADER_FORK_OF,
  HEADER_MSG_REGENERATE,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_CONTINUE,
  HEADER_RUN_ID,
  HEADER_RUN_REASON,
} from '../../../src/constants.js';
import type { RunManager } from '../../../src/core/transport/run-manager.js';
import { createRunManager } from '../../../src/core/transport/run-manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockChannel {
  publish: ReturnType<typeof vi.fn>;
  publishCalls: Ably.Message[];
}

const createMockChannel = (): MockChannel & Ably.RealtimeChannel => {
  const mock: MockChannel = {
    publishCalls: [],
    // eslint-disable-next-line @typescript-eslint/require-await -- mock returns resolved promise
    publish: vi.fn(async (msg: Ably.Message) => {
      mock.publishCalls.push(msg);
    }),
  };
  // CAST: Tests only use publish — other RealtimeChannel members are unused.
  return mock as unknown as MockChannel & Ably.RealtimeChannel;
};

const headersOf = (msg: Ably.Message): Record<string, string> =>
  (msg.extras as { headers: Record<string, string> }).headers;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RunManager', () => {
  let channel: MockChannel & Ably.RealtimeChannel;
  let manager: RunManager;

  beforeEach(() => {
    channel = createMockChannel();
    manager = createRunManager(channel);
  });

  describe('startRun', () => {
    it('publishes run-start event with correct headers', async () => {
      await manager.startRun('run-1', 'user-a');

      expect(channel.publishCalls).toHaveLength(1);
      const [msg] = channel.publishCalls;
      expect(msg).toBeDefined();
      expect(msg?.name).toBe(EVENT_RUN_START);

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- narrowed by expect above
      const headers = headersOf(msg!);
      expect(headers[HEADER_RUN_ID]).toBe('run-1');
      expect(headers[HEADER_RUN_CLIENT_ID]).toBe('user-a');
    });

    it('returns an AbortSignal', async () => {
      const signal = await manager.startRun('run-1');
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
    });

    it('uses external controller when provided', async () => {
      const controller = new AbortController();
      const signal = await manager.startRun('run-1', 'user-a', controller);
      expect(signal).toBe(controller.signal);
    });

    it('defaults clientId to empty string when omitted', async () => {
      await manager.startRun('run-1');

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted
      const headers = headersOf(channel.publishCalls.at(0)!);
      expect(headers[HEADER_RUN_CLIENT_ID]).toBe('');
    });

    it('stamps x-ably-run-continue:true when continuation metadata is set', async () => {
      await manager.startRun('run-1', 'user-a', undefined, { continuation: true });

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted
      const headers = headersOf(channel.publishCalls.at(0)!);
      expect(headers[HEADER_RUN_CONTINUE]).toBe('true');
    });

    it('omits x-ably-run-continue when continuation is false or unset', async () => {
      await manager.startRun('run-1', 'user-a', undefined, { continuation: false });
      await manager.startRun('run-2', 'user-a');

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted
      expect(headersOf(channel.publishCalls.at(0)!)[HEADER_RUN_CONTINUE]).toBeUndefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted
      expect(headersOf(channel.publishCalls.at(1)!)[HEADER_RUN_CONTINUE]).toBeUndefined();
    });

    it('stamps x-ably-fork-of when metadata.forkOf is set (edit run-start)', async () => {
      await manager.startRun('run-1', 'user-a', undefined, { forkOf: 'orig-user-msg' });

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted
      const headers = headersOf(channel.publishCalls.at(0)!);
      expect(headers[HEADER_FORK_OF]).toBe('orig-user-msg');
      expect(headers[HEADER_MSG_REGENERATE]).toBeUndefined();
    });

    it('stamps x-ably-msg-regenerate when metadata.regenerates is set (regenerate run-start)', async () => {
      await manager.startRun('run-1', 'user-a', undefined, { regenerates: 'orig-asst-msg' });

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted
      const headers = headersOf(channel.publishCalls.at(0)!);
      expect(headers[HEADER_MSG_REGENERATE]).toBe('orig-asst-msg');
      expect(headers[HEADER_FORK_OF]).toBeUndefined();
    });
  });

  describe('endRun', () => {
    it('publishes run-end event with reason', async () => {
      await manager.startRun('run-1', 'user-a');
      await manager.endRun('run-1', 'complete');

      expect(channel.publishCalls).toHaveLength(2);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted
      const msg = channel.publishCalls.at(1)!;
      expect(msg.name).toBe(EVENT_RUN_END);

      const headers = headersOf(msg);
      expect(headers[HEADER_RUN_ID]).toBe('run-1');
      expect(headers[HEADER_RUN_CLIENT_ID]).toBe('user-a');
      expect(headers[HEADER_RUN_REASON]).toBe('complete');
    });

    it('removes run from active set after publish', async () => {
      await manager.startRun('run-1');
      await manager.endRun('run-1', 'complete');

      expect(manager.getSignal('run-1')).toBeUndefined();
      expect(manager.getActiveRunIds()).toHaveLength(0);
    });

    it('defaults clientId to empty string for unknown run', async () => {
      await manager.endRun('unknown', 'error');

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted
      const headers = headersOf(channel.publishCalls.at(0)!);
      expect(headers[HEADER_RUN_CLIENT_ID]).toBe('');
    });
  });

  describe('getSignal', () => {
    it('returns signal for active run', async () => {
      await manager.startRun('run-1');
      expect(manager.getSignal('run-1')).toBeInstanceOf(AbortSignal);
    });

    it('returns undefined for unknown run', () => {
      expect(manager.getSignal('nope')).toBeUndefined();
    });
  });

  describe('getClientId', () => {
    it('returns clientId for active run', async () => {
      await manager.startRun('run-1', 'user-a');
      expect(manager.getClientId('run-1')).toBe('user-a');
    });

    it('returns undefined for unknown run', () => {
      expect(manager.getClientId('nope')).toBeUndefined();
    });
  });

  describe('abort', () => {
    it('fires the abort signal for the run', async () => {
      const signal = await manager.startRun('run-1');
      expect(signal.aborted).toBe(false);

      manager.abort('run-1');
      expect(signal.aborted).toBe(true);
    });

    it('does nothing for unknown run', () => {
      // Should not throw
      manager.abort('nope');
    });
  });

  describe('getActiveRunIds', () => {
    it('returns all active run IDs', async () => {
      await manager.startRun('run-1');
      await manager.startRun('run-2');

      const ids = manager.getActiveRunIds();
      expect(ids).toHaveLength(2);
      expect(ids).toContain('run-1');
      expect(ids).toContain('run-2');
    });
  });

  describe('close', () => {
    it('aborts all active runs', async () => {
      const signal1 = await manager.startRun('run-1');
      const signal2 = await manager.startRun('run-2');

      manager.close();

      expect(signal1.aborted).toBe(true);
      expect(signal2.aborted).toBe(true);
    });

    it('clears all active runs', async () => {
      await manager.startRun('run-1');
      manager.close();

      expect(manager.getActiveRunIds()).toHaveLength(0);
    });
  });
});
