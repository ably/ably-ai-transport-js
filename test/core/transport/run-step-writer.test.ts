/**
 * createRunStepWriter unit tests — the run's write path.
 *
 * The writer seeds its optimistic step-start / step-end through the injected
 * `emitStepLifecycle` callback and resolves each step's sticky `stepClientId`
 * through its precedence ladder (explicit option, in-process cursor, then the
 * triggering input's publisher). These tests exercise those seams over a real
 * {@link createRunManager} and a minimal codec double, covering step identity,
 * the one-active-step latch, and the reason a bracket closes with.
 */

import '../../helper/expectations.js';

import type * as Ably from 'ably';
import { describe, expect, it } from 'vitest';

import type { ChannelWriter, Encoder, EncoderOptions, WireCodec } from '../../../src/core/codec/types.js';
import { createRunManager } from '../../../src/core/transport/run-manager.js';
import type { RunStepWriterContext, StepWriterAnchors } from '../../../src/core/transport/run-step-writer.js';
import { createRunStepWriter, stepEndReasonFor } from '../../../src/core/transport/run-step-writer.js';
import type { StepLifecycleEvent } from '../../../src/core/transport/types.js';
import { ErrorCode } from '../../../src/errors.js';
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
 * @param overrides.getAnchors - Step-writer anchors (input identity).
 * @param overrides.codec - Codec to publish through; defaults to one that always succeeds.
 * @returns The writer under test, the captured step events, and the mock channel.
 */
const setup = (overrides?: {
  getAnchors?: () => StepWriterAnchors;
  codec?: WireCodec<TestInput, TestOutput>;
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
    codec: overrides?.codec ?? createMockCodec(),
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

/**
 * A codec whose encoder rejects every publish, to drive the failure paths.
 * @returns A codec whose every publish rejects with `publish boom`.
 */
const createFailingCodec = (): WireCodec<TestInput, TestOutput> => ({
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
});

describe('createRunStepWriter', () => {
  it('rejects pipe and send on a step that is not active', async () => {
    const { writer } = setup();

    // Before start(): the step is initialized, not active.
    const unstarted = writer.createStep();
    await expect(unstarted.pipe(streamOf<TestOutput>({ type: 'text' }))).rejects.toBeErrorInfoWithCode(
      ErrorCode.InvalidArgument,
    );

    // After end(): the step is settled, not active.
    const ended = writer.createStep();
    await ended.start();
    await ended.end();
    await expect(ended.send({ type: 'text' })).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
  });

  it('a send publish failure marks the step failed, so a bare end() settles failed', async () => {
    const { writer, emitted } = setup({ codec: createFailingCodec() });

    const step = writer.createStep();
    await step.start();
    await expect(step.send({ type: 'text', text: 'hi' })).rejects.toThrow('publish boom');
    await step.end();

    // end() derives the reason from what the step published, so a caller that
    // swallowed the send failure still reports the step honestly.
    const end = emitted.find((event) => event.type === 'step-end');
    expect(end).toMatchObject({ type: 'step-end', reason: 'failed' });
  });

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
  });

  describe('step identity', () => {
    it('uses an explicit stepId over the minted default', async () => {
      const { writer, emitted } = setup();

      const step = writer.createStep({ stepId: 'retry-me' });
      await step.start();
      await step.end();

      expect(step.stepId).toBe('retry-me');
      expect(emitted[0]).toMatchObject({ type: 'step-start', stepId: 'retry-me' });
    });

    it('uses an explicit stepClientId over the sticky one', async () => {
      const { writer, emitted } = setup();

      // Seed the in-process cursor, then override it on the next step.
      const first = writer.createStep({ stepClientId: 'prior-client' });
      await first.start();
      await first.end();

      const step = writer.createStep({ stepClientId: 'explicit-client' });
      await step.start();
      await step.end();

      expect(emitted.at(-2)).toMatchObject({ type: 'step-start', stepClientId: 'explicit-client' });
    });

    it('mints a monotonic id scoped to the invocation', async () => {
      const { writer } = setup();

      const first = writer.createStep();
      await first.start();
      await first.end();
      const second = writer.createStep();

      // Scoped to the invocation so steps from a later invocation of the same
      // run cannot collide with these and supersede them.
      expect(first.stepId).toBe('inv-1-step-0');
      expect(second.stepId).toBe('inv-1-step-1');
    });

    it('coalesces a retry onto the failed step id', async () => {
      const { writer } = setup();

      const failed = writer.createStep();
      await failed.start();
      await failed.end({ reason: 'failed' });
      const retry = writer.createStep();

      // Same id, so the later attempt supersedes the dead one rather than
      // appearing beside it.
      expect(retry.stepId).toBe(failed.stepId);
    });

    it('does not coalesce onto a step that completed', async () => {
      const { writer } = setup();

      const done = writer.createStep();
      await done.start();
      await done.end();
      const next = writer.createStep();

      expect(next.stepId).not.toBe(done.stepId);
    });

    it('keeps the stepClientId sticky across consecutive steps', async () => {
      const { writer, emitted } = setup();

      const first = writer.createStep({ stepClientId: 'client-a' });
      await first.start();
      await first.end();
      const second = writer.createStep();
      await second.start();
      await second.end();

      expect(emitted.findLast((e) => e.type === 'step-start')).toMatchObject({ stepClientId: 'client-a' });
    });
  });

  describe('the one-active-step latch', () => {
    it('rejects a second start while a step is open', async () => {
      const { writer } = setup();
      const step = writer.createStep();
      await step.start();

      await expect(writer.createStep().start()).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });

    it('rejects run.pipe while an explicit step is open', async () => {
      const { writer } = setup();
      const step = writer.createStep();
      await step.start();

      await expect(writer.pipe(streamOf<TestOutput>({ type: 'text', text: 'hi' }))).rejects.toBeErrorInfoWithCode(
        ErrorCode.InvalidArgument,
      );
    });
  });

  describe('step-end reason', () => {
    it('derives the bracket reason from the run terminal', () => {
      expect(stepEndReasonFor('complete')).toBe('complete');
      expect(stepEndReasonFor('cancelled')).toBe('cancelled');
      expect(stepEndReasonFor('error')).toBe('failed');
    });

    it('closes failed when the piped stream throws', async () => {
      const { writer, emitted } = setup();

      // The step opens lazily on the first output, so the stream has to
      // deliver something before it fails for there to be a bracket to close.
      let pulls = 0;
      const failing = new ReadableStream<TestOutput>({
        pull: (controller) => {
          pulls += 1;
          if (pulls === 1) {
            controller.enqueue({ type: 'text', text: 'partial' });
            return;
          }
          controller.error(new Error('model blew up'));
        },
      });
      const result = await writer.pipe(failing);

      expect(result.reason).toBe('error');
      expect(emitted.at(-1)).toMatchObject({ type: 'step-end', reason: 'failed' });
    });
  });

  it('does not seed a step when the piped stream produces no output', async () => {
    const { writer, emitted } = setup();

    const result = await writer.pipe(streamOf<TestOutput>());

    expect(result.reason).toBe('complete');
    expect(emitted).toHaveLength(0);
  });
});
