import { describe, expect, it } from 'vitest';

import { ChannelManager } from '../../../src/core/session/channel-manager.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';
import { createMockChannel, createMockRealtime } from '../../helper/mock-realtime.js';

const makeChannelManager = (channelName = 'session-1') => {
  const channel = createMockChannel();
  const realtime = createMockRealtime(channel);
  const logger = makeLogger({ logLevel: LogLevel.Silent });
  const manager = new ChannelManager(realtime, channelName, logger);
  return { manager, realtime, channel };
};

describe('ChannelManager', () => {
  it('lazily resolves the channel on first get()', () => {
    const { manager, realtime } = makeChannelManager('session-1');

    expect(realtime.channels.get).not.toHaveBeenCalled();

    manager.get();

    expect(realtime.channels.get).toHaveBeenCalledTimes(1);
    expect(realtime.channels.get).toHaveBeenCalledWith('session-1');
  });

  it('returns the same channel on repeated get() calls', () => {
    const { manager, realtime } = makeChannelManager();

    const first = manager.get();
    const second = manager.get();

    expect(first).toBe(second);
    expect(realtime.channels.get).toHaveBeenCalledTimes(1);
  });

  it('release() releases the resolved channel from the realtime client', () => {
    const { manager, realtime } = makeChannelManager('session-1');
    manager.get();

    manager.release();

    expect(realtime.channels.release).toHaveBeenCalledTimes(1);
    expect(realtime.channels.release).toHaveBeenCalledWith('session-1');
  });

  it('release() is a no-op when get() has not been called', () => {
    const { manager, realtime } = makeChannelManager();

    manager.release();

    expect(realtime.channels.release).not.toHaveBeenCalled();
  });

  it('after release(), get() resolves the channel again', () => {
    const { manager, realtime } = makeChannelManager();
    manager.get();
    manager.release();

    manager.get();

    expect(realtime.channels.get).toHaveBeenCalledTimes(2);
  });

  describe('isResolved', () => {
    it('is false before get()', () => {
      const { manager } = makeChannelManager();
      expect(manager.isResolved).toBe(false);
    });

    it('is true after get()', () => {
      const { manager } = makeChannelManager();
      manager.get();
      expect(manager.isResolved).toBe(true);
    });

    it('returns to false after release()', () => {
      const { manager } = makeChannelManager();
      manager.get();
      manager.release();
      expect(manager.isResolved).toBe(false);
    });
  });
});
