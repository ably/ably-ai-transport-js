/**
 * createRunStepWriter unit tests — the per-run write path.
 *
 * The writer seeds its optimistic step-start / step-end through the injected
 * `emitStepLifecycle` callback and resolves the sticky `stepClientId` from its
 * in-process cursor. These tests exercise those seams over a real
 * {@link createRunManager} and a minimal codec double, so a break in the
 * optimistic bracket or the step-client-id ladder is caught here.
 */

import type * as Ably from 'ably';
import { describe, expect, it } from 'vitest';

import type { ChannelWriter, Encoder, EncoderOptions, WireCodec } from '../../../src/core/codec/types.js';
import { createRunManager } from '../../../src/core/transport/run-manager.js';
import type { RunStepWriterContext, StepWriterAnchors } from '../../../src/core/transport/run-step-writer.js';
import { createRunStepWriter } from '../../../src/core/transport/run-step-writer.js';
import type { StepLifecycleEvent } from '../../../src/core/transport/types.js';
import { createMockChannel, type MockChannel } from '../../helper/mock-channel.js';
import { createMockEncoder } from '../../helper/mock-encoder.js';
import { streamOf } from '../../helper/streams.js';

interface TestInput {
  kind: 'user-message';
  message: { id: string; content: string };
}
interface TestOutput {
  type: string;
  text?: string;
}

const createMockCodec = (): WireCodec<TestInput, TestOutput> => ({
  createEncoder: (_channel: ChannelWriter, opts?: EncoderOptions): Encoder<TestInput, TestOutput> =>
    createMockEncoder<TestInput, TestOutput>(opts),
  createDecoder: () => ({ decode: () => ({ inputs: [], outputs: [] }) }),
});

const noAnchors = (): StepWriterAnchors => ({
  inputClientId: undefined,
  inputTransportMessageId: undefined,
});

/**
 * Build a writer over a real run manager, capturing the emitted step events.
 * @param overrides - Optional seams to override for a given test.
 * @param overrides.getAnchors - Step-writer anchors (the triggering input's identity).
 * @returns The writer under test, the captured step events, and the mock channel.
 */
const setup = (overrides?: {
  getAnchors?: () => StepWriterAnchors;
}): {
  writer: ReturnType<typeof createRunStepWriter<TestInput, TestOutput>>;
  emitted: StepLifecycleEvent[];
  channel: MockChannel & Ably.RealtimeChannel;
} => {
  const channel = createMockChannel();
  const emitted: StepLifecycleEvent[] = [];
  const ctx: RunStepWriterContext<TestInput, TestOutput> = {
    getRunId: () => 'run-1',
    invocationId: 'inv-1',
    codec: createMockCodec(),
    channel,
    runManager: createRunManager(channel),
    emitStepLifecycle: (event) => emitted.push(event),
    hooks: {},
    signal: new AbortController().signal,
    logger: undefined,
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    requireConnected: () => Promise.resolve(),
    assertPublishable: () => {
      /* always publishable in tests */
    },
    getAnchors: overrides?.getAnchors ?? noAnchors,
  };
  return { writer: createRunStepWriter(ctx), emitted, channel };
};

describe('createRunStepWriter', () => {
  it('seeds an optimistic step-start then step-end via emitStepLifecycle', async () => {
    const { writer, emitted } = setup();

    const result = await writer.pipe(streamOf<TestOutput>({ type: 'text', text: 'hi' }));

    expect(result.reason).toBe('complete');
    expect(emitted).toHaveLength(2);
    const [start, end] = emitted;
    // The step-start's serial is the `ai-step-start` publish serial (the
    // attempt's identity), threaded back from the run manager.
    expect(start).toMatchObject({ type: 'step-start', runId: 'run-1', invocationId: 'inv-1', serial: 'serial-1' });
    expect(end).toMatchObject({ type: 'step-end', runId: 'run-1', stepStartSerial: 'serial-1', reason: 'complete' });
  });

  it('falls back to the triggering input publisher when no prior step exists', async () => {
    const { writer, emitted } = setup({
      getAnchors: () => ({ ...noAnchors(), inputClientId: 'input-client' }),
    });

    await writer.pipe(streamOf<TestOutput>({ type: 'text', text: 'hi' }));

    expect(emitted[0]).toMatchObject({ type: 'step-start', stepClientId: 'input-client' });
    expect(emitted[1]).toMatchObject({ type: 'step-end', stepClientId: 'input-client' });
  });

  it('does not seed a step when the piped stream produces no output', async () => {
    const { writer, emitted } = setup();

    const result = await writer.pipe(streamOf<TestOutput>());

    expect(result.reason).toBe('complete');
    expect(emitted).toHaveLength(0);
  });

  it('rejects a second step start while one is already active', async () => {
    const { writer } = setup();

    const first = writer.createStep();
    await first.start();
    const second = writer.createStep();

    await expect(second.start()).rejects.toBeErrorInfo({
      code: 40003,
      message: 'unable to start step; another step is already active on this run',
    });
  });

  it('rejects run.pipe while an explicit step is active', async () => {
    const { writer } = setup();

    const step = writer.createStep();
    await step.start();

    await expect(writer.pipe(streamOf<TestOutput>({ type: 'text' }))).rejects.toBeErrorInfo({
      code: 40003,
      message: 'unable to pipe; a step is already active on this run (end it first)',
    });
  });

  it('rejects pipe and send on a step that is not active', async () => {
    const { writer } = setup();

    // Before start(): the step is initialized, not active.
    const unstarted = writer.createStep();
    await expect(unstarted.pipe(streamOf<TestOutput>({ type: 'text' }))).rejects.toBeErrorInfoWithCode(40003);

    // After end(): the step is settled, not active.
    const ended = writer.createStep();
    await ended.start();
    await ended.end();
    await expect(ended.send({ type: 'text' })).rejects.toBeErrorInfoWithCode(40003);
  });

  it("coalesces an in-process retry: a failed step's next default id reuses the step-id", async () => {
    const { writer } = setup();

    const failed = writer.createStep();
    await failed.start();
    await failed.end({ reason: 'failed' });

    // The retry (no explicit id) reuses the failed step's id, so the fresh
    // attempt supersedes it rather than opening a sibling step.
    const retry = writer.createStep();
    expect(retry.stepId).toBe(failed.stepId);

    // Once an attempt completes, the next default id moves on.
    await retry.start();
    await retry.end({ reason: 'complete' });
    const next = writer.createStep();
    expect(next.stepId).not.toBe(failed.stepId);
  });

  it('a send publish failure marks the step failed, so a bare end() settles failed', async () => {
    const channel = createMockChannel();
    const emitted: StepLifecycleEvent[] = [];
    // A codec whose encoder rejects every output publish.
    const failingCodec: WireCodec<TestInput, TestOutput> = {
      createEncoder: () => ({
        // eslint-disable-next-line @typescript-eslint/require-await -- mock rejects
        publishInput: async () => {
          throw new Error('publish boom');
        },
        // eslint-disable-next-line @typescript-eslint/require-await -- mock rejects
        publishOutput: async () => {
          throw new Error('publish boom');
        },
        cancelStreams: async () => {
          /* no streams to cancel */
        },
        close: async () => {
          /* nothing to close */
        },
      }),
      createDecoder: () => ({ decode: () => ({ inputs: [], outputs: [] }) }),
    };
    const ctx: RunStepWriterContext<TestInput, TestOutput> = {
      getRunId: () => 'run-1',
      invocationId: 'inv-1',
      codec: failingCodec,
      channel,
      runManager: createRunManager(channel),
      emitStepLifecycle: (event) => emitted.push(event),
      hooks: {},
      signal: new AbortController().signal,
      logger: undefined,
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
      requireConnected: () => Promise.resolve(),
      assertPublishable: () => {
        /* always publishable in tests */
      },
      getAnchors: noAnchors,
    };
    const writer = createRunStepWriter(ctx);

    const step = writer.createStep();
    await step.start();
    await expect(step.send({ type: 'text', text: 'hi' })).rejects.toThrow('publish boom');
    await step.end();

    const end = emitted.find((event) => event.type === 'step-end');
    expect(end).toMatchObject({ type: 'step-end', reason: 'failed' });
  });
});
