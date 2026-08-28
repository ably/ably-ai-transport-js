/**
 * createAgentTransport unit tests — the standalone, Tree-free agent transport.
 *
 * The transport owns its receive path: `connect()` subscribes its listener and
 * attaches the channel, after which live wires classify onto the
 * `subscribe`/`on('event')` stream and `ai-cancel` envelopes route onto the
 * matching run handle's `abortSignal` (by run-id, by the triggering input's
 * codec-message-id, or from the deferred buffer when the cancel beat its
 * `openRun`). `openRun` publishes `ai-run-start` (or `ai-run-resume` for a
 * continuation) and returns a run handle whose `pipe` / `createStep` stream
 * output between an `ai-step-start` / `ai-step-end` bracket; the writer's
 * optimistic step-lifecycle seed is emitted on the transport's own receive
 * stream. `locateInput` scans channel history on a throwaway decoder to find
 * the input event a durable invocation resumes from. `history()` pages the
 * channel backwards on the live stream's decoder and returns each older slice
 * as a chronological batch — the batch walk itself is pinned in
 * history-walk.test.ts, so the history tests here cover only the transport's
 * wiring: no live emission, a cursor kept across calls, and decode failures
 * routed onto `error`. A steering message — a client input under an open
 * run's run-id — routes onto the run's steer tracking (`hasInput()`, the
 * `onSteer` hint, and the `steer-codec-message-ids` stamp on the next step
 * attempt), buffering pre-open arrivals; the run's terminal (`ai-run-end` /
 * `ai-run-suspend`) carries the `input-codec-message-ids` receipt naming the
 * trigger and every stamped steer once the run has produced output.
 * `close()` unsubscribes and is terminal. These tests pin that
 * contract against a mock channel and a minimal codec double, driving the
 * real `createRunManager` and `createRunStepWriter` underneath.
 */

import * as Ably from 'ably';
import { describe, expect, it } from 'vitest';

import {
  EVENT_CANCEL,
  HEADER_CODEC_MESSAGE_ID,
  HEADER_EVENT_ID,
  HEADER_INPUT_CODEC_MESSAGE_ID,
  HEADER_INPUT_CODEC_MESSAGE_IDS,
  HEADER_INVOCATION_ID,
  HEADER_PARENT,
  HEADER_RUN_ID,
  HEADER_STEER_CODEC_MESSAGE_IDS,
} from '../../../src/constants.js';
import type { ChannelWriter, Decoder, Encoder, EncoderOptions, WireCodec } from '../../../src/core/codec/types.js';
import { createAgentTransport } from '../../../src/core/transport/agent-transport.js';
import type { CancelRequest, LocatedInput, TransportEvent } from '../../../src/core/transport/types.js';
import { wireMetaFromMessage } from '../../../src/core/transport/wire-meta.js';
import { ErrorCode } from '../../../src/errors.js';
import { getTransportHeaders } from '../../../src/utils.js';
import { createMockChannel, type MockChannel } from '../../helper/mock-channel.js';
import { createMockEncoder } from '../../helper/mock-encoder.js';
import { flushMicrotasks, pausedStream, streamOf } from '../../helper/streams.js';
import { boomMsg, inboundMessage, outputMsg } from '../../helper/wire-messages.js';

interface TestInput {
  kind: string;
  content?: string;
}
interface TestOutput {
  type: string;
  text?: string;
}

type TestEvent = TransportEvent<TestInput, TestOutput>;

/**
 * A codec double whose decoder classifies by message name: `boom` throws (an
 * undecodable wire for the skip / error paths), `ai-output` yields one output
 * from the wire's data, `ai-input` yields the fixed input array so
 * `locateInput`'s decode step is observable, and anything else (a cancel
 * envelope) yields nothing.
 * @param decoded - The inputs the decoder yields for `ai-input` messages.
 * @returns The codec double.
 */
const createMockCodec = (decoded: TestInput[] = []): WireCodec<TestInput, TestOutput> => ({
  createEncoder: (_channel: ChannelWriter, opts?: EncoderOptions): Encoder<TestInput, TestOutput> =>
    createMockEncoder<TestInput, TestOutput>(opts),
  createDecoder: (): Decoder<TestInput, TestOutput> => ({
    decode: (msg: Ably.InboundMessage): { inputs: TestInput[]; outputs: TestOutput[] } => {
      if (msg.name === 'boom') throw new Error('malformed payload');
      if (msg.name === 'ai-output') {
        // CAST: the test wires carry string data.
        return { inputs: [], outputs: [{ type: 'out', text: msg.data as string }] };
      }
      if (msg.name === 'ai-input') {
        return { inputs: decoded, outputs: [] };
      }
      return { inputs: [], outputs: [] };
    },
  }),
});

const wireMsg = (headers: Record<string, string>): Ably.InboundMessage =>
  ({
    name: 'ai-input',
    action: 'message.create',
    serial: 'hist-serial',
    version: { serial: 'hist-serial', timestamp: 0 },
    extras: { ai: { transport: headers } },
  }) as unknown as Ably.InboundMessage;

/**
 * Build a {@link LocatedInput} whose meta carries the given transport headers —
 * the located-input fixture the openRun tests hand to the transport.
 * @param transport - The transport-tier headers on the input's wire message.
 * @returns The located input.
 */
const locatedInput = (transport: Record<string, string>): LocatedInput<unknown> => ({
  meta: wireMetaFromMessage(inboundMessage({ name: 'ai-input', transport, serial: 'trigger-serial' })),
  inputs: [],
});

/**
 * Build an inbound `ai-cancel` envelope carrying the given transport headers.
 * @param headers - The transport-tier headers naming the cancel's target.
 * @returns The wire message.
 */
const cancelMsg = (headers: Record<string, string>): Ably.InboundMessage =>
  // CAST: cancels route by header; the fold reads name/extras/version only.
  ({
    name: EVENT_CANCEL,
    action: 'message.create',
    extras: { ai: { transport: { [HEADER_EVENT_ID]: 'cancel-evt', ...headers } } },
    version: {},
  }) as unknown as Ably.InboundMessage;

/**
 * Build an inbound steering wire: a client input under a run's run-id.
 * @param runId - The run the steer targets.
 * @param codecMessageId - The steering message's codec-message-id.
 * @returns The wire message.
 */
const steerMsg = (runId: string, codecMessageId: string): Ably.InboundMessage =>
  wireMsg({ [HEADER_RUN_ID]: runId, [HEADER_CODEC_MESSAGE_ID]: codecMessageId });

/**
 * Read the steer stamp the writer put on a published output message.
 * @param message - The message the per-run `onAblyMessage` hook observed.
 * @returns The raw `steer-codec-message-ids` header, or `undefined`.
 */
const steerStampOf = (message: Ably.Message): string | undefined =>
  // CAST: the hook observes the outbound message; only its extras are read.
  getTransportHeaders(message as Ably.InboundMessage)[HEADER_STEER_CODEC_MESSAGE_IDS];

/**
 * Read the input receipt off a published run lifecycle message.
 * @param channel - The mock channel that captured the publish.
 * @param name - The lifecycle message name (`ai-run-end` or `ai-run-suspend`).
 * @returns The raw `input-codec-message-ids` header, or `undefined`.
 */
const receiptOf = (channel: MockChannel, name: string): string | undefined => {
  const msg = channel.publishCalls.find((m) => m.name === name);
  if (!msg) throw new Error(`expected ${name}`);
  // CAST: the mock captured the outbound message; only its extras are read.
  return getTransportHeaders(msg as Ably.InboundMessage)[HEADER_INPUT_CODEC_MESSAGE_IDS];
};

/**
 * Build an agent transport over the mocks, subscribing collectors for events
 * and errors, and connect it unless told otherwise.
 * @param opts - Optional test overrides.
 * @param opts.clientId - The agent's clientId, stamped on the run lifecycle.
 * @param opts.decoded - The inputs the codec decoder yields for `ai-input` messages.
 * @param opts.historyPages - The channel-history pages `locateInput` and `history` walk (newest first).
 * @param opts.connect - Set false to leave the transport unconnected.
 * @returns The transport, the mocks, and the collected streams.
 */
const setup = async (opts?: {
  clientId?: string;
  decoded?: TestInput[];
  historyPages?: Ably.InboundMessage[][];
  connect?: boolean;
}): Promise<{
  transport: ReturnType<typeof createAgentTransport<TestInput, TestOutput>>;
  channel: MockChannel & Ably.RealtimeChannel;
  events: TestEvent[];
  errors: Ably.ErrorInfo[];
}> => {
  const channel = createMockChannel(opts?.historyPages);
  const transport = createAgentTransport<TestInput, TestOutput>({
    channel,
    codec: createMockCodec(opts?.decoded),
    clientId: opts?.clientId,
  });
  const events: TestEvent[] = [];
  transport.subscribe((event) => events.push(event));
  const errors: Ably.ErrorInfo[] = [];
  transport.on('error', (err) => errors.push(err));
  if (opts?.connect !== false) await transport.connect();
  return { transport, channel, events, errors };
};

describe('createAgentTransport', () => {
  describe('connect', () => {
    it('subscribes the transport listener and attaches the channel', async () => {
      const { channel } = await setup();

      expect(channel.subscribe).toHaveBeenCalledTimes(1);
      expect(channel.attach).toHaveBeenCalledTimes(1);
      expect(channel.listener).toBeDefined();
    });

    it('is single-flight across concurrent calls', async () => {
      const { transport, channel } = await setup({ connect: false });

      await Promise.all([transport.connect(), transport.connect()]);
      await transport.connect();

      expect(channel.subscribe).toHaveBeenCalledTimes(1);
    });

    it('emits error and rejects when subscribe fails', async () => {
      const { transport, channel, errors } = await setup({ connect: false });
      channel.subscribe.mockRejectedValueOnce(new Error('subscribe blew up'));

      await expect(transport.connect()).rejects.toMatchObject({
        code: ErrorCode.SessionSubscriptionFailed,
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeErrorInfoWithCode(ErrorCode.SessionSubscriptionFailed);
    });

    it('gates history and locateInput until connect() is called', async () => {
      const { transport } = await setup({ connect: false });

      await expect(transport.history()).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
      await expect(transport.locateInput('evt-1')).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    });

    it('openRun throws synchronously before connect() is called', async () => {
      const { transport } = await setup({ connect: false });

      expect(() => transport.openRun()).toThrowErrorInfo({ code: ErrorCode.InvalidArgument });
    });
  });

  describe('live delivery', () => {
    it('classifies an inbound wire onto the subscribe stream', async () => {
      const { channel, events } = await setup();

      channel.listener?.(outputMsg('s1', 'hello'));

      expect(events).toHaveLength(1);
      const event = events[0];
      if (event?.kind !== 'message') throw new Error('expected message event');
      expect(event.outputs).toEqual([{ type: 'out', text: 'hello' }]);
      expect(event.meta.serial).toBe('s1');
      expect(event.meta.runId).toBe('R1');
    });

    it('drops an undecodable wire onto error', async () => {
      const { channel, events, errors } = await setup();

      channel.listener?.(boomMsg('s1'));

      expect(events).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeErrorInfoWithCode(ErrorCode.SessionMessageProcessingFailed);
    });
  });

  describe('cancel routing', () => {
    it('aborts the run handle when a cancel names its run-id', async () => {
      const { transport, channel } = await setup();

      const run = transport.openRun({ runId: 'run-1' });
      channel.listener?.(cancelMsg({ [HEADER_RUN_ID]: 'run-1' }));
      await flushMicrotasks();

      expect(run.abortSignal.aborted).toBe(true);
    });

    it('a pipe on a cancelled run resolves cancelled without a run terminal', async () => {
      const { transport, channel } = await setup();

      const run = transport.openRun({ runId: 'run-1' });
      channel.listener?.(cancelMsg({ [HEADER_RUN_ID]: 'run-1' }));
      await flushMicrotasks();

      const result = await run.pipe(pausedStream());

      expect(result.reason).toBe('cancelled');
      expect(channel.publishNames()).not.toContain('ai-run-end');
    });

    it('routes a fresh-send cancel by the triggering input codec-message-id', async () => {
      const { transport, channel } = await setup();

      const run = transport.openRun({ inputCodecMessageId: 'in-1' });
      channel.listener?.(cancelMsg({ [HEADER_INPUT_CODEC_MESSAGE_ID]: 'in-1' }));
      await flushMicrotasks();

      expect(run.abortSignal.aborted).toBe(true);
    });

    it('honours a cancel buffered before its openRun', async () => {
      const { transport, channel } = await setup();

      channel.listener?.(cancelMsg({ [HEADER_INPUT_CODEC_MESSAGE_ID]: 'in-1' }));
      await flushMicrotasks();
      const run = transport.openRun({ inputCodecMessageId: 'in-1' });
      await flushMicrotasks();

      expect(run.abortSignal.aborted).toBe(true);
    });

    it('does not buffer a bare run-id cancel for an unknown run', async () => {
      const { transport, channel } = await setup();

      channel.listener?.(cancelMsg({ [HEADER_RUN_ID]: 'run-later' }));
      await flushMicrotasks();
      const run = transport.openRun({ runId: 'run-later' });
      await flushMicrotasks();

      expect(run.abortSignal.aborted).toBe(false);
    });

    it('leaves the run running when onCancel returns false', async () => {
      const { transport, channel } = await setup();

      // eslint-disable-next-line @typescript-eslint/require-await -- mock hook
      const run = transport.openRun({ runId: 'run-1' }, { onCancel: async () => false });
      channel.listener?.(cancelMsg({ [HEADER_RUN_ID]: 'run-1' }));
      await flushMicrotasks();

      expect(run.abortSignal.aborted).toBe(false);
    });

    it('passes the cancel message and run-id to onCancel', async () => {
      const { transport, channel } = await setup();
      const requests: CancelRequest[] = [];

      const run = transport.openRun(
        { runId: 'run-1' },
        {
          // eslint-disable-next-line @typescript-eslint/require-await -- mock hook
          onCancel: async (request) => {
            requests.push(request);
            return true;
          },
        },
      );
      channel.listener?.(cancelMsg({ [HEADER_RUN_ID]: 'run-1' }));
      await flushMicrotasks();

      expect(requests).toHaveLength(1);
      expect(requests[0]?.runId).toBe('run-1');
      expect(requests[0]?.message.name).toBe(EVENT_CANCEL);
      expect(run.abortSignal.aborted).toBe(true);
    });

    it('surfaces a throwing onCancel as RunCancelHandlerFailed without aborting', async () => {
      const { transport, channel, errors } = await setup();

      const run = transport.openRun(
        { runId: 'run-1' },
        {
          // eslint-disable-next-line @typescript-eslint/require-await -- mock hook
          onCancel: async () => {
            throw new Error('hook blew up');
          },
        },
      );
      channel.listener?.(cancelMsg({ [HEADER_RUN_ID]: 'run-1' }));
      await flushMicrotasks();

      expect(run.abortSignal.aborted).toBe(false);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeErrorInfoWithCode(ErrorCode.RunCancelHandlerFailed);
    });

    it("routes a throwing onCancel to the run's onError instead of the error stream", async () => {
      const { transport, channel, errors } = await setup();
      const runErrors: Ably.ErrorInfo[] = [];

      const run = transport.openRun(
        { runId: 'run-1' },
        {
          // eslint-disable-next-line @typescript-eslint/require-await -- mock hook
          onCancel: async () => {
            throw new Error('hook blew up');
          },
          onError: (error) => runErrors.push(error),
        },
      );
      channel.listener?.(cancelMsg({ [HEADER_RUN_ID]: 'run-1' }));
      await flushMicrotasks();

      expect(run.abortSignal.aborted).toBe(false);
      expect(runErrors).toHaveLength(1);
      expect(runErrors[0]).toBeErrorInfoWithCode(ErrorCode.RunCancelHandlerFailed);
      expect(errors).toHaveLength(0);
    });

    it('isolates a throwing onError so cancel routing survives', async () => {
      const { transport, channel, errors } = await setup();

      const run = transport.openRun(
        { runId: 'run-1' },
        {
          // eslint-disable-next-line @typescript-eslint/require-await -- mock hook
          onCancel: async () => {
            throw new Error('hook blew up');
          },
          onError: () => {
            throw new Error('onError blew up');
          },
        },
      );
      channel.listener?.(cancelMsg({ [HEADER_RUN_ID]: 'run-1' }));
      await flushMicrotasks();

      // Nothing double-delivers to the error stream, and a later cancel for
      // another run still routes.
      expect(errors).toHaveLength(0);
      const other = transport.openRun({ runId: 'run-2' });
      channel.listener?.(cancelMsg({ [HEADER_RUN_ID]: 'run-2' }));
      await flushMicrotasks();
      expect(other.abortSignal.aborted).toBe(true);
      expect(run.abortSignal.aborted).toBe(false);
    });

    it("fires the run's onError with a wrapped StreamError when a pipe source fails", async () => {
      const { transport } = await setup();
      const runErrors: Ably.ErrorInfo[] = [];

      const run = transport.openRun({ runId: 'run-1' }, { onError: (error) => runErrors.push(error) });
      const failing = (async function* (): AsyncGenerator<TestOutput> {
        await flushMicrotasks();
        yield { type: 'out', text: 'a' };
        throw new Error('provider stream failed');
      })();
      const result = await run.pipe(failing);

      expect(result.reason).toBe('error');
      expect(result.error?.message).toBe('provider stream failed');
      expect(runErrors).toHaveLength(1);
      expect(runErrors[0]).toBeErrorInfoWithCode(ErrorCode.RunResponseStreamFailed);
    });

    it('drops a malformed cancel naming no target', async () => {
      const { transport, channel, errors } = await setup();

      const run = transport.openRun({ runId: 'run-1' });
      channel.listener?.(cancelMsg({}));
      await flushMicrotasks();

      expect(run.abortSignal.aborted).toBe(false);
      expect(errors).toHaveLength(0);
    });

    it('stops routing to a run once it has ended', async () => {
      const { transport, channel } = await setup();

      const run = transport.openRun({ runId: 'run-1' });
      await run.end({ reason: 'complete' });
      channel.listener?.(cancelMsg({ [HEADER_RUN_ID]: 'run-1' }));
      await flushMicrotasks();

      expect(run.abortSignal.aborted).toBe(false);
    });
  });

  describe('per-run hooks', () => {
    it('composes an external signal into the run abortSignal', async () => {
      const { transport } = await setup();
      const ctl = new AbortController();

      const run = transport.openRun({ runId: 'run-1' }, { signal: ctl.signal });
      expect(run.abortSignal.aborted).toBe(false);
      ctl.abort();

      expect(run.abortSignal.aborted).toBe(true);
    });

    it('abortSignal starts aborted when the external signal is already aborted', async () => {
      const { transport } = await setup();

      const run = transport.openRun({ runId: 'run-1' }, { signal: AbortSignal.abort() });

      expect(run.abortSignal.aborted).toBe(true);
    });

    it('a pipe ends cancelled when the external signal aborts', async () => {
      const { transport, channel } = await setup();
      const ctl = new AbortController();

      const run = transport.openRun({ runId: 'run-1' }, { signal: ctl.signal });
      const pipePromise = run.pipe(pausedStream());
      await flushMicrotasks();
      ctl.abort();
      const result = await pipePromise;

      expect(result.reason).toBe('cancelled');
      expect(channel.publishNames()).not.toContain('ai-run-end');
    });

    it('invokes onAblyMessage per published output message', async () => {
      const { transport } = await setup();
      const seen: string[] = [];

      const run = transport.openRun({ runId: 'run-1' }, { onAblyMessage: (message) => seen.push(message.name ?? '') });
      await run.pipe(streamOf({ type: 'out', text: 'a' }, { type: 'out', text: 'b' }));

      expect(seen).toEqual(['ai-output', 'ai-output']);
    });

    it('invokes onCancelled with a write for a final output when a cancel aborts a pipe', async () => {
      const { transport, channel } = await setup();
      const writes: TestOutput[] = [];

      const run = transport.openRun(
        { runId: 'run-1' },
        {
          onCancelled: async (write) => {
            const final: TestOutput = { type: 'out', text: 'final' };
            writes.push(final);
            await write(final);
          },
        },
      );
      const pipePromise = run.pipe(pausedStream());
      await flushMicrotasks();
      channel.listener?.(cancelMsg({ [HEADER_RUN_ID]: 'run-1' }));
      const result = await pipePromise;

      expect(result.reason).toBe('cancelled');
      expect(writes).toEqual([{ type: 'out', text: 'final' }]);
    });
  });

  describe('steering', () => {
    it('fires onSteer and flips hasInput for a live steering message', async () => {
      const { transport, channel } = await setup({ decoded: [{ kind: 'user' }] });
      let steers = 0;

      const run = transport.openRun({ runId: 'run-1' }, { onSteer: () => steers++ });
      await run.pipe(streamOf({ type: 'out' }));
      channel.listener?.(steerMsg('run-1', 'steer-1'));

      expect(steers).toBe(1);
      expect(run.hasInput()).toBe(true);
      // Reading drained the steer; nothing further is pending.
      expect(run.hasInput()).toBe(false);
    });

    it('never tracks the run triggering input as a steer', async () => {
      const { transport, channel } = await setup({ decoded: [{ kind: 'user' }] });
      let steers = 0;

      const run = transport.openRun({ runId: 'run-1', inputCodecMessageId: 'in-1' }, { onSteer: () => steers++ });
      await run.pipe(streamOf({ type: 'out' }));
      channel.listener?.(steerMsg('run-1', 'in-1'));

      expect(steers).toBe(0);
      expect(run.hasInput()).toBe(false);
    });

    it('hasInput reports the initial pass until output is produced, then follows steers', async () => {
      const { transport } = await setup();

      const run = transport.openRun({ runId: 'run-1' });
      expect(run.hasInput()).toBe(true);
      // Repeat reads before output keep reporting the initial pass.
      expect(run.hasInput()).toBe(true);

      await run.pipe(streamOf({ type: 'out' }));
      expect(run.hasInput()).toBe(false);
    });

    it('hasInput is false once the run abort signal has fired', async () => {
      const { transport } = await setup();

      const run = transport.openRun({ runId: 'run-1' }, { signal: AbortSignal.abort() });

      expect(run.hasInput()).toBe(false);
    });

    it('stamps drained steers on the next pipe, each id on exactly one attempt', async () => {
      const { transport, channel } = await setup({ decoded: [{ kind: 'user' }] });
      const stamps: (string | undefined)[] = [];

      const run = transport.openRun({ runId: 'run-1' }, { onAblyMessage: (m) => stamps.push(steerStampOf(m)) });
      await run.pipe(streamOf({ type: 'out' }));
      channel.listener?.(steerMsg('run-1', 'steer-1'));
      expect(run.hasInput()).toBe(true);
      await run.pipe(streamOf({ type: 'out' }));
      await run.pipe(streamOf({ type: 'out' }));

      expect(stamps).toEqual([undefined, JSON.stringify(['steer-1']), undefined]);
    });

    it('stamps drained steers on an explicit step send', async () => {
      const { transport, channel } = await setup({ decoded: [{ kind: 'user' }] });
      const stamps: (string | undefined)[] = [];

      const run = transport.openRun({ runId: 'run-1' }, { onAblyMessage: (m) => stamps.push(steerStampOf(m)) });
      await run.pipe(streamOf({ type: 'out' }));
      channel.listener?.(steerMsg('run-1', 'steer-1'));
      expect(run.hasInput()).toBe(true);
      const step = run.createStep();
      await step.send({ type: 'out' });
      await step.end({});

      expect(stamps).toEqual([undefined, JSON.stringify(['steer-1'])]);
    });

    it('seeds a steer buffered before its openRun and stamps it on the first pass', async () => {
      const { transport, channel } = await setup({ decoded: [{ kind: 'user' }] });
      let steers = 0;
      const stamps: (string | undefined)[] = [];

      channel.listener?.(steerMsg('run-1', 'steer-1'));
      const run = transport.openRun(
        { runId: 'run-1' },
        { onSteer: () => steers++, onAblyMessage: (m) => stamps.push(steerStampOf(m)) },
      );
      expect(steers).toBe(1);
      // The first pass's context already contains the buffered steer, so the
      // drain folds it into that pass and its outputs carry the stamp.
      expect(run.hasInput()).toBe(true);
      await run.pipe(streamOf({ type: 'out' }));

      expect(stamps).toEqual([JSON.stringify(['steer-1'])]);
      expect(run.hasInput()).toBe(false);
    });

    it('FIFO-evicts the oldest run pre-open buffer at the limit', async () => {
      const { transport, channel } = await setup({ decoded: [{ kind: 'user' }] });
      let steers = 0;

      channel.listener?.(steerMsg('run-evicted', 'steer-1'));
      for (let i = 0; i < 200; i++) {
        channel.listener?.(steerMsg(`run-fill-${String(i)}`, `steer-fill-${String(i)}`));
      }
      transport.openRun({ runId: 'run-evicted' }, { onSteer: () => steers++ });

      expect(steers).toBe(0);
    });

    it('tracks a steer arriving while the run is suspended', async () => {
      const { transport, channel } = await setup({ decoded: [{ kind: 'user' }] });
      let steers = 0;

      const run = transport.openRun({ runId: 'run-1' }, { onSteer: () => steers++ });
      await run.pipe(streamOf({ type: 'out' }));
      await run.suspend();
      channel.listener?.(steerMsg('run-1', 'steer-1'));
      await run.resume();

      expect(steers).toBe(1);
      expect(run.hasInput()).toBe(true);
    });

    it('stops tracking steers once the run has ended', async () => {
      const { transport, channel } = await setup({ decoded: [{ kind: 'user' }] });
      let steers = 0;

      const run = transport.openRun({ runId: 'run-1' }, { onSteer: () => steers++ });
      await run.end({ reason: 'complete' });
      channel.listener?.(steerMsg('run-1', 'steer-1'));

      expect(steers).toBe(0);
    });

    it('surfaces a throwing onSteer as CancelListenerError and keeps the steer tracked', async () => {
      const { transport, channel, errors } = await setup({ decoded: [{ kind: 'user' }] });

      const run = transport.openRun(
        { runId: 'run-1' },
        {
          onSteer: () => {
            throw new Error('steer hook blew up');
          },
        },
      );
      channel.listener?.(steerMsg('run-1', 'steer-1'));

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeErrorInfoWithCode(ErrorCode.RunSteerHandlerFailed);
      await run.pipe(streamOf({ type: 'out' }));
      expect(run.hasInput()).toBe(true);
    });

    it('tracks a duplicate live steer once', async () => {
      const { transport, channel } = await setup({ decoded: [{ kind: 'user' }] });
      let steers = 0;

      const run = transport.openRun({ runId: 'run-1' }, { onSteer: () => steers++ });
      await run.pipe(streamOf({ type: 'out' }));
      channel.listener?.(steerMsg('run-1', 'steer-1'));
      channel.listener?.(steerMsg('run-1', 'steer-1'));

      expect(steers).toBe(1);
      expect(run.hasInput()).toBe(true);
      expect(run.hasInput()).toBe(false);
    });
  });

  describe('input receipt', () => {
    it('stamps the trigger and every stamped steer on the run-end', async () => {
      const { transport, channel } = await setup({ decoded: [{ kind: 'user' }] });

      const run = transport.openRun({ runId: 'run-1', inputCodecMessageId: 'in-1' });
      await run.pipe(streamOf({ type: 'out' }));
      channel.listener?.(steerMsg('run-1', 'steer-1'));
      expect(run.hasInput()).toBe(true);
      await run.pipe(streamOf({ type: 'out' }));
      await run.end({ reason: 'complete' });

      expect(receiptOf(channel, 'ai-run-end')).toBe(JSON.stringify(['in-1', 'steer-1']));
    });

    it('excludes an undrained pending steer from the run-end receipt', async () => {
      const { transport, channel } = await setup({ decoded: [{ kind: 'user' }] });

      const run = transport.openRun({ runId: 'run-1', inputCodecMessageId: 'in-1' });
      await run.pipe(streamOf({ type: 'out' }));
      channel.listener?.(steerMsg('run-1', 'steer-1'));
      await run.end({ reason: 'complete' });

      expect(receiptOf(channel, 'ai-run-end')).toBe(JSON.stringify(['in-1']));
    });

    it('excludes a drained steer no step attempt has taken for stamping', async () => {
      const { transport, channel } = await setup({ decoded: [{ kind: 'user' }] });

      const run = transport.openRun({ runId: 'run-1', inputCodecMessageId: 'in-1' });
      await run.pipe(streamOf({ type: 'out' }));
      channel.listener?.(steerMsg('run-1', 'steer-1'));
      expect(run.hasInput()).toBe(true);
      await run.end({ reason: 'complete' });

      expect(receiptOf(channel, 'ai-run-end')).toBe(JSON.stringify(['in-1']));
    });

    it('omits the receipt when the run produced no output', async () => {
      const { transport, channel } = await setup();

      const run = transport.openRun({ runId: 'run-1', inputCodecMessageId: 'in-1' });
      await run.end({ reason: 'complete' });

      expect(receiptOf(channel, 'ai-run-end')).toBeUndefined();
    });

    it('omits the receipt when there is no trigger and no steer', async () => {
      const { transport, channel } = await setup();

      const run = transport.openRun({ runId: 'run-1' });
      await run.pipe(streamOf({ type: 'out' }));
      await run.end({ reason: 'complete' });

      expect(receiptOf(channel, 'ai-run-end')).toBeUndefined();
    });

    it('stamps considered-so-far on the suspend and accumulates onto the final end', async () => {
      const { transport, channel } = await setup({ decoded: [{ kind: 'user' }] });

      const run = transport.openRun({ runId: 'run-1', inputCodecMessageId: 'in-1' });
      await run.pipe(streamOf({ type: 'out' }));
      channel.listener?.(steerMsg('run-1', 'steer-1'));
      expect(run.hasInput()).toBe(true);
      await run.pipe(streamOf({ type: 'out' }));
      await run.suspend();

      expect(receiptOf(channel, 'ai-run-suspend')).toBe(JSON.stringify(['in-1', 'steer-1']));

      await run.resume();
      channel.listener?.(steerMsg('run-1', 'steer-2'));
      expect(run.hasInput()).toBe(true);
      await run.pipe(streamOf({ type: 'out' }));
      await run.end({ reason: 'complete' });

      expect(receiptOf(channel, 'ai-run-end')).toBe(JSON.stringify(['in-1', 'steer-1', 'steer-2']));
    });

    it('stamps a steer-only receipt when the run has no trigger attribution', async () => {
      const { transport, channel } = await setup({ decoded: [{ kind: 'user' }] });

      const run = transport.openRun({ runId: 'run-1' });
      await run.pipe(streamOf({ type: 'out' }));
      channel.listener?.(steerMsg('run-1', 'steer-1'));
      expect(run.hasInput()).toBe(true);
      await run.pipe(streamOf({ type: 'out' }));
      await run.end({ reason: 'complete' });

      expect(receiptOf(channel, 'ai-run-end')).toBe(JSON.stringify(['steer-1']));
    });
  });

  describe('close', () => {
    it('unsubscribes the channel listener', async () => {
      const { transport, channel } = await setup();

      expect(channel.listener).toBeDefined();
      transport.close();

      expect(channel.listener).toBeUndefined();
    });

    it('is terminal — connect, openRun, and history reject once closed', async () => {
      const { transport } = await setup();

      transport.close();

      await expect(transport.connect()).rejects.toMatchObject({ code: ErrorCode.SessionClosed });
      expect(() => transport.openRun()).toThrowErrorInfo({ code: ErrorCode.SessionClosed });
      await expect(transport.history()).rejects.toMatchObject({ code: ErrorCode.SessionClosed });
    });
  });

  describe('openRun', () => {
    it('publishes ai-run-start with a minted run-id and returns the run handle', async () => {
      const { transport, channel } = await setup({ clientId: 'agent-a' });

      const run = transport.openRun();
      // The open publish is fired but not awaited; end() awaits it through the
      // same promise, so drive the run to a terminal to flush the wire.
      await run.end({ reason: 'complete' });

      expect(run.runId).toBeTruthy();
      const start = channel.publishCalls.find((m) => m.name === 'ai-run-start');
      expect(start).toBeDefined();
      const startMsg = start;
      if (!startMsg) throw new Error('expected ai-run-start');
      expect(getTransportHeaders(startMsg as Ably.InboundMessage)[HEADER_RUN_ID]).toBe(run.runId);
    });

    it('opens a fresh run under a pinned runId (the pin is not a continuation signal)', async () => {
      const { transport, channel } = await setup();

      const run = transport.openRun({ runId: 'run-pinned' });
      await run.end({ reason: 'complete' });

      expect(run.runId).toBe('run-pinned');
      expect(channel.publishNames()).toContain('ai-run-start');
      expect(channel.publishNames()).not.toContain('ai-run-resume');
    });

    it('publishes ai-run-resume for an explicit continuation of an existing run-id', async () => {
      const { transport, channel } = await setup();

      const run = transport.openRun({ runId: 'run-existing', continuation: true });
      await run.end({ reason: 'complete' });

      expect(run.runId).toBe('run-existing');
      expect(channel.publishNames()).toContain('ai-run-resume');
      expect(channel.publishNames()).not.toContain('ai-run-start');
    });

    it('throws when continuation is supplied without a runId', async () => {
      const { transport } = await setup();

      expect(() => transport.openRun({ continuation: true })).toThrowErrorInfo({
        code: ErrorCode.InvalidArgument,
        message: 'unable to open run; continuation requires a runId',
      });
    });

    it('accepts a continuation flag that agrees with the input', async () => {
      const { transport, channel } = await setup();

      const run = transport.openRun({ input: locatedInput({ [HEADER_RUN_ID]: 'run-continued' }), continuation: true });
      await run.end({ reason: 'complete' });

      expect(run.runId).toBe('run-continued');
      expect(channel.publishNames()).toContain('ai-run-resume');
    });

    it('throws when continuation: false contradicts an input carrying a run-id', async () => {
      const { transport } = await setup();

      expect(() =>
        transport.openRun({ input: locatedInput({ [HEADER_RUN_ID]: 'run-1' }), continuation: false }),
      ).toThrowErrorInfo({
        code: ErrorCode.InvalidArgument,
        message: "unable to open run; the continuation flag contradicts the input's run-id header",
      });
    });

    it('throws when continuation: true contradicts an input without a run-id', async () => {
      const { transport } = await setup();

      expect(() => transport.openRun({ input: locatedInput({}), runId: 'run-1', continuation: true })).toThrowErrorInfo(
        {
          code: ErrorCode.InvalidArgument,
          message: "unable to open run; the continuation flag contradicts the input's run-id header",
        },
      );
    });

    it('stamps parent structure on the run-start', async () => {
      const { transport, channel } = await setup();

      const run = transport.openRun({ parent: 'parent-cmid' });
      await run.end({ reason: 'complete' });

      const start = channel.publishCalls.find((m) => m.name === 'ai-run-start');
      if (!start) throw new Error('expected ai-run-start');
      expect(getTransportHeaders(start as Ably.InboundMessage)[HEADER_PARENT]).toBe('parent-cmid');
    });

    it('a located input carrying a run-id header resumes that run', async () => {
      const { transport, channel } = await setup();

      const run = transport.openRun({ input: locatedInput({ [HEADER_RUN_ID]: 'run-continued' }) });
      await run.end({ reason: 'complete' });

      expect(run.runId).toBe('run-continued');
      expect(channel.publishNames()).toContain('ai-run-resume');
      expect(channel.publishNames()).not.toContain('ai-run-start');
    });

    it('a located input without a run-id header opens a fresh run under the pinned runId', async () => {
      const { transport, channel } = await setup();

      const run = transport.openRun({ input: locatedInput({}), runId: 'run-durable' });
      await run.end({ reason: 'complete' });

      expect(run.runId).toBe('run-durable');
      expect(channel.publishNames()).toContain('ai-run-start');
      expect(channel.publishNames()).not.toContain('ai-run-resume');
    });

    it("a located input's run-id wins over the pinned runId", async () => {
      const { transport, channel } = await setup();

      const run = transport.openRun({
        input: locatedInput({ [HEADER_RUN_ID]: 'run-continued' }),
        runId: 'run-durable',
      });
      await run.end({ reason: 'complete' });

      expect(run.runId).toBe('run-continued');
      expect(channel.publishNames()).toContain('ai-run-resume');
    });
  });

  describe('adoptRun', () => {
    it('attaches without publishing any lifecycle event', async () => {
      const { transport, channel } = await setup();

      transport.adoptRun('run-adopted');
      await flushMicrotasks();

      expect(channel.publishNames()).not.toContain('ai-run-start');
      expect(channel.publishNames()).not.toContain('ai-run-resume');
    });

    it('registers the run for cancel routing', async () => {
      const { transport, channel } = await setup();

      const run = transport.adoptRun('run-adopted');
      await flushMicrotasks();
      channel.listener?.(cancelMsg({ [HEADER_RUN_ID]: 'run-adopted' }));
      await flushMicrotasks();

      expect(run.abortSignal.aborted).toBe(true);
    });

    it('publishes a terminal when the caller ends the run', async () => {
      const { transport, channel } = await setup({ clientId: 'agent-a' });

      const run = transport.adoptRun('run-adopted');
      await run.end({ reason: 'error' });

      // Only the terminal reaches the channel — no opening event precedes it.
      expect(channel.publishNames()).toEqual(['ai-run-end']);
      const end = channel.publishCalls.find((m) => m.name === 'ai-run-end');
      if (!end) throw new Error('expected ai-run-end');
      // The registered owner entry stamps the real run-client-id.
      expect(getTransportHeaders(end as Ably.InboundMessage)['run-client-id']).toBe('agent-a');
    });

    it('throws on an empty runId', async () => {
      const { transport } = await setup();

      expect(() => transport.adoptRun('')).toThrowErrorInfo({
        code: ErrorCode.InvalidArgument,
        message: 'unable to adopt run; runId must be non-empty',
      });
    });

    it('stamps a pinned invocation-id on the events it publishes', async () => {
      const { transport, channel } = await setup();

      const run = transport.adoptRun('run-adopted', { invocationId: 'inv-pinned' });
      await run.end({ reason: 'complete' });

      const end = channel.publishCalls.find((m) => m.name === 'ai-run-end');
      if (!end) throw new Error('expected ai-run-end');
      // CAST: the mock captured the outbound message; only its extras are read.
      expect(getTransportHeaders(end as Ably.InboundMessage)[HEADER_INVOCATION_ID]).toBe('inv-pinned');
    });

    it('mints an invocation-id when none is pinned', async () => {
      const { transport, channel } = await setup();

      const run = transport.adoptRun('run-adopted');
      await run.end({ reason: 'complete' });

      const end = channel.publishCalls.find((m) => m.name === 'ai-run-end');
      if (!end) throw new Error('expected ai-run-end');
      // CAST: the mock captured the outbound message; only its extras are read.
      expect(getTransportHeaders(end as Ably.InboundMessage)[HEADER_INVOCATION_ID]).toMatch(/\S/);
    });

    it('claims no input anchor, so its terminal carries no bracket receipt', async () => {
      const { transport, channel } = await setup();

      const run = transport.adoptRun('run-adopted');
      await run.pipe(streamOf({ type: 'text', text: 'hi' }));
      await run.end({ reason: 'complete' });

      // The anchor names the input that openRun answered; an adopt answers
      // none, so it claims none.
      expect(receiptOf(channel, 'ai-run-end')).toBeUndefined();
    });
  });

  describe('opened', () => {
    it('resolves once the opening publish lands', async () => {
      const { transport, channel } = await setup();

      const run = transport.openRun();
      await run.opened;

      expect(channel.publishNames()).toContain('ai-run-start');
    });

    it('rejects when the opening publish fails', async () => {
      const { transport, channel } = await setup();
      channel.publish.mockRejectedValueOnce(new Ably.ErrorInfo('publish refused', 50000, 500));

      const run = transport.openRun({ runId: 'run-1' });

      await expect(run.opened).rejects.toBeErrorInfo({ message: 'publish refused' });
    });

    it('resolves for an adopted run without publishing', async () => {
      const { transport, channel } = await setup();

      const run = transport.adoptRun('run-adopted');
      await run.opened;

      expect(channel.publishNames()).toEqual([]);
    });
  });

  describe('output', () => {
    it('brackets piped output with ai-step-start and ai-step-end', async () => {
      const { transport, channel } = await setup();

      const run = transport.openRun({ runId: 'run-1' });
      const result = await run.pipe(streamOf({ type: 'text', text: 'hi' }));
      await run.end({ reason: 'complete' });

      expect(result.reason).toBe('complete');
      const names = channel.publishNames();
      expect(names).toContain('ai-step-start');
      expect(names).toContain('ai-step-end');
      // The step bracket sits between the open and the run terminal.
      expect(names.indexOf('ai-step-start')).toBeLessThan(names.indexOf('ai-step-end'));
      expect(names.indexOf('ai-step-end')).toBeLessThan(names.indexOf('ai-run-end'));
    });

    it('does not open a step until the first send on a createStep handle', async () => {
      const { transport, channel } = await setup();

      const run = transport.openRun({ runId: 'run-1' });
      const step = run.createStep();
      expect(channel.publishNames()).not.toContain('ai-step-start');

      await step.send({ type: 'text', text: 'hi' });
      expect(channel.publishNames()).toContain('ai-step-start');
      // No step-end until the caller ends the step.
      expect(channel.publishNames()).not.toContain('ai-step-end');

      await step.end({});
      expect(channel.publishNames()).toContain('ai-step-end');
    });

    it('emits the step-lifecycle seed on the transport receive stream', async () => {
      const { transport, events } = await setup();

      const run = transport.openRun({ runId: 'run-1' });
      await run.pipe(streamOf({ type: 'text', text: 'hi' }));

      const seedTypes = events.map((e) => (e.kind === 'step-lifecycle' ? e.event.type : e.kind));
      expect(seedTypes).toEqual(['step-start', 'step-end']);
    });

    it('throws when an output verb runs after the run has ended', async () => {
      const { transport } = await setup();

      const run = transport.openRun({ runId: 'run-1' });
      await run.end({ reason: 'complete' });

      await expect(run.pipe(streamOf({ type: 'text', text: 'late' }))).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('suspend', () => {
    it('publishes ai-run-suspend when no step is active', async () => {
      const { transport, channel } = await setup();

      const run = transport.openRun({ runId: 'run-1' });
      await run.suspend();

      expect(channel.publishNames()).toContain('ai-run-suspend');
    });

    it('refuses to suspend while a step is still open', async () => {
      const { transport } = await setup();

      const run = transport.openRun({ runId: 'run-1' });
      const step = run.createStep();
      await step.send({ type: 'text', text: 'hi' });

      await expect(run.suspend()).rejects.toMatchObject({ statusCode: 400 });
    });

    it('is a no-op once the run has ended', async () => {
      const { transport, channel } = await setup();

      const run = transport.openRun({ runId: 'run-1' });
      await run.end({ reason: 'complete' });
      await run.suspend();

      expect(channel.publishNames()).not.toContain('ai-run-suspend');
    });

    it('blocks output while suspended', async () => {
      const { transport } = await setup();

      const run = transport.openRun({ runId: 'run-1' });
      await run.suspend();

      await expect(run.pipe(streamOf({ type: 'text', text: 'late' }))).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('resume', () => {
    it('republishes ai-run-resume under the same run-id', async () => {
      const { transport, channel } = await setup();

      const run = transport.openRun({ runId: 'run-1' });
      await run.suspend();
      await run.resume();

      const resumes = channel.publishCalls.filter((m) => m.name === 'ai-run-resume');
      expect(resumes.length).toBeGreaterThanOrEqual(1);
      const last = resumes.at(-1);
      if (!last) throw new Error('expected ai-run-resume');
      expect(getTransportHeaders(last as Ably.InboundMessage)[HEADER_RUN_ID]).toBe('run-1');
    });

    it('re-opens the publish surface after a suspend', async () => {
      const { transport, channel } = await setup();

      const run = transport.openRun({ runId: 'run-1' });
      await run.suspend();
      await run.resume();
      await run.pipe(streamOf({ type: 'text', text: 'after resume' }));
      await run.end({ reason: 'complete' });

      const names = channel.publishNames();
      expect(names.indexOf('ai-step-start')).toBeGreaterThan(names.indexOf('ai-run-resume'));
      expect(names).toContain('ai-run-end');
    });

    it('throws once the run has ended', async () => {
      const { transport } = await setup();

      const run = transport.openRun({ runId: 'run-1' });
      await run.end({ reason: 'complete' });

      await expect(run.resume()).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('end', () => {
    it('auto-closes an open step before the run terminal', async () => {
      const { transport, channel } = await setup();

      const run = transport.openRun({ runId: 'run-1' });
      const step = run.createStep();
      await step.send({ type: 'text', text: 'hi' });
      await run.end({ reason: 'complete' });

      const names = channel.publishNames();
      expect(names.indexOf('ai-step-end')).toBeLessThan(names.indexOf('ai-run-end'));
    });

    it('publishes ai-run-end and leaves the handle terminal', async () => {
      const { transport, channel } = await setup();

      const run = transport.openRun({ runId: 'run-1' });
      await run.end({ reason: 'error', error: new Ably.ErrorInfo('boom', 50000, 500) });

      expect(channel.publishNames()).toContain('ai-run-end');
      await expect(run.resume()).rejects.toMatchObject({ statusCode: 400 });
    });

    it('is idempotent — a second end publishes no further run-end', async () => {
      const { transport, channel } = await setup();

      const run = transport.openRun({ runId: 'run-1' });
      await run.end({ reason: 'complete' });
      await run.end({ reason: 'complete' });

      expect(channel.publishCalls.filter((m) => m.name === 'ai-run-end')).toHaveLength(1);
    });
  });

  describe('locateInput', () => {
    it('returns the decoded input and meta for a matching event-id in history', async () => {
      const decoded: TestInput[] = [{ kind: 'user-message', content: 'located' }];
      const match = wireMsg({ [HEADER_EVENT_ID]: 'evt-1', [HEADER_RUN_ID]: 'run-1', [HEADER_INVOCATION_ID]: 'inv-1' });
      const other = wireMsg({ [HEADER_EVENT_ID]: 'evt-0' });
      const { transport } = await setup({ decoded, historyPages: [[other, match]] });

      const located = await transport.locateInput('evt-1');

      expect(located).toBeDefined();
      expect(located?.inputs).toEqual(decoded);
      expect(located?.meta.runId).toBe('run-1');
    });

    it('returns undefined when no history message carries the event-id', async () => {
      const other = wireMsg({ [HEADER_EVENT_ID]: 'evt-0' });
      const { transport } = await setup({ decoded: [{ kind: 'user-message' }], historyPages: [[other]] });

      const located = await transport.locateInput('evt-missing');

      expect(located).toBeUndefined();
    });

    it('fires onPage after each page fetch during the scan', async () => {
      const { transport } = await setup({
        decoded: [{ kind: 'user-message' }],
        historyPages: [[wireMsg({ [HEADER_EVENT_ID]: 'evt-0' })], [wireMsg({ [HEADER_EVENT_ID]: 'evt-1' })]],
      });
      let pages = 0;

      await transport.locateInput('evt-1', {
        onPage: () => {
          pages++;
        },
      });

      expect(pages).toBe(2);
    });

    it('stops scanning at the limit and resolves undefined', async () => {
      const { transport } = await setup({
        decoded: [{ kind: 'user-message' }],
        historyPages: [[wireMsg({ [HEADER_EVENT_ID]: 'evt-0' })], [wireMsg({ [HEADER_EVENT_ID]: 'evt-1' })]],
      });
      let pages = 0;

      const located = await transport.locateInput('evt-1', {
        limit: 1,
        onPage: () => {
          pages++;
        },
      });

      // The first page's one message meets the limit, so the matching second
      // page is never fetched — a bounded miss, not proof of absence.
      expect(located).toBeUndefined();
      expect(pages).toBe(1);
    });

    it('rejects with OperationCancelled when the signal aborts', async () => {
      const { transport } = await setup({
        decoded: [{ kind: 'user-message' }],
        historyPages: [[wireMsg({ [HEADER_EVENT_ID]: 'evt-0' })]],
      });

      await expect(transport.locateInput('evt-0', { signal: AbortSignal.abort() })).rejects.toBeErrorInfoWithCode(
        ErrorCode.OperationCancelled,
      );
    });

    it('rejects an already-aborted scan before fetching any page', async () => {
      const { transport, channel } = await setup({
        decoded: [{ kind: 'user-message' }],
        historyPages: [[wireMsg({ [HEADER_EVENT_ID]: 'evt-0' })]],
      });
      channel.history.mockClear();

      await expect(transport.locateInput('evt-0', { signal: AbortSignal.abort() })).rejects.toBeErrorInfoWithCode(
        ErrorCode.OperationCancelled,
      );
      expect(channel.history).not.toHaveBeenCalled();
    });

    it('keeps scanning when onPage throws', async () => {
      const decoded: TestInput[] = [{ kind: 'user-message', content: 'located' }];
      const { transport } = await setup({
        decoded,
        historyPages: [[wireMsg({ [HEADER_EVENT_ID]: 'evt-0' })], [wireMsg({ [HEADER_EVENT_ID]: 'evt-1' })]],
      });

      const located = await transport.locateInput('evt-1', {
        onPage: () => {
          throw new Error('heartbeat exploded');
        },
      });

      expect(located?.inputs).toEqual(decoded);
    });
  });

  describe('history', () => {
    it('fires onPage after each page fetch', async () => {
      const { transport } = await setup({
        historyPages: [[outputMsg('s2', 'two')], [outputMsg('s1', 'one')]],
      });
      let pages = 0;

      const result = await transport.history({
        onPage: () => {
          pages++;
        },
      });

      expect(result.exhausted).toBe(true);
      expect(pages).toBe(2);
    });

    it('returns classified events without emitting to the subscribe stream', async () => {
      const { transport, events } = await setup({
        historyPages: [[outputMsg('s2', 'two'), outputMsg('s1', 'one')]],
      });

      const result = await transport.history();

      expect(result.exhausted).toBe(true);
      const texts = result.events.map((e) => (e.kind === 'message' ? e.outputs[0]?.text : undefined));
      expect(texts).toEqual(['one', 'two']);
      // Batches never pass through the live stream.
      expect(events).toHaveLength(0);
    });

    it('rejects an already-aborted call before fetching any page', async () => {
      const { transport, channel } = await setup({ historyPages: [[outputMsg('s1', 'one')]] });
      channel.history.mockClear();

      await expect(transport.history({ signal: AbortSignal.abort() })).rejects.toBeErrorInfoWithCode(
        ErrorCode.OperationCancelled,
      );
      expect(channel.history).not.toHaveBeenCalled();
    });

    it('still pages after an aborted call, so the shared cursor is not wedged', async () => {
      const { transport } = await setup({
        historyPages: [[outputMsg('s2', 'two')], [outputMsg('s1', 'one')]],
      });

      await expect(transport.history({ signal: AbortSignal.abort() })).rejects.toBeErrorInfoWithCode(
        ErrorCode.OperationCancelled,
      );

      const after = await transport.history();
      expect(after.events.map((e) => (e.kind === 'message' ? e.outputs[0]?.text : undefined))).toEqual(['one', 'two']);
      expect(after.exhausted).toBe(true);
    });

    it('keeps its cursor across calls, so a second call resumes where the first paused', async () => {
      const { transport } = await setup({
        historyPages: [
          [outputMsg('s4', 'four'), outputMsg('s3', 'three')],
          [outputMsg('s2', 'two'), outputMsg('s1', 'one')],
        ],
      });

      const first = await transport.history({ limit: 1 });
      expect(first.events.map((e) => (e.kind === 'message' ? e.outputs[0]?.text : undefined))).toEqual([
        'three',
        'four',
      ]);
      expect(first.exhausted).toBe(false);

      const second = await transport.history();
      expect(second.events.map((e) => (e.kind === 'message' ? e.outputs[0]?.text : undefined))).toEqual(['one', 'two']);
      expect(second.exhausted).toBe(true);
    });

    it('routes an undecodable message onto error and keeps the rest of the batch', async () => {
      const { transport, errors } = await setup({
        historyPages: [[outputMsg('s3', 'kept'), boomMsg('s2'), outputMsg('s1', 'also-kept')]],
      });

      const result = await transport.history();

      expect(result.events.map((e) => (e.kind === 'message' ? e.outputs[0]?.text : undefined))).toEqual([
        'also-kept',
        'kept',
      ]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeErrorInfoWithCode(ErrorCode.SessionMessageProcessingFailed);
    });
  });
});
