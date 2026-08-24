/**
 * createRunStepWriter unit tests.
 *
 * The writer seeds its optimistic step-start / step-end through the injected
 * `emitStepLifecycle` callback and resolves each step's sticky `stepClientId`
 * through its precedence ladder (explicit option, in-process cursor, then the
 * triggering input's publisher). These tests exercise those seams over a real
 * {@link createRunManager} and a minimal codec double.
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
  parentFallback: undefined,
  forkOf: undefined,
  regenerates: undefined,
  inputClientId: undefined,
  inputCodecMessageId: undefined,
});

/**
 * Build a writer over a real run manager, capturing the emitted step events.
 * @param overrides - Optional seams to override for a given test.
 * @param overrides.getAnchors - Step-writer anchors (parent, fork, input identity).
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
  });

  it('does not seed a step when the piped stream produces no output', async () => {
    const { writer, emitted } = setup();

    const result = await writer.pipe(streamOf<TestOutput>());

    expect(result.reason).toBe('complete');
    expect(emitted).toHaveLength(0);
  });
});
