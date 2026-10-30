import { describe, expect, it, vi } from 'vitest';

import { EventEmitter } from '../src/event-emitter.js';
import type { LogHandler } from '../src/logger.js';
import { LogLevel, makeLogger } from '../src/logger.js';

interface TestEvents {
  ping: { n: number };
  done: undefined;
}

const emitterWith = (logHandler: LogHandler = vi.fn()): EventEmitter<TestEvents> =>
  new EventEmitter<TestEvents>(makeLogger({ logLevel: LogLevel.Error, logHandler }));

describe('EventEmitter', () => {
  it('delivers the payload to a listener of that event only', () => {
    const emitter = emitterWith();
    const ping = vi.fn();
    const done = vi.fn();
    emitter.on('ping', ping);
    emitter.on('done', done);

    emitter.emit('ping', { n: 1 });

    expect(ping).toHaveBeenCalledWith({ n: 1 });
    expect(done).not.toHaveBeenCalled();
  });

  it('stops delivering to a listener after off', () => {
    const emitter = emitterWith();
    const ping = vi.fn();
    emitter.on('ping', ping);
    emitter.off('ping', ping);

    emitter.emit('ping', { n: 1 });

    expect(ping).not.toHaveBeenCalled();
  });

  it('keeps calling the other listeners when one throws, and logs the error', () => {
    const logHandler = vi.fn<LogHandler>();
    const emitter = emitterWith(logHandler);
    const boom = new Error('boom');
    const after = vi.fn();
    emitter.on('ping', () => {
      throw boom;
    });
    emitter.on('ping', after);

    emitter.emit('ping', { n: 1 });

    expect(after).toHaveBeenCalledWith({ n: 1 });
    expect(logHandler).toHaveBeenCalledWith('EventEmitter.emit(); listener threw', LogLevel.Error, { error: boom });
  });
});
