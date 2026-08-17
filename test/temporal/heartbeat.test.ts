/**
 * Heartbeat pump tests.
 *
 * The pump is what makes activity cancellation reach the work, so the interesting
 * properties are that it reports at all, that it reports often enough for the
 * activity's declared timeout, and that it cannot take the body down with it.
 *
 * Fake timers throughout: the pump is a `setInterval`, and the alternative is
 * sleeping in a test.
 */

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { withHeartbeat } from '../../src/temporal/heartbeat.js';

/**
 * The activity context the mock serves, mutable so each test can set what the
 * activity declared. Hoisted, because `vi.mock`'s factory runs before the module
 * body.
 */
const context = vi.hoisted(() => ({
  heartbeat: undefined as unknown as () => void,
  heartbeatTimeoutMs: undefined as number | undefined,
  available: true,
}));

vi.mock('@temporalio/activity', () => ({
  Context: {
    current: (): unknown => {
      if (!context.available) throw new Error('Activity context not initialized');
      return { heartbeat: context.heartbeat, info: { heartbeatTimeoutMs: context.heartbeatTimeoutMs } };
    },
  },
}));

/**
 * A body that never settles, so the body is still running while time passes.
 * @returns A promise that never settles.
 */
// eslint-disable-next-line @typescript-eslint/promise-function-async -- returns a promise that never settles
const pending = (): Promise<never> =>
  new Promise<never>(() => {
    /* deliberately never settles */
  });

let heartbeat: Mock<() => void>;

beforeEach(() => {
  vi.useFakeTimers();
  heartbeat = vi.fn<() => void>();
  context.heartbeat = heartbeat;
  context.heartbeatTimeoutMs = undefined;
  context.available = true;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('withHeartbeat', () => {
  it('reports on half the declared timeout while the body runs', async () => {
    context.heartbeatTimeoutMs = 10_000;

    void withHeartbeat(pending);
    await vi.advanceTimersByTimeAsync(15_000);

    // Half of 10s is 5s, so three reports land in 15s.
    expect(heartbeat).toHaveBeenCalledTimes(3);
  });

  it('reports every 5 seconds when the activity declares no timeout', async () => {
    void withHeartbeat(pending);
    await vi.advanceTimersByTimeAsync(11_000);

    expect(heartbeat).toHaveBeenCalledTimes(2);
  });

  it('treats a zero timeout as undeclared', async () => {
    context.heartbeatTimeoutMs = 0;

    void withHeartbeat(pending);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(heartbeat).toHaveBeenCalledTimes(1);
  });

  it('floors the interval at a second, so a tiny timeout cannot spin the pump', async () => {
    context.heartbeatTimeoutMs = 100;

    void withHeartbeat(pending);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(heartbeat).toHaveBeenCalledTimes(2);
  });

  it('stops reporting once the body resolves', async () => {
    context.heartbeatTimeoutMs = 10_000;

    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock body with no awaitable work
    await expect(withHeartbeat(() => Promise.resolve('done'))).resolves.toBe('done');
    await vi.advanceTimersByTimeAsync(30_000);

    expect(heartbeat).not.toHaveBeenCalled();
  });

  it('stops reporting once the body throws', async () => {
    context.heartbeatTimeoutMs = 10_000;
    const failure = new Error('body exploded');

    await expect(
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock body with no awaitable work
      withHeartbeat(() => Promise.reject(failure)),
    ).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(heartbeat).not.toHaveBeenCalled();
  });

  it('does not fail the body when there is no activity context', async () => {
    context.available = false;

    const running = withHeartbeat(pending);
    await vi.advanceTimersByTimeAsync(15_000);

    // Nothing escaped the pump, so the body is still running.
    await expect(Promise.race([running, Promise.resolve('still running')])).resolves.toBe('still running');
  });

  it('warns once that a cancellation cannot arrive when reporting fails', async () => {
    context.heartbeatTimeoutMs = 10_000;
    heartbeat.mockImplementation(() => {
      throw new Error('activity already gone');
    });
    const logger = { warn: vi.fn() };

    // CAST: the pump calls only `warn` on the logger.
    void withHeartbeat(pending, logger as unknown as Parameters<typeof withHeartbeat>[1]);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(heartbeat).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
