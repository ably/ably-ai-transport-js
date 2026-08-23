/**
 * Plugin registration tests. The activities themselves are covered by
 * `activities.test.ts`; what matters here is what `configureWorker` does to a
 * worker's options.
 */

import type { WorkerOptions } from '@temporalio/worker';
import type * as Ably from 'ably';
import { describe, expect, it, vi } from 'vitest';

import type { Codec } from '../../src/core/transport/session-codec.js';
import { createAblyTransportPlugin } from '../../src/temporal/plugin.js';

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
});
