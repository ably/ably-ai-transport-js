/**
 * Tests for the optional activity heartbeat pump wrapped around the framing
 * activities' history scans.
 *
 * Fake timers, because the pump is time-based: the point of each case is what
 * happens across an interval boundary, and a real 5s wait would be a clock in
 * a unit test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@temporalio/activity', () => ({
  Context: {
    current: vi.fn(),
  },
}));

import { Context } from '@temporalio/activity';

import { withHeartbeat } from '../../src/temporal/heartbeat.js';

// eslint-disable-next-line @typescript-eslint/unbound-method -- vi.mocked accepts the static method reference; it does not read `this`.
const currentMock = vi.mocked(Context.current);

const HEARTBEAT_INTERVAL_MS = 5000;

describe('withHeartbeat', () => {
  let heartbeat: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    heartbeat = vi.fn();
    // CAST: the pump reads only `heartbeat()` off the activity Context, so the
    // test supplies that one method rather than a whole Context.
    currentMock.mockReturnValue({ heartbeat } as unknown as ReturnType<typeof Context.current>);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('returns the body result and reports nothing when disabled', async () => {
    const result = await withHeartbeat(false, async () => await Promise.resolve('done'));

    expect(result).toBe('done');
    expect(currentMock).not.toHaveBeenCalled();
  });

  it('runs no timer when disabled, so a caller can wrap unconditionally', async () => {
    await withHeartbeat(false, async () => {
      await Promise.resolve();
    });

    // A pump left running past a disabled call would beat against whatever
    // activity ran next.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports progress while the body is still running', async () => {
    const { promise, resolve } = Promise.withResolvers<string>();
    const wrapped = withHeartbeat(true, async () => await promise);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2);
    expect(heartbeat).toHaveBeenCalledTimes(2);

    resolve('done');
    expect(await wrapped).toBe('done');
  });

  it('stops the pump once the body settles', async () => {
    await withHeartbeat(true, async () => {
      await Promise.resolve();
    });

    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops the pump when the body throws, and propagates the error', async () => {
    const boom = new Error('scan failed');

    await expect(withHeartbeat(true, async () => await Promise.reject(boom))).rejects.toThrow(boom);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps running when a heartbeat throws', async () => {
    // A heartbeat outside an activity context, or on an activity Temporal has
    // already given up on, must not fail the work it was wrapping.
    currentMock.mockImplementation(() => {
      throw new Error('not in an activity context');
    });
    const { promise, resolve } = Promise.withResolvers<string>();
    const wrapped = withHeartbeat(true, async () => await promise);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2);

    resolve('done');
    expect(await wrapped).toBe('done');
  });
});
