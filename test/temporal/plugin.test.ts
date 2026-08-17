/**
 * Plugin wiring tests. The activities themselves are covered by
 * `activities.test.ts` and the scaffold by `run-activity.test.ts`; what matters
 * here is what the plugin does to a worker's options, and that it owns the pooled
 * Ably connections for exactly as long as the worker runs.
 */

import '../helper/expectations.js';

import type { Worker, WorkerOptions } from '@temporalio/worker';
import type * as Ably from 'ably';
import { describe, expect, it, vi } from 'vitest';

import type { Codec } from '../../src/core/codec/types.js';
import { ErrorCode } from '../../src/errors.js';
import { createAblyTransportPlugin } from '../../src/temporal/plugin.js';

// The `runWorker` cases drive a framing activity, which reads the activity
// context for its cancellation signal and its heartbeat.
vi.mock('@temporalio/activity', () => ({
  Context: {
    current: vi.fn(() => ({
      cancellationSignal: new AbortController().signal,
      heartbeat: vi.fn(),
      info: { activityId: '1', heartbeatTimeoutMs: 10_000 },
    })),
  },
}));

interface TestMessage {
  id: string;
}
type TestCodec = Codec<{ kind: 'input' }, { type: 'output' }, { messages: TestMessage[] }, TestMessage>;

// CAST: the plugin never reads the codec; it hands it to the activity closures.
const codec = { adapterTag: 'test' } as unknown as TestCodec;
const createClient = (): Ably.Realtime => {
  throw new Error('not called in these tests');
};

const plugin = (): ReturnType<typeof createAblyTransportPlugin> => createAblyTransportPlugin({ codec, createClient });

// CAST: configureWorker only reads and returns `activities`; the rest of
// WorkerOptions is irrelevant here.
const workerOptions = (activities?: Record<string, unknown>): WorkerOptions => ({
  taskQueue: 'test',
  ...(activities && { activities }),
});

/**
 * The registered `openRun`, which leases from the same pool every activity
 * uses. Driving the framing activity rather than a wrapped body shows the pool
 * serves both halves.
 * @param configured - The plugin under test.
 * @returns The registered `openRun` activity.
 */
const registeredOpenRun = (configured: ReturnType<typeof plugin>): (() => Promise<unknown>) => {
  const activities = configured.configureWorker(workerOptions()).activities as Record<
    string,
    (input: unknown) => Promise<unknown>
  >;
  const openRun = activities.openRun;
  if (openRun === undefined) throw new Error('openRun was not registered');
  return async () =>
    openRun({
      invocation: { inputEventId: 'evt-1', sessionName: 'ai:room-7' },
      invocationId: 'wf-1',
    });
};

describe('createAblyTransportPlugin', () => {
  it('identifies itself', () => {
    expect(plugin().name).toBe('@ably/ai-transport');
  });

  it('registers the four framing activities', () => {
    const configured = plugin().configureWorker(workerOptions());

    expect(Object.keys(configured.activities ?? {}).toSorted()).toEqual([
      'cleanupRun',
      'endRun',
      'openRun',
      'suspendRun',
    ]);
  });

  it('adds to the consumer activities rather than replacing them', () => {
    const mine = vi.fn();
    const configured = plugin().configureWorker(workerOptions({ runInferenceStep: mine }));

    // CAST: WorkerOptions types `activities` as `object`; these tests read keys off it.
    const registered = configured.activities as Record<string, unknown> | undefined;
    expect(registered?.runInferenceStep).toBe(mine);
    expect(registered?.openRun).toBeTypeOf('function');
  });

  it('preserves every other worker option', () => {
    const configured = plugin().configureWorker(workerOptions());

    expect(configured.taskQueue).toBe('test');
  });

  it('does not implement configureReplayWorker, which runs no activities', () => {
    expect(Reflect.has(plugin(), 'configureReplayWorker')).toBe(false);
  });

  it('rejects options with no body, which the overloads make unreachable from TypeScript', () => {
    const configured = plugin();
    // CAST: reachable from JavaScript, and from a caller who has lost the types.
    const untyped = configured.activity.bind(configured) as unknown as (options: unknown) => unknown;

    expect(() => untyped({ history: 'full' })).toThrowErrorInfoWithCode(ErrorCode.InvalidArgument);
  });
});

describe('runWorker', () => {
  // CAST: `runWorker` hands the worker straight to `next` without reading it.
  const fakeWorker = {} as Worker;

  it('runs the worker, then closes the pool so no later activity can lease a connection', async () => {
    const configured = plugin();
    const openRun = registeredOpenRun(configured);
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- stands in for worker.run()
    const next = vi.fn(() => Promise.resolve());

    await configured.runWorker(fakeWorker, next);

    expect(next).toHaveBeenCalledWith(fakeWorker);
    await expect(openRun()).rejects.toBeErrorInfoWithCode(ErrorCode.SessionClosed);
  });

  it('closes the pool even when the worker fails, and surfaces the failure', async () => {
    const configured = plugin();
    const openRun = registeredOpenRun(configured);
    const failure = new Error('worker died');

    await expect(
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- stands in for a failing worker.run()
      configured.runWorker(fakeWorker, () => Promise.reject(failure)),
    ).rejects.toBe(failure);

    await expect(openRun()).rejects.toBeErrorInfoWithCode(ErrorCode.SessionClosed);
  });
});
