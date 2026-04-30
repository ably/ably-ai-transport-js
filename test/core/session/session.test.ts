import * as Ably from 'ably';
import { describe, expect, it, vi } from 'vitest';

import type { AnyCodec } from '../../../src/core/codec/index.js';
import type { SessionOptions } from '../../../src/core/session/index.js';
import { createAgentSession, createClientSession } from '../../../src/core/session/index.js';
import { ErrorCode } from '../../../src/errors.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';
import { VERSION } from '../../../src/version.js';
import {
  createMockChannel,
  createMockRealtime,
  type MockChannel,
  type MockRealtime,
} from '../../helper/mock-realtime.js';

/**
 * Drive a channel state-change event from a previous state of 'attached'.
 * @param channel The mock channel.
 * @param current The new channel state.
 * @param reason Optional reason attached to the state change.
 */
const drive = (channel: MockChannel & Ably.RealtimeChannel, current: Ably.ChannelState, reason?: Ably.ErrorInfo) => {
  channel.simulateStateChange({
    current,
    previous: 'attached',
    resumed: false,
    reason,
  } as Ably.ChannelStateChange);
};

// A bare codec stub — the session scaffold does not call any of these methods.
const stubCodec = {
  createEncoder: () => {
    throw new Error('not implemented');
  },
  createDecoder: () => {
    throw new Error('not implemented');
  },
  createAccumulator: () => {
    throw new Error('not implemented');
  },
} satisfies AnyCodec;

const makeSession = () => {
  const channel = createMockChannel();
  const realtime = createMockRealtime(channel);
  const logger = makeLogger({ logLevel: LogLevel.Silent });
  const options: SessionOptions<typeof stubCodec> = {
    client: realtime,
    sessionName: 'session-1',
    codec: stubCodec,
    logger,
  };
  return { options, realtime, channel };
};

describe('Session', () => {
  describe('construction', () => {
    it('exposes sessionName from options', () => {
      const { options } = makeSession();
      const session = createClientSession(options);
      expect(session.sessionName).toBe('session-1');
    });

    it('registers the agent string on the realtime client', () => {
      const { options, realtime } = makeSession();
      createClientSession(options);
      expect(realtime.options.agents?.['ai-transport-js']).toBe(VERSION);
    });

    it('preserves agents already registered by the host application', () => {
      const { options, realtime } = makeSession();
      (realtime as MockRealtime).options.agents = { other: '1.2.3' };
      createClientSession(options);
      expect(realtime.options.agents?.other).toBe('1.2.3');
      expect(realtime.options.agents?.['ai-transport-js']).toBe(VERSION);
    });

    it('createAgentSession produces an equivalent session handle', () => {
      const { options } = makeSession();
      const session = createAgentSession(options);
      expect(session.sessionName).toBe('session-1');
    });

    it('does not fetch the channel until connect() is called', () => {
      const { options, realtime } = makeSession();
      createClientSession(options);
      expect(realtime.channels.get).not.toHaveBeenCalled();
    });
  });

  describe('connect()', () => {
    it('attaches the channel and registers a state listener', async () => {
      const { options, realtime, channel } = makeSession();
      const session = createClientSession(options);

      await session.connect();

      expect(realtime.channels.get).toHaveBeenCalledWith('session-1');
      expect(channel.attach).toHaveBeenCalledTimes(1);
      expect(channel.on).toHaveBeenCalledTimes(1);
      const [events] = channel.on.mock.calls[0] as [Ably.ChannelEvent[], Ably.channelEventCallback];
      expect(new Set(events)).toEqual(new Set<Ably.ChannelEvent>(['failed', 'detached']));
    });

    it('is idempotent — concurrent calls share a single attach', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);

      const a = session.connect();
      const b = session.connect();
      await Promise.all([a, b]);

      expect(channel.attach).toHaveBeenCalledTimes(1);
    });

    it('is idempotent — sequential calls do not re-attach', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);

      await session.connect();
      await session.connect();

      expect(channel.attach).toHaveBeenCalledTimes(1);
    });

    it('clears the cached promise after a failed attach so retries can succeed', async () => {
      const { options, channel } = makeSession();
      const attachError = new Ably.ErrorInfo('attach failed', 90000, 500);
      channel.attach.mockRejectedValueOnce(attachError);
      const session = createClientSession(options);

      await expect(session.connect()).rejects.toBe(attachError);

      await session.connect();
      expect(channel.attach).toHaveBeenCalledTimes(2);
    });

    it('rejects if connect() is called after close()', async () => {
      const { options } = makeSession();
      const session = createClientSession(options);
      await session.close();

      await expect(session.connect()).rejects.toBeErrorInfoWithCode(ErrorCode.SessionClosed);
    });
  });

  describe('error events', () => {
    it('emits error when the channel transitions to failed', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);
      await session.connect();
      const handler = vi.fn();
      session.on('error', handler);

      const reason = new Ably.ErrorInfo('boom', 50000, 500);
      drive(channel, 'failed', reason);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(reason);
    });

    it('emits error when the channel transitions to detached unexpectedly', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);
      await session.connect();
      const handler = vi.fn();
      session.on('error', handler);

      const reason = new Ably.ErrorInfo('detached', 50000, 500);
      drive(channel, 'detached', reason);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(reason);
    });

    it('synthesises an error when the channel state change carries no reason', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);
      await session.connect();
      const handler = vi.fn();
      session.on('error', handler);

      drive(channel, 'failed');

      expect(handler).toHaveBeenCalledTimes(1);
      const arg = handler.mock.calls[0]?.[0] as unknown;
      expect(arg).toBeErrorInfo({ code: ErrorCode.TransportSubscriptionError });
    });

    it('isolates exceptions thrown from one handler so others still fire', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);
      await session.connect();
      const goodHandler = vi.fn();
      session.on('error', () => {
        throw new Error('handler exploded');
      });
      session.on('error', goodHandler);

      drive(channel, 'failed', new Ably.ErrorInfo('boom', 50000, 500));

      expect(goodHandler).toHaveBeenCalledTimes(1);
    });

    it('off() removes a handler', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);
      await session.connect();
      const handler = vi.fn();
      session.on('error', handler);
      session.off('error', handler);

      drive(channel, 'failed', new Ably.ErrorInfo('boom', 50000, 500));

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('close()', () => {
    it('detaches the channel and releases it', async () => {
      const { options, channel, realtime } = makeSession();
      const session = createClientSession(options);
      await session.connect();

      await session.close();

      expect(channel.detach).toHaveBeenCalledTimes(1);
      expect(realtime.channels.release).toHaveBeenCalledWith('session-1');
    });

    it('removes the state listener before detach so close-induced state changes do not fire error', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);
      await session.connect();
      const handler = vi.fn();
      session.on('error', handler);

      await session.close();
      // Simulate a detached event that might fire as part of the detach itself.
      channel.simulateStateChange({
        current: 'detached',
        previous: 'attached',
        resumed: false,
      } as Ably.ChannelStateChange);

      expect(handler).not.toHaveBeenCalled();
    });

    it('is idempotent', async () => {
      const { options, channel } = makeSession();
      const session = createClientSession(options);
      await session.connect();

      await session.close();
      await session.close();

      expect(channel.detach).toHaveBeenCalledTimes(1);
    });

    it('does not reject when channel.detach() throws', async () => {
      const { options, channel } = makeSession();
      channel.detach.mockRejectedValueOnce(new Ably.ErrorInfo('detach failed', 90000, 500));
      const session = createClientSession(options);
      await session.connect();

      await expect(session.close()).resolves.toBeUndefined();
    });

    it('can be called before connect() with no side effects', async () => {
      const { options, channel, realtime } = makeSession();
      const session = createClientSession(options);

      await session.close();

      expect(channel.attach).not.toHaveBeenCalled();
      expect(realtime.channels.release).not.toHaveBeenCalled();
    });
  });

  describe('Symbol.asyncDispose', () => {
    it('is equivalent to close()', async () => {
      const { options, channel, realtime } = makeSession();
      const session = createClientSession(options);
      await session.connect();

      await session[Symbol.asyncDispose]();

      expect(channel.detach).toHaveBeenCalledTimes(1);
      expect(realtime.channels.release).toHaveBeenCalledWith('session-1');
    });
  });
});
