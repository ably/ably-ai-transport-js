import type * as Ably from 'ably';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EVENT_TURN_END,
  EVENT_TURN_START,
  HEADER_TURN_CLIENT_ID,
  HEADER_TURN_ID,
  HEADER_TURN_REASON,
} from '../../../../src/constants.js';
import type { TurnManager } from '../../../../src/core/transport/server/turn-manager.js';
import { createTurnManager } from '../../../../src/core/transport/server/turn-manager.js';

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

describe('TurnManager', () => {
  let channel: MockChannel & Ably.RealtimeChannel;
  let manager: TurnManager;

  beforeEach(() => {
    channel = createMockChannel();
    manager = createTurnManager(channel);
  });

  describe('startTurn', () => {
    it('publishes turn-start event with correct headers', async () => {
      await manager.startTurn('turn-1', 'user-a');

      expect(channel.publishCalls).toHaveLength(1);
      const [msg] = channel.publishCalls;
      expect(msg).toBeDefined();
      expect(msg?.name).toBe(EVENT_TURN_START);

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- narrowed by expect above
      const headers = headersOf(msg!);
      expect(headers[HEADER_TURN_ID]).toBe('turn-1');
      expect(headers[HEADER_TURN_CLIENT_ID]).toBe('user-a');
    });

    it('returns an AbortSignal', async () => {
      const signal = await manager.startTurn('turn-1');
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
    });

    it('uses external controller when provided', async () => {
      const controller = new AbortController();
      const signal = await manager.startTurn('turn-1', 'user-a', controller);
      expect(signal).toBe(controller.signal);
    });

    it('defaults clientId to empty string when omitted', async () => {
      await manager.startTurn('turn-1');

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted
      const headers = headersOf(channel.publishCalls.at(0)!);
      expect(headers[HEADER_TURN_CLIENT_ID]).toBe('');
    });
  });

  describe('endTurn', () => {
    it('publishes turn-end event with reason', async () => {
      await manager.startTurn('turn-1', 'user-a');
      await manager.endTurn('turn-1', 'complete');

      expect(channel.publishCalls).toHaveLength(2);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted
      const msg = channel.publishCalls.at(1)!;
      expect(msg.name).toBe(EVENT_TURN_END);

      const headers = headersOf(msg);
      expect(headers[HEADER_TURN_ID]).toBe('turn-1');
      expect(headers[HEADER_TURN_CLIENT_ID]).toBe('user-a');
      expect(headers[HEADER_TURN_REASON]).toBe('complete');
    });

    it('removes turn from active set after publish', async () => {
      await manager.startTurn('turn-1');
      await manager.endTurn('turn-1', 'complete');

      expect(manager.getSignal('turn-1')).toBeUndefined();
      expect(manager.getActiveTurnIds()).toHaveLength(0);
    });

    it('defaults clientId to empty string for unknown turn', async () => {
      await manager.endTurn('unknown', 'error');

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length asserted
      const headers = headersOf(channel.publishCalls.at(0)!);
      expect(headers[HEADER_TURN_CLIENT_ID]).toBe('');
    });
  });

  describe('getSignal', () => {
    it('returns signal for active turn', async () => {
      await manager.startTurn('turn-1');
      expect(manager.getSignal('turn-1')).toBeInstanceOf(AbortSignal);
    });

    it('returns undefined for unknown turn', () => {
      expect(manager.getSignal('nope')).toBeUndefined();
    });
  });

  describe('getClientId', () => {
    it('returns clientId for active turn', async () => {
      await manager.startTurn('turn-1', 'user-a');
      expect(manager.getClientId('turn-1')).toBe('user-a');
    });

    it('returns undefined for unknown turn', () => {
      expect(manager.getClientId('nope')).toBeUndefined();
    });
  });

  describe('abort', () => {
    it('fires the abort signal for the turn', async () => {
      const signal = await manager.startTurn('turn-1');
      expect(signal.aborted).toBe(false);

      manager.abort('turn-1');
      expect(signal.aborted).toBe(true);
    });

    it('does nothing for unknown turn', () => {
      // Should not throw
      manager.abort('nope');
    });
  });

  describe('getActiveTurnIds', () => {
    it('returns all active turn IDs', async () => {
      await manager.startTurn('turn-1');
      await manager.startTurn('turn-2');

      const ids = manager.getActiveTurnIds();
      expect(ids).toHaveLength(2);
      expect(ids).toContain('turn-1');
      expect(ids).toContain('turn-2');
    });
  });

  describe('close', () => {
    it('aborts all active turns', async () => {
      const signal1 = await manager.startTurn('turn-1');
      const signal2 = await manager.startTurn('turn-2');

      manager.close();

      expect(signal1.aborted).toBe(true);
      expect(signal2.aborted).toBe(true);
    });

    it('clears all active turns', async () => {
      await manager.startTurn('turn-1');
      manager.close();

      expect(manager.getActiveTurnIds()).toHaveLength(0);
    });
  });
});
