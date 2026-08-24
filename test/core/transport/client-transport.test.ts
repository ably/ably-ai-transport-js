/**
 * createClientTransport unit tests — the self-contained client
 * transport.
 *
 * The transport owns its receive path: `connect()` subscribes its listener and
 * attaches the channel, live wires classify onto the `subscribe`/`on('event')`
 * stream (typed event before raw `ably-message`; a decode failure drops the
 * one message onto `error`). `publishInput` stamps `user` transport headers,
 * publishes through the codec encoder, and emits an optimistic local echo
 * (serial / versionSerial `undefined`) for fresh content; a wire-only input
 * gets no echo. Its result carries a `runId` promise, resolved from the first
 * `ai-run-start` whose `input-codec-message-id` matches the publish and
 * rejected on close or continuity loss. `history()` returns older events as chronological batches
 * without emitting them — the batch walk itself is pinned in
 * history-walk.test.ts, so the history tests here cover only the transport's
 * wiring: no live emission, a cursor kept across calls, and decode failures
 * routed onto `error`. `cancel` publishes a stateless `ai-cancel` envelope.
 * `steer` publishes a steering user input into an open run: `published`
 * resolves on the steer's own channel echo, `outcome` by membership of the
 * steer's codec-message-id in the `steer-codec-message-ids` stamps at the
 * run's next lifecycle bracket; close and continuity loss drain in-flight
 * steers. The steer state machine itself is pinned in
 * steer-coordinator.test.ts — the steer tests here cover only the
 * transport's wiring. `close()` unsubscribes and is terminal. These tests
 * pin that contract against a mock channel and a minimal codec double.
 */

import * as Ably from 'ably';
import { describe, expect, it, vi } from 'vitest';

import {
  EVENT_RUN_END,
  EVENT_RUN_START,
  EVENT_RUN_SUSPEND,
  HEADER_CODEC_MESSAGE_ID,
  HEADER_EVENT_ID,
  HEADER_INPUT_CODEC_MESSAGE_ID,
  HEADER_MSG_REGENERATE,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_ID,
  HEADER_RUN_REASON,
  HEADER_STEER_CODEC_MESSAGE_IDS,
} from '../../../src/constants.js';
import type { ChannelWriter, Encoder, WireCodec, WriteOptions } from '../../../src/core/codec/types.js';
import { createClientTransport } from '../../../src/core/transport/client-transport.js';
import type { TransportEvent } from '../../../src/core/transport/types/transport.js';
import { ErrorCode } from '../../../src/errors.js';
import { getTransportHeaders } from '../../../src/utils.js';
import { createMockChannel, type MockChannel } from '../../helper/mock-channel.js';
import { boomMsg, inboundMessage, outputMsg } from '../../helper/wire-messages.js';

interface TestInput {
  kind: string;
  content?: string;
  parent?: string;
  target?: string;
  codecMessageId?: string;
}
interface TestOutput {
  type: string;
  text?: string;
}

type TestEvent = TransportEvent<TestInput, TestOutput>;

interface EncoderCall {
  input: TestInput;
  options?: WriteOptions;
}

/**
 * A codec double whose decoder classifies by message name (`ai-input` yields
 * one input, `ai-output` one output, `boom` throws, anything else is empty)
 * and whose encoder records `publishInput` calls and runs the `onAblyMessage`
 * hook so user-header stamping is exercised.
 * @param encoderCalls - Array the encoder appends each `publishInput` call to.
 * @param hookMessages - Array the encoder appends each hook-run message to.
 * @returns The codec double.
 */
const createMockCodec = (
  encoderCalls: EncoderCall[],
  hookMessages: Ably.Message[],
): WireCodec<TestInput, TestOutput> => ({
  createEncoder: (
    _channel: ChannelWriter,
    opts?: { onAblyMessage?: (msg: Ably.Message) => void },
  ): Encoder<TestInput, TestOutput> => ({
    // eslint-disable-next-line @typescript-eslint/require-await -- mock
    publishInput: vi.fn(async (input: TestInput, options?: WriteOptions): Promise<void> => {
      encoderCalls.push({ input, options });
      const msg: Ably.Message = { name: 'ai-input', extras: { ai: { transport: { ...options?.extras?.headers } } } };
      opts?.onAblyMessage?.(msg);
      hookMessages.push(msg);
    }),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    publishOutput: vi.fn(() => Promise.resolve()),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    cancelStreams: vi.fn(() => Promise.resolve()),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    close: vi.fn(() => Promise.resolve()),
  }),
  createDecoder: () => ({
    decode: (msg: Ably.InboundMessage): { inputs: TestInput[]; outputs: TestOutput[] } => {
      if (msg.name === 'boom') throw new Error('malformed payload');
      if (msg.name === 'ai-input') {
        // CAST: the test wires carry string data.
        return { inputs: [{ kind: 'user-message', content: msg.data as string }], outputs: [] };
      }
      if (msg.name === 'ai-output') {
        // CAST: the test wires carry string data.
        return { inputs: [], outputs: [{ type: 'out', text: msg.data as string }] };
      }
      return { inputs: [], outputs: [] };
    },
  }),
});

/**
 * Build a wire-only carrier: the decoder yields nothing and there is no
 * run-id, so classification filters it.
 * @param serial - The channel serial.
 * @returns The wire message.
 */
const noiseMsg = (serial: string): Ably.InboundMessage =>
  // CAST: minimal InboundMessage stub — only the fields the classifier reads.
  ({
    name: 'noise',
    action: 'message.create',
    extras: {},
    serial,
    timestamp: 1000,
    version: {},
  }) as unknown as Ably.InboundMessage;

// Settle the microtask queue so the steer publish path (open guard, then the
// coordinator's async IIFE) makes progress.
const flush = async (n = 8): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

/**
 * Build the channel echo of a steer's own publish.
 * @param steerId - The codec-message-id the steer publish minted.
 * @param runId - The run the steer targets.
 * @param serial - The Ably-assigned channel serial.
 * @returns The wire message.
 */
const steerEcho = (steerId: string, runId: string, serial: string): Ably.InboundMessage =>
  inboundMessage({
    name: 'ai-input',
    transport: { [HEADER_CODEC_MESSAGE_ID]: steerId, [HEADER_RUN_ID]: runId, [HEADER_ROLE]: 'user' },
    serial,
  });

/**
 * Build a run output stamped with the steers its producing step consumed.
 * @param runId - The producing run.
 * @param steerIds - The consumed steers' codec-message-ids.
 * @param serial - The channel serial.
 * @returns The wire message.
 */
const stampedOutput = (runId: string, steerIds: string[], serial: string): Ably.InboundMessage =>
  inboundMessage({
    name: 'ai-output',
    transport: { [HEADER_RUN_ID]: runId, [HEADER_STEER_CODEC_MESSAGE_IDS]: JSON.stringify(steerIds) },
    serial,
  });

/**
 * Build a run lifecycle bracket (`ai-run-end` / `ai-run-suspend`).
 * @param name - The lifecycle wire name.
 * @param runId - The run the bracket closes.
 * @param reason - The run-end reason header, when present.
 * @returns The wire message.
 */
const runBracket = (name: string, runId: string, reason?: string): Ably.InboundMessage =>
  inboundMessage({
    name,
    transport: { [HEADER_RUN_ID]: runId, ...(reason === undefined ? {} : { [HEADER_RUN_REASON]: reason }) },
    serial: `s-${name}`,
  });

/**
 * Build a run-start, optionally attributing the run to its triggering input.
 * @param runId - The started run.
 * @param inputCodecMessageId - The triggering input's codec-message-id header,
 *   when the agent stamped one.
 * @returns The wire message.
 */
const runStart = (runId: string, inputCodecMessageId?: string): Ably.InboundMessage =>
  inboundMessage({
    name: EVENT_RUN_START,
    transport: {
      [HEADER_RUN_ID]: runId,
      ...(inputCodecMessageId === undefined ? {} : { [HEADER_INPUT_CODEC_MESSAGE_ID]: inputCodecMessageId }),
    },
    serial: `s-start-${runId}`,
  });

/**
 * Start a steer against `run-1` on a connected fixture and flush so the
 * coordinator's publish lands in `encoderCalls`.
 * @param fixture - The connected setup fixture.
 * @param fixture.transport - The transport under test.
 * @param fixture.encoderCalls - The encoder's recorded publishes.
 * @returns The steer result pair and its minted codec-message-id.
 */
const startSteer = async (fixture: {
  transport: ReturnType<typeof createClientTransport<TestInput, TestOutput>>;
  encoderCalls: EncoderCall[];
}): Promise<{ result: ReturnType<typeof fixture.transport.steer>; steerId: string }> => {
  const result = fixture.transport.steer('run-1', { kind: 'user-message', content: 'go' });
  await flush();
  const steerId = fixture.encoderCalls[0]?.options?.messageId;
  if (steerId === undefined) throw new Error('expected the steer to publish');
  return { result, steerId };
};

/** Sentinel for asserting a promise has not settled yet. */
const pending = Symbol('pending');

/**
 * Build a transport over the mocks, subscribing collectors for events, raw
 * messages, and errors, and connect it unless told otherwise.
 * @param opts - Optional fixture overrides.
 * @param opts.clientId - The publishing clientId to stamp as `run-client-id`.
 * @param opts.pages - History pages the mock channel serves (newest first).
 * @param opts.codec - Replaces the default codec double.
 * @param opts.connect - Set false to leave the transport unconnected.
 * @returns The transport, the mocks, and the collected streams.
 */
const setup = async (opts?: {
  clientId?: string;
  pages?: Ably.InboundMessage[][];
  codec?: WireCodec<TestInput, TestOutput>;
  connect?: boolean;
}): Promise<{
  transport: ReturnType<typeof createClientTransport<TestInput, TestOutput>>;
  channel: MockChannel & Ably.RealtimeChannel;
  events: TestEvent[];
  raw: Ably.InboundMessage[];
  errors: Ably.ErrorInfo[];
  encoderCalls: EncoderCall[];
  stamped: Ably.Message[];
}> => {
  const channel = createMockChannel(opts?.pages ?? []);
  const encoderCalls: EncoderCall[] = [];
  const stamped: Ably.Message[] = [];
  const transport = createClientTransport<TestInput, TestOutput>({
    channel,
    codec: opts?.codec ?? createMockCodec(encoderCalls, stamped),
    clientId: opts?.clientId,
  });
  const events: TestEvent[] = [];
  transport.subscribe((event) => events.push(event));
  const raw: Ably.InboundMessage[] = [];
  transport.on('ably-message', (msg) => raw.push(msg));
  const errors: Ably.ErrorInfo[] = [];
  transport.on('error', (err) => errors.push(err));
  if (opts?.connect !== false) await transport.connect();
  return { transport, channel, events, raw, errors, encoderCalls, stamped };
};

describe('createClientTransport', () => {
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

    it('gates publishInput, cancel, and history until connect() is called', async () => {
      const { transport } = await setup({ connect: false });

      await expect(transport.publishInput({ kind: 'user-message', content: 'hi' })).rejects.toMatchObject({
        code: ErrorCode.InvalidArgument,
      });
      await expect(transport.cancel('run-1')).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
      await expect(transport.history()).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
      const steer = transport.steer('run-1', { kind: 'user-message', content: 'go' });
      await expect(steer.published).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
      await expect(steer.outcome).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    });
  });

  describe('live delivery', () => {
    it('surfaces the classified outputs and meta to subscribers, then the raw ably-message', async () => {
      const { transport, channel, events } = await setup();
      const order: string[] = [];
      transport.subscribe(() => order.push('event'));
      transport.on('ably-message', () => order.push('ably-message'));

      channel.listener?.(outputMsg('s1', 'hello'));

      expect(events).toHaveLength(1);
      const event = events[0];
      if (event?.kind !== 'message') throw new Error('expected message event');
      expect(event.outputs).toEqual([{ type: 'out', text: 'hello' }]);
      expect(event.meta.serial).toBe('s1');
      expect(event.meta.runId).toBe('R1');
      // The typed event lands before the raw ably-message.
      expect(order).toEqual(['event', 'ably-message']);
    });

    it('drops an undecodable wire onto error, suppressing its event and raw emit', async () => {
      const { channel, events, raw, errors } = await setup();

      channel.listener?.(boomMsg('s1'));

      expect(events).toHaveLength(0);
      expect(raw).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeErrorInfoWithCode(ErrorCode.SessionMessageProcessingFailed);
    });
  });

  describe('publishInput', () => {
    it('emits an optimistic local echo then publishes a user input', async () => {
      const { transport, events, encoderCalls } = await setup({ clientId: 'client-a' });

      const result = await transport.publishInput({ kind: 'user-message', content: 'hi' });

      expect(result.codecMessageId).toBeTruthy();
      expect(result.eventId).toBeTruthy();
      expect(result.codecMessageId).not.toBe(result.eventId);

      expect(events).toHaveLength(1);
      const echo = events[0];
      if (echo?.kind !== 'message') throw new Error('expected message echo');
      expect(echo).toMatchObject({ kind: 'message', inputs: [{ kind: 'user-message', content: 'hi' }], outputs: [] });
      // The echo carries no wire-assigned identity, and the same codecMessageId
      // the publish used, so a consumer reconciles it against the wire echo.
      expect(echo.meta.serial).toBeUndefined();
      expect(echo.meta.versionSerial).toBeUndefined();
      expect(echo.meta.messageName).toBeUndefined();
      expect(echo.meta.codecMessageId).toBe(result.codecMessageId);
      expect(echo.meta.role).toBe('user');
      expect(echo.meta.clientId).toBe('client-a');
      expect(echo.meta.headers).toEqual({});

      // The publish stamped role + codec-message-id + event-id transport headers.
      expect(encoderCalls).toHaveLength(1);
      const headers = encoderCalls[0]?.options?.extras?.headers ?? {};
      expect(headers[HEADER_ROLE]).toBe('user');
      expect(headers[HEADER_CODEC_MESSAGE_ID]).toBe(result.codecMessageId);
      expect(headers[HEADER_EVENT_ID]).toBe(result.eventId);
      expect(encoderCalls[0]?.options?.messageId).toBe(result.codecMessageId);
    });

    it.each([
      { label: 'stamps run-client-id and the echo clientId when a clientId is supplied', clientId: 'client-a' },
      { label: 'omits run-client-id and leaves the echo clientId undefined when anonymous', clientId: undefined },
    ])('$label', async ({ clientId }) => {
      const { transport, events, encoderCalls } = await setup({ clientId });

      await transport.publishInput({ kind: 'user-message', content: 'hi' });

      const headers = encoderCalls[0]?.options?.extras?.headers ?? {};
      if (clientId === undefined) {
        expect(headers).not.toHaveProperty(HEADER_RUN_CLIENT_ID);
      } else {
        expect(headers[HEADER_RUN_CLIENT_ID]).toBe(clientId);
      }
      const echo = events[0];
      if (echo?.kind !== 'message') throw new Error('expected message echo');
      expect(echo.meta.clientId).toBe(clientId);
    });

    it('honours an explicit codecMessageId and structure headers, with no echo for the amend', async () => {
      const { transport, events, encoderCalls } = await setup();

      await transport.publishInput(
        { kind: 'user-message', content: 'hi' },
        { codecMessageId: 'cmid-1', parent: 'parent-1' },
      );

      // An input naming an existing codecMessageId amends it, so no echo.
      expect(events).toHaveLength(0);
      const headers = encoderCalls[0]?.options?.extras?.headers ?? {};
      expect(headers[HEADER_CODEC_MESSAGE_ID]).toBe('cmid-1');
      expect(headers[HEADER_PARENT]).toBe('parent-1');
    });

    it('maps the regenerates option to msg-regenerate', async () => {
      const { transport, encoderCalls } = await setup();

      await transport.publishInput({ kind: 'regenerate' }, { regenerates: 'assistant-1', parent: 'user-1' });

      const headers = encoderCalls[0]?.options?.extras?.headers ?? {};
      expect(headers[HEADER_MSG_REGENERATE]).toBe('assistant-1');
      expect(headers[HEADER_PARENT]).toBe('user-1');
    });

    it('emits no echo for an input published against an existing codecMessageId', async () => {
      const { transport, events } = await setup();

      await transport.publishInput({ kind: 'tool-result' }, { codecMessageId: 'assistant-1' });

      expect(events).toHaveLength(0);
    });

    it('stamps user headers into Ably extras.headers, outside the ai envelope', async () => {
      const { transport, events, stamped } = await setup();

      await transport.publishInput({ kind: 'user-message', content: 'hi' }, { headers: { 'x-tenant': 'acme' } });

      expect(stamped).toHaveLength(1);
      // CAST: the mock builds a plain message; user headers land in extras.headers.
      const extras = stamped[0]?.extras as { headers?: Record<string, string> };
      expect(extras.headers).toEqual({ 'x-tenant': 'acme' });
      // The user header does not leak into the ai.transport tier.
      expect(getTransportHeaders(stamped[0] as Ably.InboundMessage)['x-tenant']).toBeUndefined();
      // The optimistic echo carries the same user headers the wire echo will.
      const echo = events[0];
      if (echo?.kind !== 'message') throw new Error('expected message echo');
      expect(echo.meta.headers).toEqual({ 'x-tenant': 'acme' });
    });

    it('wraps a permission publish failure as an InsufficientCapability error', async () => {
      const codec = createMockCodec([], []);
      // Override the encoder to reject with a 403.
      codec.createEncoder = (): Encoder<TestInput, TestOutput> => ({
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock rejects
        publishInput: () => Promise.reject(new Ably.ErrorInfo('forbidden', 40160, 403)),
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
        publishOutput: vi.fn(() => Promise.resolve()),
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
        cancelStreams: vi.fn(() => Promise.resolve()),
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
        close: vi.fn(() => Promise.resolve()),
      });
      const { transport } = await setup({ codec });

      await expect(transport.publishInput({ kind: 'user-message', content: 'hi' })).rejects.toMatchObject({
        statusCode: 401,
      });
    });
  });

  describe('publishInput runId', () => {
    it('resolves immediately with the continuation run-id named in the options', async () => {
      // A continuation's run answers with ai-run-resume, which names no
      // triggering input — there is nothing for a watch to match, so the
      // known id resolves without any lifecycle event.
      const fixture = await setup();
      const sent = await fixture.transport.publishInput(
        { kind: 'user-message', content: 'go on' },
        { codecMessageId: 'm-1', runId: 'run-known' },
      );

      await expect(sent.runId).resolves.toBe('run-known');
    });

    it('resolves from the first run-start carrying the publish codec-message-id', async () => {
      const fixture = await setup();
      const sent = await fixture.transport.publishInput({ kind: 'user-message', content: 'hi' });
      await expect(Promise.race([sent.runId, Promise.resolve(pending)])).resolves.toBe(pending);

      fixture.channel.listener?.(runStart('run-9', sent.codecMessageId));

      await expect(sent.runId).resolves.toBe('run-9');
    });

    it('resolves immediately with the caller-supplied runId, watching nothing', async () => {
      const fixture = await setup();
      // A continuation names its run, and the agent answers it with
      // `ai-run-resume`, which no run-start watch would ever match.
      const sent = await fixture.transport.publishInput(
        { kind: 'user-message', content: 'tool result' },
        { runId: 'run-continued', codecMessageId: 'm-1' },
      );

      await expect(sent.runId).resolves.toBe('run-continued');
    });

    it('leaves no watch behind for a continuation, so close rejects nothing', async () => {
      const fixture = await setup();
      const sent = await fixture.transport.publishInput(
        { kind: 'user-message', content: 'tool result' },
        { runId: 'run-continued' },
      );
      fixture.transport.close();

      // Still the supplied id: a leaked watch would have been drained to a
      // SessionClosed rejection by close().
      await expect(sent.runId).resolves.toBe('run-continued');
    });

    it('stays pending on run-starts attributed to other inputs, or to none', async () => {
      const fixture = await setup();
      const sent = await fixture.transport.publishInput({ kind: 'user-message', content: 'hi' });

      fixture.channel.listener?.(runStart('run-8', 'someone-elses-input'));
      fixture.channel.listener?.(runStart('run-7'));
      await flush();

      await expect(Promise.race([sent.runId, Promise.resolve(pending)])).resolves.toBe(pending);
    });

    it('resolves every publish pinned to one codec-message-id from the same run-start', async () => {
      const fixture = await setup();
      const first = await fixture.transport.publishInput(
        { kind: 'user-message', content: 'a' },
        { codecMessageId: 'm-1' },
      );
      const second = await fixture.transport.publishInput(
        { kind: 'user-message', content: 'b' },
        { codecMessageId: 'm-1' },
      );

      fixture.channel.listener?.(runStart('run-9', 'm-1'));

      await expect(first.runId).resolves.toBe('run-9');
      await expect(second.runId).resolves.toBe('run-9');
    });

    it('rejects a pending runId when the transport closes', async () => {
      const fixture = await setup();
      const sent = await fixture.transport.publishInput({ kind: 'user-message', content: 'hi' });

      fixture.transport.close();

      await expect(sent.runId).rejects.toMatchObject({ code: ErrorCode.SessionClosed });
    });

    it('rejects a pending runId on channel continuity loss', async () => {
      const fixture = await setup();
      const sent = await fixture.transport.publishInput({ kind: 'user-message', content: 'hi' });

      fixture.channel.emitStateChange({ current: 'attached', previous: 'attached', resumed: false });

      await expect(sent.runId).rejects.toMatchObject({ code: ErrorCode.SessionContinuityNotGuaranteed });
      // The loss also surfaces once on the error stream.
      expect(fixture.errors).toHaveLength(1);
      expect(fixture.errors[0]).toBeErrorInfoWithCode(ErrorCode.SessionContinuityNotGuaranteed);
    });
  });

  describe('cancel', () => {
    it('publishes a stateless ai-cancel envelope targeting the run', async () => {
      const { transport, channel } = await setup();

      await transport.cancel('run-1');

      expect(channel.publishCalls).toHaveLength(1);
      const [msg] = channel.publishCalls;
      const headers = getTransportHeaders(msg as Ably.InboundMessage);
      expect(headers[HEADER_RUN_ID]).toBe('run-1');
    });
  });

  describe('steer', () => {
    it('publishes a steering user input and resolves published with the echoed serial', async () => {
      const fixture = await setup({ clientId: 'client-a' });
      const { result, steerId } = await startSteer(fixture);

      const headers = fixture.encoderCalls[0]?.options?.extras?.headers ?? {};
      expect(headers[HEADER_ROLE]).toBe('user');
      expect(headers[HEADER_RUN_ID]).toBe('run-1');
      expect(headers[HEADER_CODEC_MESSAGE_ID]).toBe(steerId);
      expect(headers[HEADER_RUN_CLIENT_ID]).toBe('client-a');

      fixture.channel.listener?.(steerEcho(steerId, 'run-1', 's-echo'));

      await expect(result.published).resolves.toEqual({ serial: 's-echo' });
    });

    it('resolves the outcome consumed at run-end when the run stamped the steer', async () => {
      const fixture = await setup();
      const { result, steerId } = await startSteer(fixture);
      fixture.channel.listener?.(steerEcho(steerId, 'run-1', 's-echo'));

      fixture.channel.listener?.(stampedOutput('run-1', [steerId], 's-out'));
      fixture.channel.listener?.(runBracket(EVENT_RUN_END, 'run-1', 'complete'));

      await expect(result.outcome).resolves.toEqual({ consumed: true, runTerminalReason: 'complete' });
    });

    it('resolves the outcome not-consumed at run-end when the run never stamped the steer', async () => {
      const fixture = await setup();
      const { result, steerId } = await startSteer(fixture);
      fixture.channel.listener?.(steerEcho(steerId, 'run-1', 's-echo'));

      fixture.channel.listener?.(runBracket(EVENT_RUN_END, 'run-1', 'complete'));

      await expect(result.outcome).resolves.toEqual({ consumed: false, runTerminalReason: 'complete' });
    });

    it('leaves an unconsumed outcome pending across run-suspend, resolving at the eventual run-end', async () => {
      const fixture = await setup();
      const { result, steerId } = await startSteer(fixture);
      fixture.channel.listener?.(steerEcho(steerId, 'run-1', 's-echo'));

      fixture.channel.listener?.(runBracket(EVENT_RUN_SUSPEND, 'run-1'));
      await flush();
      // Only run-end can definitively report not-consumed; a later resume may
      // still take the steer.
      await expect(Promise.race([result.outcome, Promise.resolve(pending)])).resolves.toBe(pending);

      fixture.channel.listener?.(stampedOutput('run-1', [steerId], 's-out'));
      fixture.channel.listener?.(runBracket(EVENT_RUN_END, 'run-1', 'complete'));
      await expect(result.outcome).resolves.toEqual({ consumed: true, runTerminalReason: 'complete' });
    });

    it('rejects a steer targeting a run whose run-end the transport has observed', async () => {
      const fixture = await setup();
      fixture.channel.listener?.(runBracket(EVENT_RUN_END, 'run-1', 'complete'));

      const result = fixture.transport.steer('run-1', { kind: 'user-message', content: 'go' });

      await expect(result.published).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
      await expect(result.outcome).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
      expect(fixture.encoderCalls).toHaveLength(0);
    });

    it('accepts a runId promise, publishing once the triggering run-start resolves it', async () => {
      const fixture = await setup();
      const sent = await fixture.transport.publishInput({ kind: 'user-message', content: 'book a flight' });

      const result = fixture.transport.steer(sent.runId, { kind: 'user-message', content: 'business class' });
      await flush();
      // The input publish is the only encoder call so far — the steer waits on
      // the runId promise.
      expect(fixture.encoderCalls).toHaveLength(1);

      fixture.channel.listener?.(runStart('run-9', sent.codecMessageId));
      await flush();

      const headers = fixture.encoderCalls[1]?.options?.extras?.headers ?? {};
      expect(headers[HEADER_RUN_ID]).toBe('run-9');
      const steerId = fixture.encoderCalls[1]?.options?.messageId;
      if (steerId === undefined) throw new Error('expected the steer to publish');
      fixture.channel.listener?.(steerEcho(steerId, 'run-9', 's-echo'));
      await expect(result.published).resolves.toEqual({ serial: 's-echo' });
    });

    it('rejects both promises when the runId promise rejects, without publishing', async () => {
      const fixture = await setup();

      const result = fixture.transport.steer(Promise.reject(new Error('no run')), {
        kind: 'user-message',
        content: 'go',
      });

      await expect(result.published).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
      await expect(result.outcome).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
      expect(fixture.encoderCalls).toHaveLength(0);
    });

    it('drains in-flight steers on continuity loss and surfaces the loss on the error stream', async () => {
      const fixture = await setup();
      const { result, steerId } = await startSteer(fixture);
      fixture.channel.listener?.(steerEcho(steerId, 'run-1', 's-echo'));
      // A second steer whose echo never lands stays in the pending-echo ledger.
      const unechoed = fixture.transport.steer('run-1', { kind: 'user-message', content: 'again' });
      await flush();

      fixture.channel.emitStateChange({ current: 'attached', previous: 'attached', resumed: false });

      await expect(result.outcome).rejects.toMatchObject({ code: ErrorCode.SessionContinuityNotGuaranteed });
      await expect(unechoed.published).resolves.toEqual({ serial: undefined });
      await expect(unechoed.outcome).rejects.toMatchObject({ code: ErrorCode.SessionContinuityNotGuaranteed });
      // The loss itself surfaces once on the error stream, so a consumer that
      // was not awaiting a drained promise still learns delivery may have gaps.
      expect(fixture.errors).toHaveLength(1);
      expect(fixture.errors[0]).toBeErrorInfoWithCode(ErrorCode.SessionContinuityNotGuaranteed);
    });

    it('ignores channel state changes before the first attach', async () => {
      const channel = createMockChannel();
      channel.state = 'initialized';
      const encoderCalls: EncoderCall[] = [];
      const transport = createClientTransport<TestInput, TestOutput>({
        channel,
        codec: createMockCodec(encoderCalls, []),
      });
      await transport.connect();
      const { result, steerId } = await startSteer({ transport, encoderCalls });
      channel.listener?.(steerEcho(steerId, 'run-1', 's-echo'));

      // A discontinuity before the channel has ever attached is not a loss.
      channel.emitStateChange({ current: 'suspended', previous: 'attaching', resumed: false });
      await flush();
      await expect(Promise.race([result.outcome, Promise.resolve(pending)])).resolves.toBe(pending);

      // The first attach arms the detector; the next loss drains.
      channel.emitStateChange({ current: 'attached', previous: 'attaching', resumed: false });
      channel.emitStateChange({ current: 'failed', previous: 'attached', resumed: false });
      await expect(result.outcome).rejects.toMatchObject({ code: ErrorCode.SessionContinuityNotGuaranteed });
    });
  });

  describe('history', () => {
    it('returns classified events without emitting to the live streams', async () => {
      const { transport, events, raw } = await setup({
        pages: [[outputMsg('s2', 'two'), outputMsg('s1', 'one')]],
      });

      const result = await transport.history();

      expect(result.exhausted).toBe(true);
      const texts = result.events.map((e) => (e.kind === 'message' ? e.outputs[0]?.text : undefined));
      expect(texts).toEqual(['one', 'two']);
      // Batches never pass through the live streams.
      expect(events).toHaveLength(0);
      expect(raw).toHaveLength(0);
    });

    it('keeps its cursor across calls, so a second call resumes where the first paused', async () => {
      const { transport } = await setup({
        pages: [
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

    it('rejects an already-aborted call before fetching any page', async () => {
      const { transport, channel } = await setup({ pages: [[outputMsg('s1', 'one')]] });
      channel.history.mockClear();

      await expect(transport.history({ signal: AbortSignal.abort() })).rejects.toBeErrorInfoWithCode(
        ErrorCode.OperationCancelled,
      );
      expect(channel.history).not.toHaveBeenCalled();
    });

    it('still pages after an aborted call, so the shared cursor is not wedged', async () => {
      const { transport } = await setup({ pages: [[outputMsg('s2', 'two')], [outputMsg('s1', 'one')]] });

      await expect(transport.history({ signal: AbortSignal.abort() })).rejects.toBeErrorInfoWithCode(
        ErrorCode.OperationCancelled,
      );

      const after = await transport.history({ limit: 2 });
      expect(after.events.map((e) => (e.kind === 'message' ? e.outputs[0]?.text : undefined))).toEqual(['one', 'two']);
      expect(after.exhausted).toBe(true);
    });

    it('completes the batch when onPage throws', async () => {
      const { transport } = await setup({ pages: [[outputMsg('s2', 'two')], [outputMsg('s1', 'one')]] });

      const result = await transport.history({
        limit: 2,
        onPage: () => {
          throw new Error('heartbeat exploded');
        },
      });

      expect(result.events.map((e) => (e.kind === 'message' ? e.outputs[0]?.text : undefined))).toEqual(['one', 'two']);
      expect(result.exhausted).toBe(true);
    });

    it('filters wire-only carriers and routes an undecodable message onto error', async () => {
      const { transport, errors } = await setup({
        pages: [[outputMsg('s3', 'kept'), boomMsg('s2'), noiseMsg('s1')]],
      });

      const result = await transport.history();

      expect(result.events.map((e) => (e.kind === 'message' ? e.outputs[0]?.text : undefined))).toEqual(['kept']);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeErrorInfoWithCode(ErrorCode.SessionMessageProcessingFailed);
    });
  });

  describe('close', () => {
    it('unsubscribes the channel listener and rejects further calls', async () => {
      const { transport, channel, events } = await setup();
      const listener = channel.listener;

      transport.close();

      expect(channel.listener).toBeUndefined();
      // A straggler delivery after close is ignored even if the listener fires.
      listener?.(outputMsg('s1', 'late'));
      expect(events).toHaveLength(0);

      await expect(transport.publishInput({ kind: 'user-message', content: 'hi' })).rejects.toMatchObject({
        code: ErrorCode.SessionClosed,
      });
      await expect(transport.connect()).rejects.toMatchObject({ code: ErrorCode.SessionClosed });
      await expect(transport.history()).rejects.toMatchObject({ code: ErrorCode.SessionClosed });
      const steer = transport.steer('run-1', { kind: 'user-message', content: 'go' });
      await expect(steer.published).rejects.toMatchObject({ code: ErrorCode.SessionClosed });
      await expect(steer.outcome).rejects.toMatchObject({ code: ErrorCode.SessionClosed });
    });

    it('drains an in-flight steer outcome and removes the channel state listener', async () => {
      const { transport, channel, encoderCalls } = await setup();
      const result = transport.steer('run-1', { kind: 'user-message', content: 'go' });
      await flush();
      const steerId = encoderCalls[0]?.options?.messageId;
      if (steerId === undefined) throw new Error('expected the steer to publish');
      channel.listener?.(steerEcho(steerId, 'run-1', 's-echo'));
      await expect(result.published).resolves.toEqual({ serial: 's-echo' });

      transport.close();

      await expect(result.outcome).rejects.toMatchObject({ code: ErrorCode.SessionClosed });
      expect(channel.stateListeners.size).toBe(0);
    });
  });
});
