/**
 * AgentSession unit tests.
 *
 * Mock encoder uses split-direction `publishInput` / `publishOutput`;
 * `addEvents` and `pipe` flow through `encoder.publishOutput`, and the channel
 * subscription is unfiltered (cancel + input events + everything else dispatched
 * via the same listener).
 */

import '../../helper/expectations.js';

import * as Ably from 'ably';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EVENT_CANCEL,
  EVENT_RUN_START,
  HEADER_CODEC_MESSAGE_ID,
  HEADER_EVENT_ID,
  HEADER_FORK_OF,
  HEADER_INPUT_CODEC_MESSAGE_ID,
  HEADER_INVOCATION_ID,
  HEADER_MSG_REGENERATE,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_RUN_ID,
} from '../../../src/constants.js';
import type {
  ChannelWriter,
  Codec,
  CodecInputEvent,
  Decoder,
  Encoder,
  EncoderOptions,
  ReducerMeta,
  WriteOptions,
} from '../../../src/core/codec/types.js';
import { createAgentSession } from '../../../src/core/transport/agent-session.js';
import { Invocation } from '../../../src/core/transport/invocation.js';
import type { DefaultTree } from '../../../src/core/transport/tree.js';
import { createTree } from '../../../src/core/transport/tree.js';
import type { AgentSession } from '../../../src/core/transport/types.js';
import type { SendDelegate } from '../../../src/core/transport/view.js';
import { DefaultView } from '../../../src/core/transport/view.js';
import { ErrorCode } from '../../../src/errors.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';
import { VERSION } from '../../../src/version.js';
import { createMockClient } from '../../helper/mock-client.js';
import { createRunFromOpts } from '../../helper/run-from-opts.js';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Client-published input variants. */
interface TestInput extends CodecInputEvent {
  kind: 'user-message';
  message: TestMessage;
}

/** Agent-published output variants. */
interface TestOutput {
  type: string;
  text?: string;
}

interface TestMessage {
  id: string;
  content: string;
}
interface TestProjection {
  messages: TestMessage[];
}

// ---------------------------------------------------------------------------
// Mock channel — unfiltered subscribe + cancel dispatch
// ---------------------------------------------------------------------------

interface MockChannel {
  publish: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  attach: ReturnType<typeof vi.fn>;
  history: ReturnType<typeof vi.fn>;
  state: Ably.ChannelState;
  publishCalls: Ably.Message[];
  listener: ((msg: Ably.InboundMessage) => void) | undefined;
  stateListeners: Set<Ably.channelEventCallback>;
}

const createMockChannel = (): MockChannel & Ably.RealtimeChannel => {
  const stateListeners = new Set<Ably.channelEventCallback>();
  const mock: MockChannel = {
    publishCalls: [],
    listener: undefined,
    stateListeners,
    state: 'attached',
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    publish: vi.fn((msg: Ably.Message | Ably.Message[]) => {
      if (Array.isArray(msg)) mock.publishCalls.push(...msg);
      else mock.publishCalls.push(msg);
      return Promise.resolve({ serials: ['serial-1'] });
    }),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    subscribe: vi.fn((listener: (msg: Ably.InboundMessage) => void) => {
      mock.listener = listener;
      return Promise.resolve();
    }),
    unsubscribe: vi.fn(),
    on: vi.fn((callback: Ably.channelEventCallback) => {
      stateListeners.add(callback);
    }),
    off: vi.fn((callback?: Ably.channelEventCallback) => {
      if (callback) stateListeners.delete(callback);
      else stateListeners.clear();
    }),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    attach: vi.fn(() => Promise.resolve()),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    history: vi.fn(() => {
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
      const empty = { items: [], hasNext: () => false, next: () => Promise.resolve(empty) };
      return Promise.resolve(empty);
    }),
  };
  // CAST: Tests only use the listed members.
  return mock as unknown as MockChannel & Ably.RealtimeChannel;
};

const simulateStateChange = (ch: MockChannel, stateChange: Ably.ChannelStateChange): void => {
  for (const listener of ch.stateListeners) {
    listener(stateChange);
  }
};

const simulateInitialAttach = (ch: MockChannel): void => {
  simulateStateChange(ch, {
    current: 'attached',
    previous: 'attaching',
    resumed: false,
  });
};

const simulateCancel = (channel: MockChannel, headers: Record<string, string>): void => {
  if (!channel.listener) return;
  const msg = {
    name: EVENT_CANCEL,
    extras: { ai: { transport: headers } },
  } as unknown as Ably.InboundMessage;
  channel.listener(msg);
};

// ---------------------------------------------------------------------------
// Mock codec — direction-split encoder (publishInput / publishOutput)
// ---------------------------------------------------------------------------

/** Single shape for both input and output publishes — `publishCalls` mixes both. */
interface MockPublishCall {
  /** Tagged direction so assertions can filter input vs output publishes. */
  direction: 'input' | 'output';
  /** The TInput or TOutput that was published. */
  event: TestInput | TestOutput;
  /** Per-write overrides supplied at publish time. */
  opts: WriteOptions | undefined;
}

interface MockEncoder extends Encoder<TestInput, TestOutput> {
  publishCalls: MockPublishCall[];
  failPublishWith: Error | undefined;
}

interface MockCodec extends Codec<TestInput, TestOutput, TestProjection, TestMessage> {
  encoderCalls: { writer: ChannelWriter; opts: EncoderOptions | undefined }[];
  encoders: MockEncoder[];
  lastEncoder(): MockEncoder | undefined;
  lastEncoderOpts(): EncoderOptions | undefined;
}

const createMockEncoder = (failWith?: Error): MockEncoder => {
  const calls: MockPublishCall[] = [];
  const enc: MockEncoder = {
    publishCalls: calls,
    failPublishWith: failWith,
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    publishInput: vi.fn((event: TestInput, opts?: WriteOptions) => {
      if (enc.failPublishWith) return Promise.reject(enc.failPublishWith);
      calls.push({ direction: 'input', event, opts });
      return Promise.resolve();
    }),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    publishOutput: vi.fn((event: TestOutput, opts?: WriteOptions) => {
      if (enc.failPublishWith) return Promise.reject(enc.failPublishWith);
      calls.push({ direction: 'output', event, opts });
      return Promise.resolve();
    }),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    cancel: vi.fn(() => Promise.resolve()),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    close: vi.fn(() => Promise.resolve()),
  };
  return enc;
};

const createMockDecoder = (): Decoder<TestInput, TestOutput> => ({
  decode: vi.fn(() => ({ inputs: [], outputs: [] })),
});

const createMockCodec = (overrides?: { encoderFactory?: () => MockEncoder }): MockCodec => {
  const encoders: MockEncoder[] = [];
  const encoderCalls: { writer: ChannelWriter; opts: EncoderOptions | undefined }[] = [];
  const codec: MockCodec = {
    encoders,
    encoderCalls,
    lastEncoder: () => encoders.at(-1),
    lastEncoderOpts: () => encoderCalls.at(-1)?.opts,
    init: vi.fn((): TestProjection => ({ messages: [] })),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- reducer signature; event/meta unused by this stub
    fold: vi.fn((state: TestProjection, _event: TestInput | TestOutput, _meta: ReducerMeta) => state),
    getMessages: vi.fn((p: TestProjection) => p.messages.map((m) => ({ codecMessageId: m.id, message: m }))),
    createUserMessage: vi.fn((m: TestMessage) => ({ kind: 'user-message' as const, message: m })),
    createRegenerate: vi.fn(
      (target: string, parent: string) => ({ kind: 'regenerate' as const, target, parent }) as const,
    ),
    createEncoder: vi.fn((writer: ChannelWriter, opts?: EncoderOptions) => {
      encoderCalls.push({ writer, opts });
      const enc = overrides?.encoderFactory ? overrides.encoderFactory() : createMockEncoder();
      encoders.push(enc);
      return enc;
    }),
    createDecoder: vi.fn(() => createMockDecoder()),
  };
  return codec;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const streamOf = (...events: TestOutput[]): ReadableStream<TestOutput> =>
  new ReadableStream({
    start: (controller) => {
      for (const event of events) {
        controller.enqueue(event);
      }
      controller.close();
    },
  });

// eslint-disable-next-line @typescript-eslint/no-empty-function -- shared no-op for logger fakes
const loggerNoop = (): void => {};

/**
 * Build a Logger fake that captures warn calls into a vitest mock. All
 * other levels are no-ops; `withContext` returns the same logger so
 * messages logged from child contexts also flow into `warn`.
 * @returns Logger fake plus the `warn` mock for assertions.
 */
const captureWarnLogger = (): {
  logger: import('../../../src/logger.js').Logger;
  warn: ReturnType<typeof vi.fn>;
} => {
  const warn = vi.fn();
  const logger: import('../../../src/logger.js').Logger = {
    trace: loggerNoop,
    debug: loggerNoop,
    info: loggerNoop,
    warn,
    error: loggerNoop,
    withContext: () => logger,
  };
  return { logger, warn };
};

/**
 * Build a codec mock whose decoder yields one synthetic TestMessage per
 * inbound Ably message — sufficient to exercise the lookup's accumulation,
 * dedup-by-serial, and sort-on-resolve behavior without standing up a real
 * codec. The decoder reads the codec-message-id header from each inbound message and
 * emits a `user-message` event carrying that id; `fold` appends it to the
 * projection's `messages` list so `getMessages` returns one message per
 * inbound Ably message.
 * @returns A codec that decodes each inbound message into a single message whose id reflects the inbound codecMessageId header.
 */
const codecWithFunctionalDecoder = (): Codec<TestInput, TestOutput, TestProjection, TestMessage> => ({
  init: (): TestProjection => ({ messages: [] }),
  fold: (state: TestProjection, event: TestInput | TestOutput): TestProjection => {
    // TestInput has only the user-message variant; outputs (TestOutput) pass
    // through unchanged.
    if ('kind' in event) {
      return { messages: [...state.messages, { id: event.message.id, content: event.message.content }] };
    }
    return state;
  },
  getMessages: (p: TestProjection) => p.messages.map((m) => ({ codecMessageId: m.id, message: m })),
  createUserMessage: (m: TestMessage) => ({ kind: 'user-message' as const, message: m }),
  createRegenerate: (target: string, parent: string) => ({ kind: 'regenerate' as const, target, parent }),
  createEncoder: vi.fn(() => createMockEncoder()),
  createDecoder: vi.fn(() => ({
    decode: (m: Ably.InboundMessage) => {
      const hdrs = (m.extras as { ai?: { transport?: Record<string, string> } } | undefined)?.ai?.transport ?? {};
      const id = hdrs[HEADER_CODEC_MESSAGE_ID] ?? 'unknown';
      // A regenerate carrier is a wire-only signal — it decodes to zero events
      // (no MessageNode), so the agent's structural parent falls back to the
      // wire's own `parent` (the original user prompt). Every other inbound
      // message synthesises one user-message TInput that the input-event lookup
      // folds into a MessageNode.
      if (hdrs[HEADER_MSG_REGENERATE] !== undefined) {
        return { inputs: [], outputs: [] };
      }
      return {
        inputs: [{ kind: 'user-message' as const, message: { id, content: id } }],
        outputs: [],
      };
    },
  })),
});

interface DeliverInputEventOpts {
  /** The invocation-id header to stamp on the synthetic message. */
  invocationId: string;
  /** Optional run-id header. */
  runId?: string;
  /** The codec-message-id header. */
  codecMessageId: string;
  /** Ably serial (used for dedup and sort assertions). */
  serial: string;
  /** Optional Ably message name; defaults to 'text'. */
  name?: string;
  /** Input-event id (`event-id`) the agent matches against `invocation.inputEventIds`. */
  inputEventId?: string;
  /** Optional `run-client-id` header — populates the run's `clientId` resolution. */
  runClientId?: string;
  /**
   * Optional Ably-level publisher `clientId` (set on the inbound message's
   * `clientId` field, not in `extras.ai`). The agent reads this as the
   * `inputClientId` for re-stamping on its own published events.
   */
  publisherClientId?: string;
  /** Optional `parent` header — resolves the run's parent during input-event lookup. */
  parent?: string;
  /** Optional `fork-of` header — resolves the run's forkOf during input-event lookup. */
  forkOf?: string;
  /**
   * Optional `msg-regenerate` header — resolves the run's regenerate
   * anchor during input-event lookup. Mutually exclusive with `forkOf` per
   * AITRFC-014 (edits and regenerates anchor at different headers).
   */
  regenerates?: string;
}

/**
 * Deliver a synthetic input event to the session's unfiltered
 * channel listener. Mirrors the path real Ably messages would take.
 * @param ch - The mock channel hosting the session's listener.
 * @param opts - Headers, serial, and message name for the synthetic message.
 */
const deliverInputEvent = (ch: MockChannel, opts: DeliverInputEventOpts): void => {
  const headers: Record<string, string> = {
    [HEADER_ROLE]: 'user',
    [HEADER_INVOCATION_ID]: opts.invocationId,
    [HEADER_CODEC_MESSAGE_ID]: opts.codecMessageId,
    // Always stamp a event-id — the agent dispatcher routes input-event
    // messages by `event-id`, not by role, so without one the
    // synthetic message wouldn't reach the buffer/lookup path. Tests that
    // care about the specific id supply it via `opts.inputEventId`; otherwise
    // we derive a unique value from the codec-message-id.
    [HEADER_EVENT_ID]: opts.inputEventId ?? `p-${opts.codecMessageId}`,
  };
  if (opts.runId) headers[HEADER_RUN_ID] = opts.runId;
  if (opts.runClientId) headers['run-client-id'] = opts.runClientId;
  if (opts.parent) headers[HEADER_PARENT] = opts.parent;
  if (opts.forkOf) headers['fork-of'] = opts.forkOf;
  if (opts.regenerates) headers['msg-regenerate'] = opts.regenerates;
  const msg = {
    name: opts.name ?? 'text',
    serial: opts.serial,
    clientId: opts.publisherClientId,
    extras: { ai: { transport: headers } },
  } as unknown as Ably.InboundMessage;
  if (ch.listener) ch.listener(msg);
};

/**
 * Stand up a session whose runs go through a real input-event lookup so a
 * fresh run resolves its triggering input codec-message-id at start() — the
 * point at which the deferred-cancel buffer is pulled.
 * @returns The session and its mock channel.
 */
const lookupSession = (): {
  session: ReturnType<typeof createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>>;
  ch: MockChannel & Ably.RealtimeChannel;
} => {
  const ch = createMockChannel();
  const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
    client: createMockClient(ch),
    channelName: 'cancel-before-start',
    codec: codecWithFunctionalDecoder(),
    inputEventLookupTimeoutMs: 5000,
  });
  return { session, ch };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentSession', () => {
  let channel: MockChannel & Ably.RealtimeChannel;
  let codec: MockCodec;
  let session: AgentSession<TestOutput, TestProjection, TestMessage>;

  beforeEach(async () => {
    channel = createMockChannel();
    codec = createMockCodec();
    session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(channel),
      channelName: 'test-channel',
      codec,
    });
    await session.connect();
  });

  afterEach(() => {
    session.close();
  });

  // -------------------------------------------------------------------------
  // construction
  // -------------------------------------------------------------------------

  describe('construction', () => {
    it('exposes a createRun factory and close method', () => {
      expect(typeof session.createRun).toBe('function');
      expect(typeof session.close).toBe('function');
    });

    it('registers the agent and resolves the channel via client.channels.get', () => {
      const ch = createMockChannel();
      const client = createMockClient(ch);
      const s = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client,
        channelName: 'agent-channel',
        codec,
      });
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock check
      expect(client.channels.get).toHaveBeenCalled();
      s.close();
    });

    it('forwards a custom rewindWindow to params.rewind', () => {
      const ch = createMockChannel();
      const client = createMockClient(ch);
      const c = createMockCodec();
      const s = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client,
        channelName: 'rewind-channel',
        codec: c,
        rewindWindow: '5m',
      });
      // eslint-disable-next-line @typescript-eslint/unbound-method -- accessing vi mock
      expect(client.channels.get).toHaveBeenCalledWith('rewind-channel', {
        params: { agent: `ai-transport-js/${VERSION}`, rewind: '5m' },
      });
      s.close();
    });

    it('does not pollute options.agents when constructing multiple sessions on the same client', () => {
      const ch1 = createMockChannel();
      const ch2 = createMockChannel();
      const client = createMockClient(ch1);
      const optionsRef = (client as unknown as { options: { agents?: Record<string, string> } }).options;
      // Seed an unrelated entry so we can assert it survives.
      optionsRef.agents = { 'some-other-sdk': '9.9.9' };
      const c = createMockCodec();
      const s1 = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client,
        channelName: 'ch-a',
        codec: c,
      });
      // Swap the channel returned by channels.get for the second session so
      // each session has its own channel mock to publish to.
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.mocked takes a method reference
      vi.mocked(client.channels.get).mockReturnValue(ch2);
      const s2 = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client,
        channelName: 'ch-b',
        codec: c,
      });
      expect(optionsRef.agents).toEqual({
        'some-other-sdk': '9.9.9',
        'ai-transport-js': VERSION,
      });
      s1.close();
      s2.close();
    });
  });

  // -------------------------------------------------------------------------
  // connect()
  // -------------------------------------------------------------------------

  describe('connect()', () => {
    it('is idempotent — repeated calls return the same promise', async () => {
      const ch = createMockChannel();
      const s = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: createMockCodec(),
      });
      const p1 = s.connect();
      const p2 = s.connect();
      expect(p1).toBe(p2);
      await Promise.all([p1, p2]);
      expect(ch.subscribe).toHaveBeenCalledTimes(1);
      s.close();
    });

    it('subscribes unfiltered (single listener installed)', () => {
      // beforeEach already connected, so listener is set
      expect(channel.subscribe).toHaveBeenCalledTimes(1);
      expect(typeof channel.listener).toBe('function');
    });

    it('rejects connect when subscribe fails', async () => {
      const ch = createMockChannel();
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.reject directly
      ch.subscribe = vi.fn(() => Promise.reject(new Error('subscribe down')));
      const onError = vi.fn();
      const s = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: createMockCodec(),
        onError,
      });
      await expect(s.connect()).rejects.toBeErrorInfoWithCode(ErrorCode.SessionSubscriptionError);
      expect(onError).toHaveBeenCalled();
      s.close();
    });

    it('Run methods throw InvalidArgument before connect()', async () => {
      const ch = createMockChannel();
      const s = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: createMockCodec(),
      });
      const run = createRunFromOpts(s, { runId: 'run-x' });
      await expect(run.start()).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
      s.close();
    });
  });

  // -------------------------------------------------------------------------
  // run lifecycle
  // -------------------------------------------------------------------------

  describe('run lifecycle', () => {
    it('start() publishes run-start with run headers', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();

      const startMsg = channel.publishCalls.find((m) => m.name === 'ai-run-start');
      expect(startMsg).toBeDefined();
      const headers = (startMsg?.extras as { ai?: { transport?: Record<string, string> } } | undefined)?.ai?.transport;
      expect(headers?.[HEADER_RUN_ID]).toBe('run-1');
    });

    it('start() publishes ai-run-resume (not ai-run-start) when the triggering input carries a wire run-id', async () => {
      // The agent decides fresh-vs-continuation from the run-id on the
      // triggering input event's wire headers: a continuation's input carries
      // a run-id, so the agent re-enters the run via ai-run-resume.
      const ch = createMockChannel();
      const c = codecWithFunctionalDecoder();
      const s = createAgentSession({
        client: createMockClient(ch),
        channelName: 'continue',
        codec: c,
        inputEventLookupTimeoutMs: 5000,
      });
      await s.connect();

      const runId = 'run-cont';
      const invocationId = 'inv-cont';
      const inputEventId = 'p-cont';
      const run = createRunFromOpts(s, { runId, invocationId, inputEventId: inputEventId });
      const startPromise = run.start();
      deliverInputEvent(ch, {
        invocationId,
        runId,
        codecMessageId: 'm-cont',
        serial: 's-cont',
        inputEventId,
      });
      await startPromise;

      expect(ch.publishCalls.find((m) => m.name === 'ai-run-resume')).toBeDefined();
      expect(ch.publishCalls.find((m) => m.name === 'ai-run-start')).toBeUndefined();
      s.close();
    });

    it('start() publishes ai-run-start (not ai-run-resume) when no continuation header is present', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();

      expect(channel.publishCalls.find((m) => m.name === 'ai-run-start')).toBeDefined();
      expect(channel.publishCalls.find((m) => m.name === 'ai-run-resume')).toBeUndefined();
    });

    it('start() stamps msg-regenerate on run-start when the input-event lookup result carries the regenerate anchor', async () => {
      // Regenerate is a Run-level continuation, not a fork: the agent
      // re-stamps the `msg-regenerate` it observed on the input-event
      // wire onto run-start so the client Tree can record the
      // regeneratesCodecMessageId for message-level replacement.
      const ch = createMockChannel();
      const c = codecWithFunctionalDecoder();
      const s = createAgentSession({
        client: createMockClient(ch),
        channelName: 'regen',
        codec: c,
        inputEventLookupTimeoutMs: 5000,
      });
      await s.connect();

      const runId = 'run-regen';
      const invocationId = 'inv-regen';
      const inputEventId = 'p-regen';
      const run = createRunFromOpts(s, { runId, invocationId, inputEventId });
      const startPromise = run.start();
      // Fresh run (regenerate opens a new run via ai-run-start) — the triggering
      // input carries NO wire run-id, so the agent stamps regenerate/parent on
      // run-start. The run's identity is pinned via createRunFromOpts above.
      deliverInputEvent(ch, {
        invocationId,
        codecMessageId: 'm-regen',
        serial: 's-regen',
        inputEventId,
        parent: 'orig-user',
        regenerates: 'orig-asst',
      });
      await startPromise;

      const startMsg = ch.publishCalls.find((m) => m.name === 'ai-run-start');
      const headers = (startMsg?.extras as { ai?: { transport?: Record<string, string> } } | undefined)?.ai?.transport;
      expect(headers?.['msg-regenerate']).toBe('orig-asst');
      expect(headers?.parent).toBe('orig-user');
      expect(headers?.['fork-of']).toBeUndefined();
      s.close();
    });

    it('end() publishes run-end with reason', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      await run.end('complete');

      const endMsg = channel.publishCalls.find((m) => m.name === 'ai-run-end');
      expect(endMsg).toBeDefined();
    });

    it('start() stamps input attribution from the triggering input event', async () => {
      // The agent reads the publisher's Ably-level clientId AND the input's
      // codec-message-id off the input event matched by the input-event lookup
      // and re-stamps both on its own published events. Here the synthetic
      // input event is published by 'user-b' with codec-message-id
      // 'm-icid-start', so every agent-published event in the invocation
      // carries inputClientId: 'user-b' and input-codec-message-id:
      // 'm-icid-start' — independent of who owns the run.
      const runId = 'run-icid-start';
      const invocationId = 'inv-icid-start';
      const inputEventId = 'p-icid-start';
      const run = createRunFromOpts(session, { runId, invocationId, inputEventId: inputEventId });
      const startPromise = run.start();
      // Fresh send — the triggering input carries NO wire run-id, so the agent
      // opens the run with ai-run-start. Run identity is pinned via
      // createRunFromOpts above.
      deliverInputEvent(channel, {
        invocationId,
        codecMessageId: 'm-icid-start',
        serial: 's-icid-start',
        inputEventId,
        publisherClientId: 'user-b',
      });
      await startPromise;

      const startMsg = channel.publishCalls.find((m) => m.name === 'ai-run-start');
      const headers = (startMsg?.extras as { ai?: { transport?: Record<string, string> } } | undefined)?.ai?.transport;
      expect(headers?.['input-client-id']).toBe('user-b');
      expect(headers?.['input-codec-message-id']).toBe('m-icid-start');
    });

    it('end() stamps input attribution from the triggering input event', async () => {
      const runId = 'run-icid-end';
      const invocationId = 'inv-icid-end';
      const inputEventId = 'p-icid-end';
      const run = createRunFromOpts(session, { runId, invocationId, inputEventId: inputEventId });
      const startPromise = run.start();
      deliverInputEvent(channel, {
        invocationId,
        runId,
        codecMessageId: 'm-icid-end',
        serial: 's-icid-end',
        inputEventId,
        publisherClientId: 'user-b',
      });
      await startPromise;
      await run.end('complete');

      const endMsg = channel.publishCalls.find((m) => m.name === 'ai-run-end');
      const headers = (endMsg?.extras as { ai?: { transport?: Record<string, string> } } | undefined)?.ai?.transport;
      expect(headers?.['input-client-id']).toBe('user-b');
      expect(headers?.['input-codec-message-id']).toBe('m-icid-end');
    });

    it('start() is idempotent (subsequent calls are no-ops)', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      await run.start();
      // Only one run-start publish on the channel
      const startMsgs = channel.publishCalls.filter((m) => m.name === 'ai-run-start');
      expect(startMsgs).toHaveLength(1);
    });

    it('pipe() throws if run not started', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await expect(run.pipe(streamOf({ type: 'text' }))).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });

    it('end() throws if run not started', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await expect(run.end('complete')).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });

    it('suspend() publishes run-suspend (not run-end)', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      await run.suspend();

      expect(channel.publishCalls.find((m) => m.name === 'ai-run-suspend')).toBeDefined();
      expect(channel.publishCalls.find((m) => m.name === 'ai-run-end')).toBeUndefined();
    });

    it('suspend() stamps input attribution from the triggering input event', async () => {
      // A suspend is the terminal event of the suspending invocation, so it
      // carries the same per-invocation attribution as run-end: the input
      // client-id and the triggering input's codec-message-id.
      const runId = 'run-icid-suspend';
      const invocationId = 'inv-icid-suspend';
      const inputEventId = 'p-icid-suspend';
      const run = createRunFromOpts(session, { runId, invocationId, inputEventId });
      const startPromise = run.start();
      deliverInputEvent(channel, {
        invocationId,
        runId,
        codecMessageId: 'm-icid-suspend',
        serial: 's-icid-suspend',
        inputEventId,
        publisherClientId: 'user-b',
      });
      await startPromise;
      await run.suspend();

      const suspendMsg = channel.publishCalls.find((m) => m.name === 'ai-run-suspend');
      const headers = (suspendMsg?.extras as { ai?: { transport?: Record<string, string> } } | undefined)?.ai
        ?.transport;
      expect(headers?.['invocation-id']).toBe(invocationId);
      expect(headers?.['input-client-id']).toBe('user-b');
      expect(headers?.['input-codec-message-id']).toBe('m-icid-suspend');
    });

    it('suspend() throws if run not started', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await expect(run.suspend()).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });

    it('suspend() is terminal for the run instance: a following end() is a no-op', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      await run.suspend();
      await run.end('complete');

      // The run was suspended, not ended — no run-end is published.
      expect(channel.publishCalls.filter((m) => m.name === 'ai-run-suspend')).toHaveLength(1);
      expect(channel.publishCalls.find((m) => m.name === 'ai-run-end')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // addEvents — publish each event with target's codec-message-id + amend header
  // -------------------------------------------------------------------------

  describe('addEvents', () => {
    it('creates encoder with HEADER_CODEC_MESSAGE_ID pointing at the target codec-message-id', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      await run.addEvents([{ kind: 'event', codecMessageId: 'target-msg-1', events: [{ type: 'tool-output' }] }]);

      const headers = codec.lastEncoderOpts()?.extras?.headers ?? {};
      expect(headers[HEADER_ROLE]).toBe('assistant');
      // HEADER_CODEC_MESSAGE_ID = target's id so the reducer routes the events onto
      // the existing message via its standard per-message-id fold path.
      expect(headers[HEADER_CODEC_MESSAGE_ID]).toBe('target-msg-1');
      expect(headers[HEADER_RUN_ID]).toBe('run-1');
      expect(headers[HEADER_INVOCATION_ID]).toBe('run-1-inv');
    });

    it('stamps input attribution from the triggering input event on addEvents publishes', async () => {
      const runId = 'run-icid-ae';
      const invocationId = 'inv-icid-ae';
      const inputEventId = 'p-icid-ae';
      const run = createRunFromOpts(session, { runId, invocationId, inputEventId: inputEventId });
      const startPromise = run.start();
      deliverInputEvent(channel, {
        invocationId,
        runId,
        codecMessageId: 'm-icid-ae',
        serial: 's-icid-ae',
        inputEventId,
        publisherClientId: 'user-b',
      });
      await startPromise;
      await run.addEvents([{ kind: 'event', codecMessageId: 'target-1', events: [{ type: 'ev' }] }]);

      const headers = codec.lastEncoderOpts()?.extras?.headers ?? {};
      expect(headers['input-client-id']).toBe('user-b');
      expect(headers['input-codec-message-id']).toBe('m-icid-ae');
    });

    it('calls encoder.publishOutput per event', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      await run.addEvents([
        {
          kind: 'event',
          codecMessageId: 'target-1',
          events: [{ type: 'ev-a' }, { type: 'ev-b' }, { type: 'ev-c' }],
        },
      ]);
      const enc = codec.lastEncoder();
      expect(enc?.publishCalls).toHaveLength(3);
      const outputs = enc?.publishCalls.filter((c) => c.direction === 'output').map((c) => c.event as TestOutput);
      expect(outputs?.map((e) => e.type)).toEqual(['ev-a', 'ev-b', 'ev-c']);
    });

    it('throws if run not started', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await expect(
        run.addEvents([{ kind: 'event', codecMessageId: 'target-1', events: [{ type: 'ev' }] }]),
      ).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });

    it('uses one encoder per EventsNode (distinct target codec-message-ids)', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      // Reset counts after start (start publishes run-start, no encoder)
      const before = codec.encoderCalls.length;
      await run.addEvents([
        { kind: 'event', codecMessageId: 'target-1', events: [{ type: 'ev-1' }] },
        { kind: 'event', codecMessageId: 'target-2', events: [{ type: 'ev-2' }] },
      ]);
      // Two nodes → two encoders
      expect(codec.encoderCalls.length - before).toBe(2);
      // Each encoder stamps HEADER_CODEC_MESSAGE_ID = its target id
      const first = codec.encoderCalls[before]?.opts?.extras?.headers ?? {};
      const second = codec.encoderCalls[before + 1]?.opts?.extras?.headers ?? {};
      expect(first[HEADER_CODEC_MESSAGE_ID]).toBe('target-1');
      expect(second[HEADER_CODEC_MESSAGE_ID]).toBe('target-2');
    });

    it('closes each encoder after publishing all events', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      await run.addEvents([{ kind: 'event', codecMessageId: 'target-1', events: [{ type: 'ev-1' }] }]);
      const enc = codec.lastEncoder();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock check
      expect(enc?.close).toHaveBeenCalled();
    });

    it('throws RunLifecycleError when an encoder.publishOutput fails', async () => {
      const failCodec = createMockCodec({
        encoderFactory: () => createMockEncoder(new Ably.ErrorInfo('boom', 40000, 500)),
      });
      const failSession = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(channel),
        channelName: 'test-channel',
        codec: failCodec,
      });
      await failSession.connect();
      const run = createRunFromOpts(failSession, { runId: 'run-1' });
      await run.start();
      await expect(
        run.addEvents([{ kind: 'event', codecMessageId: 'target-1', events: [{ type: 'ev' }] }]),
      ).rejects.toBeErrorInfoWithCode(ErrorCode.RunLifecycleError);
      failSession.close();
    });
  });

  // -------------------------------------------------------------------------
  // pipe — stream events through encoder.publish
  // -------------------------------------------------------------------------

  describe('pipe', () => {
    it('creates encoder with assistant-role transport headers', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      await run.pipe(streamOf({ type: 'text', text: 'hi' }));

      const headers = codec.lastEncoderOpts()?.extras?.headers ?? {};
      expect(headers[HEADER_ROLE]).toBe('assistant');
      expect(headers[HEADER_RUN_ID]).toBe('run-1');
      expect(headers[HEADER_INVOCATION_ID]).toBe('run-1-inv');
    });

    it('stamps input attribution from the triggering input event on assistant publishes', async () => {
      const runId = 'run-icid-pipe';
      const invocationId = 'inv-icid-pipe';
      const inputEventId = 'p-icid-pipe';
      const run = createRunFromOpts(session, { runId, invocationId, inputEventId: inputEventId });
      const startPromise = run.start();
      deliverInputEvent(channel, {
        invocationId,
        runId,
        codecMessageId: 'm-icid-pipe',
        serial: 's-icid-pipe',
        inputEventId,
        publisherClientId: 'user-b',
      });
      await startPromise;
      await run.pipe(streamOf({ type: 'text', text: 'hi' }));

      const headers = codec.lastEncoderOpts()?.extras?.headers ?? {};
      expect(headers['input-client-id']).toBe('user-b');
      expect(headers['input-codec-message-id']).toBe('m-icid-pipe');
    });

    it('publishes each stream event through encoder.publishOutput', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      await run.pipe(streamOf({ type: 'text', text: 'a' }, { type: 'text', text: 'b' }));

      const enc = codec.lastEncoder();
      expect(enc?.publishCalls).toHaveLength(2);
      const outputs = enc?.publishCalls.filter((c) => c.direction === 'output').map((c) => c.event as TestOutput);
      expect(outputs?.map((e) => e.text)).toEqual(['a', 'b']);
    });

    it('returns reason: complete for a normal stream', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      const result = await run.pipe(streamOf({ type: 'text', text: 'done' }));
      expect(result.reason).toBe('complete');
    });

    it('uses explicit parent from pipe options', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      await run.pipe(streamOf({ type: 'text', text: 'a' }), { parent: 'parent-msg' });

      const headers = codec.lastEncoderOpts()?.extras?.headers ?? {};
      expect(headers[HEADER_PARENT]).toBe('parent-msg');
    });

    it('echoes msg-regenerate from the input-event lookup onto the assistant pipe headers (race-condition safety)', async () => {
      // The lifecycle event is the canonical source for `regenerates`,
      // but if the assistant wire arrives before run-start on the client
      // (history pagination boundary or out-of-order delivery), the Tree
      // creates the Run from headers and needs `msg-regenerate` on
      // the assistant wire to populate `RunNode.regeneratesCodecMessageId`.
      // Mirrors how the agent echoes `fork-of` for edit runs.
      const ch = createMockChannel();
      const base = codecWithFunctionalDecoder();
      let capturedHeaders: Record<string, string> | undefined;
      const c: Codec<TestInput, TestOutput, TestProjection, TestMessage> = {
        ...base,
        createEncoder: (writer: ChannelWriter, opts?: EncoderOptions) => {
          capturedHeaders = opts?.extras?.headers;
          return createMockEncoder();
        },
      };
      const s = createAgentSession({
        client: createMockClient(ch),
        channelName: 'pipe-regen-echo',
        codec: c,
        inputEventLookupTimeoutMs: 5000,
      });
      await s.connect();

      const runId = 'r-rg';
      const invocationId = 'inv-rg';
      const inputEventId = 'p-rg';
      const run = createRunFromOpts(s, { runId, invocationId, inputEventId });
      const startPromise = run.start();
      deliverInputEvent(ch, {
        invocationId,
        runId,
        codecMessageId: 'm-rg',
        serial: 's-rg',
        inputEventId,
        parent: 'orig-user',
        regenerates: 'orig-asst',
      });
      await startPromise;

      await run.pipe(streamOf({ type: 'text', text: 'reply' }));

      // The regenerate anchor is echoed on the assistant wire so that a
      // race between assistant chunks and ai-run-start doesn't drop the
      // regenerate metadata. `parent` resolution is exercised elsewhere;
      // here we only assert the regenerate header survives the pipe.
      expect(capturedHeaders?.['msg-regenerate']).toBe('orig-asst');
      expect(capturedHeaders?.['fork-of']).toBeUndefined();
      s.close();
    });

    it('defaults assistant parent to the most recently looked-up input event', async () => {
      // Stand up a session whose input-event lookup will resolve via the channel
      // dispatcher — this populates `run.view.messages` with the input event
      // before pipe runs, exercising the new default.
      const ch = createMockChannel();
      const base = codecWithFunctionalDecoder();
      // Wrap createEncoder to capture the headers Run.pipe stamps as defaults.
      let capturedHeaders: Record<string, string> | undefined;
      const c: Codec<TestInput, TestOutput, TestProjection, TestMessage> = {
        ...base,
        createEncoder: (writer: ChannelWriter, opts?: EncoderOptions) => {
          capturedHeaders = opts?.extras?.headers;
          return createMockEncoder();
        },
      };
      const s = createAgentSession({
        client: createMockClient(ch),
        channelName: 'pipe-parent-default',
        codec: c,
        inputEventLookupTimeoutMs: 5000,
      });
      await s.connect();

      const runId = 'r-pp';
      const invocationId = 'inv-pp';
      const run = createRunFromOpts(s, { runId, invocationId, inputEventId: 'p-u1' });
      const startPromise = run.start();
      deliverInputEvent(ch, { invocationId, runId, codecMessageId: 'user-1', serial: '01', inputEventId: 'p-u1' });
      await startPromise;

      await run.pipe(streamOf({ type: 'text', text: 'reply' }));

      expect(capturedHeaders?.[HEADER_PARENT]).toBe('user-1');
      s.close();
    });

    it('omits parent header when view.messages is empty and no pipe parent is supplied', async () => {
      // Per-message metadata is resolved from the input-event lookup result. With
      // no event-id (and thus no lookup), `run.view.messages` stays empty
      // and pipe falls through with no parent header on the encoder defaults.
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      await run.pipe(streamOf({ type: 'text', text: 'reply' }));

      const headers = codec.lastEncoderOpts()?.extras?.headers ?? {};
      expect(headers[HEADER_PARENT]).toBeUndefined();
    });

    it('forwards resolveWriteOptions per-event overrides into encoder.publishOutput', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      const events: TestOutput[] = [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ];
      await run.pipe(streamOf(...events), {
        resolveWriteOptions: (event: TestOutput) => (event.text === 'b' ? { messageId: 'override-b' } : undefined),
      });

      const enc = codec.lastEncoder();
      expect(enc?.publishCalls).toHaveLength(2);
      expect(enc?.publishCalls[0]?.opts).toBeUndefined();
      expect(enc?.publishCalls[1]?.opts).toEqual({ messageId: 'override-b' });
    });
  });

  // -------------------------------------------------------------------------
  // cancel routing
  // -------------------------------------------------------------------------

  describe('cancel routing', () => {
    it('cancels run when cancel by runId arrives', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();

      simulateCancel(channel, { [HEADER_RUN_ID]: 'run-1' });
      await new Promise((r) => setTimeout(r, 5));

      expect(run.abortSignal.aborted).toBe(true);
    });

    it('onCancel returning false prevents cancel', async () => {
      const run = createRunFromOpts(session, {
        runId: 'run-1',
        // eslint-disable-next-line @typescript-eslint/require-await -- mock
        onCancel: async () => false,
      });
      await run.start();

      simulateCancel(channel, { [HEADER_RUN_ID]: 'run-1' });
      await new Promise((r) => setTimeout(r, 5));

      expect(run.abortSignal.aborted).toBe(false);
    });

    it('no-op when no run matches the runId', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();

      simulateCancel(channel, { [HEADER_RUN_ID]: 'run-other' });
      await new Promise((r) => setTimeout(r, 5));

      expect(run.abortSignal.aborted).toBe(false);
    });

    it('drops a malformed cancel missing both run-id and input-codec-message-id with a warn-level log', async () => {
      const ch = createMockChannel();
      const { logger, warn } = captureWarnLogger();
      const s = createAgentSession({
        client: createMockClient(ch),
        channelName: 'cancel-malformed',
        codec: createMockCodec(),
        logger,
      });
      await s.connect();
      const run = createRunFromOpts(s, { runId: 'run-1' });
      await run.start();

      simulateCancel(ch, {});
      await new Promise((r) => setTimeout(r, 5));

      expect(run.abortSignal.aborted).toBe(false);
      const warnCalls = warn.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('missing run-id and input-codec-message-id'),
      );
      expect(warnCalls.length).toBe(1);
      s.close();
    });
  });

  // -------------------------------------------------------------------------
  // cancel before run-start (deferred-cancel buffer)
  // -------------------------------------------------------------------------

  describe('cancel before run-start', () => {
    it('honours a cancel keyed by the input codec-message-id that arrived before run-start', async () => {
      const { session: s, ch } = lookupSession();
      await s.connect();

      const inputEventId = 'p-early';
      const inputCodecMessageId = 'm-early';
      const run = createRunFromOpts(s, { runId: 'run-early', invocationId: 'inv-early', inputEventId });

      // Cancel arrives BEFORE the run is known (its input-event lookup hasn't
      // resolved the input → run linkage yet). It is buffered by the input
      // codec-message-id. Cancel handling is dispatched fire-and-forget, so
      // flush microtasks to guarantee it lands in the buffer before start().
      simulateCancel(ch, { [HEADER_INPUT_CODEC_MESSAGE_ID]: inputCodecMessageId });
      await new Promise((r) => setTimeout(r, 5));

      // start() runs the lookup; delivering the input resolves the linkage and
      // pulls the buffered cancel.
      const startPromise = run.start();
      deliverInputEvent(ch, {
        invocationId: 'inv-early',
        codecMessageId: inputCodecMessageId,
        serial: 's-early',
        inputEventId,
      });
      await startPromise;

      expect(run.abortSignal.aborted).toBe(true);
      s.close();
    });

    it('honours a continuation cancel (run-id + input id) that arrived before run-resume', async () => {
      const { session: s, ch } = lookupSession();
      await s.connect();

      const inputEventId = 'p-cont-early';
      const inputCodecMessageId = 'm-cont-early';
      const continuationRunId = 'run-cont-existing';
      // Build the run directly with no `runtime.runId` so the agent mints a
      // provisional run-id — mirroring production, where it differs from the
      // existing run-id a continuation re-enters. (createRunFromOpts would pin
      // runtime.runId to the same value, collapsing the distinction.)
      const run = s.createRun(Invocation.fromJSON({ inputEventId, sessionName: 'test' }), {
        invocationId: 'inv-cont-early',
      });

      // A continuation cancel knows the EXISTING run-id (the client passed it)
      // and carries the triggering input's codec-message-id. The run is
      // registered under the provisional id, so the cancel doesn't match by
      // run-id and is buffered by the input codec-message-id — the same path a
      // fresh-send cancel takes.
      simulateCancel(ch, {
        [HEADER_RUN_ID]: continuationRunId,
        [HEADER_INPUT_CODEC_MESSAGE_ID]: inputCodecMessageId,
      });
      await new Promise((r) => setTimeout(r, 5));

      // start() runs the lookup; the continuation input carries the existing
      // run-id on the wire, so the agent adopts it (re-keying the registration)
      // and pulls the buffered cancel.
      const startPromise = run.start();
      deliverInputEvent(ch, {
        invocationId: 'inv-cont-early',
        runId: continuationRunId,
        codecMessageId: inputCodecMessageId,
        serial: 's-cont-early',
        inputEventId,
      });
      await startPromise;

      expect(run.abortSignal.aborted).toBe(true);
      // The run adopted the existing run-id from the wire, not the provisional.
      expect(run.runId).toBe(continuationRunId);
      s.close();
    });

    it('a buffered cancel is honoured by onCancel exactly as a live cancel', async () => {
      const { session: s, ch } = lookupSession();
      await s.connect();

      const inputEventId = 'p-onc';
      const inputCodecMessageId = 'm-onc';
      // eslint-disable-next-line @typescript-eslint/require-await -- mock
      const onCancel = vi.fn(async () => true);
      const run = createRunFromOpts(s, {
        runId: 'run-onc',
        invocationId: 'inv-onc',
        inputEventId,
        onCancel,
      });

      simulateCancel(ch, { [HEADER_INPUT_CODEC_MESSAGE_ID]: inputCodecMessageId });
      await new Promise((r) => setTimeout(r, 5));

      const startPromise = run.start();
      deliverInputEvent(ch, {
        invocationId: 'inv-onc',
        codecMessageId: inputCodecMessageId,
        serial: 's-onc',
        inputEventId,
      });
      await startPromise;

      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(run.abortSignal.aborted).toBe(true);
      s.close();
    });

    it('a buffered cancel whose onCancel returns false does not abort the run', async () => {
      const { session: s, ch } = lookupSession();
      await s.connect();

      const inputEventId = 'p-deny';
      const inputCodecMessageId = 'm-deny';
      const run = createRunFromOpts(s, {
        runId: 'run-deny',
        invocationId: 'inv-deny',
        inputEventId,
        // eslint-disable-next-line @typescript-eslint/require-await -- mock
        onCancel: async () => false,
      });

      simulateCancel(ch, { [HEADER_INPUT_CODEC_MESSAGE_ID]: inputCodecMessageId });
      await new Promise((r) => setTimeout(r, 5));

      const startPromise = run.start();
      deliverInputEvent(ch, {
        invocationId: 'inv-deny',
        codecMessageId: inputCodecMessageId,
        serial: 's-deny',
        inputEventId,
      });
      await startPromise;

      expect(run.abortSignal.aborted).toBe(false);
      s.close();
    });

    it('routes a live cancel by input codec-message-id once the run has resolved it', async () => {
      const { session: s, ch } = lookupSession();
      await s.connect();

      const inputEventId = 'p-live';
      const inputCodecMessageId = 'm-live';
      const run = createRunFromOpts(s, { runId: 'run-live', invocationId: 'inv-live', inputEventId });

      const startPromise = run.start();
      deliverInputEvent(ch, {
        invocationId: 'inv-live',
        codecMessageId: inputCodecMessageId,
        serial: 's-live',
        inputEventId,
      });
      await startPromise;

      // Cancel arrives AFTER start() resolved the input → run linkage; it
      // matches via the reverse index without any run-id.
      simulateCancel(ch, { [HEADER_INPUT_CODEC_MESSAGE_ID]: inputCodecMessageId });
      await new Promise((r) => setTimeout(r, 5));

      expect(run.abortSignal.aborted).toBe(true);
      s.close();
    });

    it('FIFO-evicts the oldest deferred cancel beyond the buffer limit', async () => {
      const ch = createMockChannel();
      const { logger, warn } = captureWarnLogger();
      const s = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'cancel-evict',
        codec: codecWithFunctionalDecoder(),
        logger,
        inputEventLookupTimeoutMs: 5000,
        inputEventBufferLimit: 1,
      });
      await s.connect();

      // Two early cancels for different inputs; the buffer holds one, so the
      // first is evicted.
      simulateCancel(ch, { [HEADER_INPUT_CODEC_MESSAGE_ID]: 'm-old' });
      simulateCancel(ch, { [HEADER_INPUT_CODEC_MESSAGE_ID]: 'm-new' });
      // Cancel handling is dispatched fire-and-forget; let the microtasks run.
      await new Promise((r) => setTimeout(r, 5));

      const evictWarns = warn.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('deferred-cancel buffer full'),
      );
      expect(evictWarns.length).toBe(1);

      // The evicted cancel ('m-old') no longer fires; the retained one does.
      const evicted = createRunFromOpts(s, { runId: 'run-old', invocationId: 'inv-old', inputEventId: 'p-old' });
      const evictedStart = evicted.start();
      deliverInputEvent(ch, {
        invocationId: 'inv-old',
        codecMessageId: 'm-old',
        serial: 's-old',
        inputEventId: 'p-old',
      });
      await evictedStart;
      expect(evicted.abortSignal.aborted).toBe(false);

      const retained = createRunFromOpts(s, { runId: 'run-new', invocationId: 'inv-new', inputEventId: 'p-new' });
      const retainedStart = retained.start();
      deliverInputEvent(ch, {
        invocationId: 'inv-new',
        codecMessageId: 'm-new',
        serial: 's-new',
        inputEventId: 'p-new',
      });
      await retainedStart;
      expect(retained.abortSignal.aborted).toBe(true);

      s.close();
    });

    it('clears deferred cancels on close so they are not honoured by a later run', async () => {
      const { session: s, ch } = lookupSession();
      await s.connect();

      simulateCancel(ch, { [HEADER_INPUT_CODEC_MESSAGE_ID]: 'm-stale' });
      await new Promise((r) => setTimeout(r, 5));
      s.close();

      // A fresh session reusing the same input id sees no buffered cancel.
      const s2 = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'cancel-before-start',
        codec: codecWithFunctionalDecoder(),
        inputEventLookupTimeoutMs: 5000,
      });
      await s2.connect();
      const run = createRunFromOpts(s2, { runId: 'run-fresh', invocationId: 'inv-fresh', inputEventId: 'p-fresh' });
      const startPromise = run.start();
      deliverInputEvent(ch, {
        invocationId: 'inv-fresh',
        codecMessageId: 'm-stale',
        serial: 's-fresh',
        inputEventId: 'p-fresh',
      });
      await startPromise;
      expect(run.abortSignal.aborted).toBe(false);
      s2.close();
    });

    it('a run-end clears the input → run linkage so a late cancel by input id is a no-op', async () => {
      const { session: s, ch } = lookupSession();
      await s.connect();

      const inputEventId = 'p-ended';
      const inputCodecMessageId = 'm-ended';
      const run = createRunFromOpts(s, { runId: 'run-ended', invocationId: 'inv-ended', inputEventId });
      const startPromise = run.start();
      deliverInputEvent(ch, {
        invocationId: 'inv-ended',
        codecMessageId: inputCodecMessageId,
        serial: 's-ended',
        inputEventId,
      });
      await startPromise;
      await run.end('complete');

      simulateCancel(ch, { [HEADER_INPUT_CODEC_MESSAGE_ID]: inputCodecMessageId });
      await new Promise((r) => setTimeout(r, 5));

      // No throw, no abort attempt against a non-existent registration.
      expect(run.abortSignal.aborted).toBe(false);
      s.close();
    });
  });

  // -------------------------------------------------------------------------
  // early cancel
  // -------------------------------------------------------------------------

  describe('early cancel', () => {
    it('fires abort signal even before start() is called', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      simulateCancel(channel, { [HEADER_RUN_ID]: 'run-1' });
      await new Promise((r) => setTimeout(r, 5));
      expect(run.abortSignal.aborted).toBe(true);
    });

    it('start() throws when run was cancelled early', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      simulateCancel(channel, { [HEADER_RUN_ID]: 'run-1' });
      await new Promise((r) => setTimeout(r, 5));
      await expect(run.start()).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });
  });

  // -------------------------------------------------------------------------
  // external signal
  // -------------------------------------------------------------------------

  describe('external signal', () => {
    it('cancels the run when the external signal fires', async () => {
      const ctl = new AbortController();
      const run = createRunFromOpts(session, { runId: 'run-1', signal: ctl.signal });
      await run.start();
      ctl.abort();
      expect(run.abortSignal.aborted).toBe(true);
    });

    it('start() throws when external signal is already aborted', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1', signal: AbortSignal.abort() });
      await expect(run.start()).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });

    it('cancels an in-flight pipe', async () => {
      const ctl = new AbortController();
      const run = createRunFromOpts(session, { runId: 'run-1', signal: ctl.signal });
      await run.start();

      const stream = new ReadableStream<TestOutput>({
        start: (controller) => {
          controller.enqueue({ type: 'text', text: 'partial' });
        },
      });

      const resultPromise = run.pipe(stream);
      ctl.abort();
      const result = await resultPromise;
      expect(result.reason).toBe('cancelled');
    });
  });

  // -------------------------------------------------------------------------
  // error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('start() throws on run-start publish failure (does not call onError)', async () => {
      const failChannel = createMockChannel();
      vi.mocked(failChannel.publish).mockRejectedValue(new Error('publish failed'));
      const onError = vi.fn();
      const failSession = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(failChannel),
        channelName: 'test-channel',
        codec,
        onError,
      });
      await failSession.connect();
      const run = createRunFromOpts(failSession, { runId: 'run-1', onError });
      await expect(run.start()).rejects.toBeErrorInfoWithCode(ErrorCode.RunLifecycleError);
      expect(onError).not.toHaveBeenCalled();
      failSession.close();
    });

    it('end() throws on run-end publish failure', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      vi.mocked(channel.publish).mockRejectedValueOnce(new Error('publish failed'));
      await expect(run.end('complete')).rejects.toBeErrorInfoWithCode(ErrorCode.RunLifecycleError);
    });

    it('pipe() calls onError when the stream errors', async () => {
      const onError = vi.fn();
      const run = createRunFromOpts(session, { runId: 'run-1', onError });
      await run.start();
      const stream = new ReadableStream<TestOutput>({
        start: (controller) => {
          controller.enqueue({ type: 'text', text: 'partial' });
          controller.error(new Error('rate limit'));
        },
      });
      const result = await run.pipe(stream);
      expect(result.reason).toBe('error');
      expect(onError).toHaveBeenCalledWith(expect.toBeErrorInfo({ code: ErrorCode.StreamError }));
    });

    it('pipe() does not call onError when stream completes', async () => {
      const onError = vi.fn();
      const run = createRunFromOpts(session, { runId: 'run-1', onError });
      await run.start();
      await run.pipe(streamOf({ type: 'text', text: 'done' }));
      expect(onError).not.toHaveBeenCalled();
    });

    it('onCancel throws → onError fires for the targeted run', async () => {
      const onError = vi.fn();
      const run = createRunFromOpts(session, {
        runId: 'run-1',
        // eslint-disable-next-line @typescript-eslint/require-await -- mock
        onCancel: async () => {
          throw new Error('handler boom');
        },
        onError,
      });
      await run.start();

      simulateCancel(channel, { [HEADER_RUN_ID]: 'run-1' });
      await new Promise((r) => setTimeout(r, 5));

      expect(onError).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // close
  // -------------------------------------------------------------------------

  describe('close', () => {
    it('cancels all registered runs', async () => {
      const run1 = createRunFromOpts(session, { runId: 'run-1' });
      const run2 = createRunFromOpts(session, { runId: 'run-2' });
      await run1.start();
      await run2.start();
      session.close();
      expect(run1.abortSignal.aborted).toBe(true);
      expect(run2.abortSignal.aborted).toBe(true);
    });

    it('unsubscribes from the channel', () => {
      session.close();
      expect(channel.unsubscribe).toHaveBeenCalled();
    });

    it('is idempotent', () => {
      session.close();
      session.close();
      expect(channel.unsubscribe).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // channel continuity
  // -------------------------------------------------------------------------

  describe('channel continuity', () => {
    it.each([['failed' as const], ['suspended' as const], ['detached' as const]])(
      'emits onError with ChannelContinuityLost when channel enters %s',
      (state) => {
        const onError = vi.fn();
        const ch = createMockChannel();
        ch.state = 'initialized';
        const s = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
          client: createMockClient(ch),
          channelName: 'test-channel',
          codec: createMockCodec(),
          onError,
        });
        simulateInitialAttach(ch);
        simulateStateChange(ch, {
          current: state,
          previous: 'attached',
        } as Ably.ChannelStateChange);

        expect(onError).toHaveBeenCalledWith(
          expect.toBeErrorInfo({ code: ErrorCode.ChannelContinuityLost, statusCode: 500 }),
        );
        s.close();
      },
    );

    it('emits onError on UPDATE (attached → attached, resumed: false)', () => {
      const onError = vi.fn();
      const ch = createMockChannel();
      ch.state = 'initialized';
      const s = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: createMockCodec(),
        onError,
      });
      simulateInitialAttach(ch);
      simulateStateChange(ch, {
        current: 'attached',
        previous: 'attached',
        resumed: false,
      });

      expect(onError).toHaveBeenCalledWith(
        expect.toBeErrorInfo({ code: ErrorCode.ChannelContinuityLost, statusCode: 500 }),
      );
      s.close();
    });
  });

  describe('input-event lookup (multi-message)', () => {
    it('collects every expected event-id, dedupes by serial, and returns them sorted', async () => {
      const ch = createMockChannel();
      const c = codecWithFunctionalDecoder();
      const s = createAgentSession({
        client: createMockClient(ch),
        channelName: 'multi-msg',
        codec: c,
        inputEventLookupTimeoutMs: 5000,
      });
      await s.connect();

      const runId = 'r-multi';
      const invocationId = 'inv-multi';
      const run = createRunFromOpts(s, { runId, invocationId, inputEventId: 'p-a' });
      const startPromise = run.start();

      // Deliver with a duplicate to assert dedup.
      deliverInputEvent(ch, { invocationId, runId, codecMessageId: 'a', serial: '01', inputEventId: 'p-a' });
      deliverInputEvent(ch, { invocationId, runId, codecMessageId: 'a', serial: '01', inputEventId: 'p-a' });

      await startPromise;
      expect(run.view.messages).toHaveLength(1);
      expect(run.view.messages[0]?.codecMessageId).toBe('a');
      s.close();
    });

    it('rejects with InputEventNotFound including "received X of Y" on partial collection at timeout', async () => {
      const ch = createMockChannel();
      const c = codecWithFunctionalDecoder();
      const s = createAgentSession({
        client: createMockClient(ch),
        channelName: 'partial',
        codec: c,
        inputEventLookupTimeoutMs: 5,
      });
      await s.connect();

      const runId = 'r-partial';
      const invocationId = 'inv-partial';
      const run = createRunFromOpts(s, { runId, invocationId, inputEventId: 'p-a' });
      const startPromise = run.start();

      // Deliver nothing — timeout fires before the event arrives.
      const rejection = await startPromise.catch((error: unknown) => error);
      expect(rejection).toBeErrorInfoWithCode(ErrorCode.InputEventNotFound);
      expect((rejection as Ably.ErrorInfo).message).toContain('received 0 of 1');
      s.close();
    });

    it('drains buffered input events in insertion order and stays registered for the remainder', async () => {
      const ch = createMockChannel();
      const c = codecWithFunctionalDecoder();
      const s = createAgentSession({
        client: createMockClient(ch),
        channelName: 'drain',
        codec: c,
        inputEventLookupTimeoutMs: 5000,
      });
      await s.connect();

      const runId = 'r-drain';
      const invocationId = 'inv-drain';
      // Pre-buffer the trigger event before any listener is registered.
      deliverInputEvent(ch, { invocationId, runId, codecMessageId: 'first', serial: '01', inputEventId: 'p-first' });

      const run = createRunFromOpts(s, { runId, invocationId, inputEventId: 'p-first' });
      const startPromise = run.start();

      // start() should resolve immediately by draining the buffer.
      await startPromise;
      expect(run.view.messages.map((m) => m.codecMessageId)).toEqual(['first']);
      s.close();
    });

    it('waits for continuation tool-resolution publishes via HEADER_RUN_ID + HEADER_EVENT_ID', async () => {
      // Continuation tool resolutions publish as `role: 'user'` channel
      // messages stamped with a wire run-id plus a
      // event-id. The agent dispatcher routes any inbound message
      // carrying `event-id`, so the lookup picks up the
      // continuation publish regardless of how it was minted on the wire.
      const ch = createMockChannel();
      const c = codecWithFunctionalDecoder();
      const s = createAgentSession({
        client: createMockClient(ch),
        channelName: 'continuation-wait',
        codec: c,
        inputEventLookupTimeoutMs: 5000,
      });
      await s.connect();

      const runId = 'r-cont';
      const invocationId = 'inv-cont';
      const inputEventId = 'p-cont';
      const run = createRunFromOpts(s, { runId, invocationId, inputEventId: inputEventId });
      const startPromise = run.start();

      // Deliver a synthetic continuation user-message — a `role: 'user'`
      // wire message stamped with a wire run-id so the agent reads
      // the run as a continuation. The lookup resolves solely because
      // the event-id is in the expected set.
      deliverInputEvent(ch, {
        invocationId,
        runId,
        codecMessageId: 'm-cont',
        serial: 's-cont',
        inputEventId,
      });

      await expect(startPromise).resolves.toBeUndefined();
      s.close();
    });
  });

  describe('input-event lookup', () => {
    it('buffers an input event with no registered lookup and drains it when a lookup registers', async () => {
      // With dispatch keyed by event-id, an input event whose event-id has
      // no pending lookup is buffered (not dropped) so a run.start() that
      // registers afterwards still finds it. This is the agent-attaches-
      // after-publish / rewind-before-start path.
      const ch = createMockChannel();
      const c = codecWithFunctionalDecoder();
      const s = createAgentSession({
        client: createMockClient(ch),
        channelName: 'buffer-then-drain',
        codec: c,
        inputEventLookupTimeoutMs: 5000,
      });
      await s.connect();

      const runId = 'r-buf';
      const invocationId = 'inv-buf';
      // Arrives before any lookup is registered — buffered by event-id.
      deliverInputEvent(ch, { invocationId, runId, codecMessageId: 'a', serial: '01', inputEventId: 'p-a' });

      const run = createRunFromOpts(s, { runId, invocationId, inputEventId: 'p-a' });
      await run.start();

      expect(run.view.messages.map((m) => m.codecMessageId)).toEqual(['a']);
      s.close();
    });

    it('routes input events by event-id, ignoring the invocation-id header', async () => {
      // The dispatcher no longer keys on invocation-id: a lookup resolves
      // when its expected event-id arrives even if the wire message carries
      // an unrelated invocation-id.
      const ch = createMockChannel();
      const c = codecWithFunctionalDecoder();
      const s = createAgentSession({
        client: createMockClient(ch),
        channelName: 'route-by-event-id',
        codec: c,
        inputEventLookupTimeoutMs: 5000,
      });
      await s.connect();

      const run = createRunFromOpts(s, { runId: 'r-route', invocationId: 'inv-expected', inputEventId: 'p-a' });
      const startPromise = run.start();

      // Deliver the trigger event-id under a different invocation-id.
      deliverInputEvent(ch, {
        invocationId: 'inv-DIFFERENT',
        runId: 'r-route',
        codecMessageId: 'a',
        serial: '01',
        inputEventId: 'p-a',
      });

      await startPromise;
      expect(run.view.messages.map((m) => m.codecMessageId)).toEqual(['a']);
      s.close();
    });

    it('rejects the entire lookup if any message fails to decode', async () => {
      const ch = createMockChannel();
      // Decoder throws on any input.
      const codec: Codec<TestInput, TestOutput, TestProjection, TestMessage> = {
        init: (): TestProjection => ({ messages: [] }),
        fold: (state: TestProjection): TestProjection => state,
        getMessages: (p: TestProjection) => p.messages.map((m) => ({ codecMessageId: m.id, message: m })),
        createUserMessage: (m: TestMessage) => ({ kind: 'user-message' as const, message: m }),
        createRegenerate: (target: string, parent: string) => ({ kind: 'regenerate' as const, target, parent }),
        createEncoder: vi.fn(() => createMockEncoder()),
        createDecoder: vi.fn(() => ({
          decode: () => {
            throw new Error('boom');
          },
        })),
      };
      const s = createAgentSession({
        client: createMockClient(ch),
        channelName: 'decode-fail',
        codec,
        inputEventLookupTimeoutMs: 5000,
      });
      await s.connect();

      const runId = 'r-bad';
      const invocationId = 'inv-bad';
      const run = createRunFromOpts(s, { runId, invocationId, inputEventId: 'p-a' });
      const startPromise = run.start();
      deliverInputEvent(ch, { invocationId, runId, codecMessageId: 'a', serial: '01', inputEventId: 'p-a' });

      const rejection = await startPromise.catch((error: unknown) => error);
      expect(rejection).toBeErrorInfoWithCode(ErrorCode.InputEventNotFound);
      expect((rejection as Ably.ErrorInfo).message).toContain('decode failed');
      s.close();
    });

    it('cancels the lookup when the run signal aborts mid-collection', async () => {
      const ch = createMockChannel();
      const c = codecWithFunctionalDecoder();
      const s = createAgentSession({
        client: createMockClient(ch),
        channelName: 'abort-mid',
        codec: c,
        inputEventLookupTimeoutMs: 5000,
      });
      await s.connect();

      const runId = 'r-abort';
      const invocationId = 'inv-abort';
      const run = createRunFromOpts(s, { runId, invocationId, inputEventId: 'p-a' });
      const startPromise = run.start();

      // Cancel-by-runId triggers controller.abort() on the registered run.
      simulateCancel(ch, { [HEADER_RUN_ID]: runId });

      await expect(startPromise).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
      s.close();
    });
  });

  describe('input-event buffer', () => {
    it('warns and FIFO-evicts the oldest entry when the input-event buffer is full', async () => {
      const ch = createMockChannel();
      const c = codecWithFunctionalDecoder();
      const { logger, warn } = captureWarnLogger();
      const s = createAgentSession({
        client: createMockClient(ch),
        channelName: 'evict',
        codec: c,
        inputEventLookupTimeoutMs: 5000,
        logger,
      });
      await s.connect();

      // Default limit is 200. Fill it, then push one more to trigger eviction.
      for (let i = 0; i < 200; i++) {
        deliverInputEvent(ch, {
          invocationId: `inv-${String(i)}`,
          codecMessageId: `m${String(i)}`,
          serial: `s${String(i)}`,
        });
      }
      warn.mockClear();
      deliverInputEvent(ch, { invocationId: 'inv-overflow', codecMessageId: 'm-over', serial: 's-over' });

      const evictCalls = warn.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('input-event buffer full'),
      );
      expect(evictCalls).toHaveLength(1);
      const ctx = evictCalls[0]?.[1] as { evictedEventId?: string; limit?: number } | undefined;
      expect(ctx?.evictedEventId).toBe('p-m0');
      expect(ctx?.limit).toBe(200);
      s.close();
    });

    it('honours a custom inputEventBufferLimit option', async () => {
      const ch = createMockChannel();
      const c = codecWithFunctionalDecoder();
      const { logger, warn } = captureWarnLogger();
      const s = createAgentSession({
        client: createMockClient(ch),
        channelName: 'evict-custom',
        codec: c,
        inputEventLookupTimeoutMs: 5000,
        inputEventBufferLimit: 3,
        logger,
      });
      await s.connect();

      // Fill the 3-slot buffer; no eviction warns should fire yet.
      for (let i = 0; i < 3; i++) {
        deliverInputEvent(ch, {
          invocationId: `inv-${String(i)}`,
          codecMessageId: `m${String(i)}`,
          serial: `s${String(i)}`,
        });
      }
      let evictCalls = warn.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('input-event buffer full'),
      );
      expect(evictCalls).toHaveLength(0);

      // The 4th distinct event-id must evict `p-m0` and log limit=3.
      deliverInputEvent(ch, { invocationId: 'inv-3', codecMessageId: 'm3', serial: 's3' });
      evictCalls = warn.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('input-event buffer full'),
      );
      expect(evictCalls).toHaveLength(1);
      const ctx = evictCalls[0]?.[1] as { evictedEventId?: string; limit?: number } | undefined;
      expect(ctx?.evictedEventId).toBe('p-m0');
      expect(ctx?.limit).toBe(3);
      s.close();
    });
  });
});

// ---------------------------------------------------------------------------
// Input-event lookup (covers AgentSession's channel-rewind input-event flow)
// ---------------------------------------------------------------------------

describe('AgentSession input-event lookup', () => {
  it('start() succeeds when invocation has no inputEventIds (continuation send)', async () => {
    const channel = createMockChannel();
    const codec = createMockCodec();
    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(channel),
      channelName: 'test-channel',
      codec,
    });
    await session.connect();

    const run = createRunFromOpts(session, {
      runId: 'run-1',
      invocationId: 'inv-1',
    });
    await expect(run.start()).resolves.toBeUndefined();
    session.close();
  });

  it('start() succeeds when invocation already carries messages (legacy path)', async () => {
    const channel = createMockChannel();
    const codec = createMockCodec();
    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(channel),
      channelName: 'test-channel',
      codec,
    });
    await session.connect();

    // createRunFromOpts always passes messages: [] in invocation. Without
    // inputEventIds, the lookup is skipped and start() completes synchronously.
    const run = createRunFromOpts(session, { runId: 'run-1', invocationId: 'inv-1' });
    await expect(run.start()).resolves.toBeUndefined();
    session.close();
  });

  it('start() rejects with InputEventNotFound when timeout lapses', async () => {
    const channel = createMockChannel();
    const codec = createMockCodec();
    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(channel),
      channelName: 'test-channel',
      codec,
      inputEventLookupTimeoutMs: 10,
    });
    await session.connect();

    const run = createRunFromOpts(session, {
      runId: 'run-1',
      invocationId: 'inv-needs-prompt',
      inputEventId: 'p-1', // signal that an input event should be looked up
    });

    await expect(run.start()).rejects.toBeErrorInfoWithCode(ErrorCode.InputEventNotFound);
    // The failure surfaces purely as a `Run.start()` rejection; the agent
    // must not publish a phantom `ai-run-end` (no `ai-run-start` was ever
    // published, and `run-end` without `run-start` would break the
    // lifecycle invariant for other channel observers).
    expect(channel.publishCalls.find((m) => m.name === 'ai-run-end')).toBeUndefined();
    expect(channel.publishCalls.find((m) => m.name === 'ai-run-start')).toBeUndefined();
    session.close();
  });
});

// ---------------------------------------------------------------------------
// Run.messages — projection-overlaid history + view contributions
// ---------------------------------------------------------------------------

describe('Run.messages', () => {
  it('is empty before start() resolves (no loadProjection yet)', () => {
    const channel = createMockChannel();
    const codec = codecWithFunctionalDecoder();
    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(channel),
      channelName: 'test-channel',
      codec,
    });
    const run = createRunFromOpts(session, { runId: 'run-1' });
    expect(run.messages).toEqual([]);
    // Fresh array per access — mutating the return value doesn't bleed.
    run.messages.push({ id: 'leak', content: 'no' });
    expect(run.messages).toEqual([]);
    session.close();
  });

  it('returns view-message contributions after start() resolves (fresh send)', async () => {
    const ch = createMockChannel();
    const codec = codecWithFunctionalDecoder();
    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'fresh',
      codec,
      inputEventLookupTimeoutMs: 5000,
    });
    await session.connect();
    const run = createRunFromOpts(session, {
      runId: 'run-1',
      invocationId: 'inv-1',
      inputEventId: 'p-fresh',
    });
    const startPromise = run.start();
    deliverInputEvent(ch, {
      invocationId: 'inv-1',
      runId: 'run-1',
      codecMessageId: 'user-new',
      serial: 's-1',
      inputEventId: 'p-fresh',
    });
    await startPromise;

    // The functional decoder produces { id: codecMessageId, content: codecMessageId }.
    expect(run.messages).toEqual([{ id: 'user-new', content: 'user-new' }]);
    session.close();
  });

  it('returns view messages after start() resolves on continuation (no history overlay)', async () => {
    const ch = createMockChannel();
    const codec = codecWithFunctionalDecoder();

    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'cont-overlay',
      codec,
      inputEventLookupTimeoutMs: 5000,
    });
    await session.connect();
    const run = createRunFromOpts(session, {
      runId: 'run-1',
      invocationId: 'inv-cont',
      inputEventId: 'p-cont',
    });
    const startPromise = run.start();
    deliverInputEvent(ch, {
      invocationId: 'inv-cont',
      runId: 'run-1',
      codecMessageId: 'm-cont',
      serial: 's-cont',
      inputEventId: 'p-cont',
    });
    await startPromise;

    // Before loadProjection, messages are the view messages from the input-event lookup.
    expect(run.messages).toEqual([{ id: 'm-cont', content: 'm-cont' }]);
    session.close();
  });

  it('returns only view messages after start() on continuation (no history to pass through)', async () => {
    const ch = createMockChannel();
    const codec = codecWithFunctionalDecoder();

    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'cont-no-overlap',
      codec,
      inputEventLookupTimeoutMs: 5000,
    });
    await session.connect();
    const run = createRunFromOpts(session, {
      runId: 'run-1',
      invocationId: 'inv-cont',
      inputEventId: 'p-cont',
    });
    const startPromise = run.start();
    deliverInputEvent(ch, {
      invocationId: 'inv-cont',
      runId: 'run-1',
      codecMessageId: 'm-cont',
      serial: 's-cont',
      inputEventId: 'p-cont',
    });
    await startPromise;

    expect(run.messages).toEqual([{ id: 'm-cont', content: 'm-cont' }]);
    session.close();
  });

  it('detects continuation status from a tool-resolution-only lookup (firstHeaders fallback)', async () => {
    // Simulates the production case: chat-transport's deriveContinuationEvents
    // publishes a `tool-output-available` wire message. The decoder produces
    // a chunk that folds into an empty per-message projection without an
    // assistant to land on — zero MessageNodes. The agent must still pick up
    // the wire run-id from the headers so the run re-enters via ai-run-resume.
    const ch = createMockChannel();
    // A codec whose decoder produces NO events for non-text messages — mimics
    // the chunk-with-no-assistant case. The agent should still treat the
    // delivery as a event-id match.
    const codec: Codec<TestInput, TestOutput, TestProjection, TestMessage> = {
      init: () => ({ messages: [] }),
      fold: (state) => state,
      getMessages: (p) => p.messages.map((m) => ({ codecMessageId: m.id, message: m })),
      createUserMessage: (m: TestMessage) => ({ kind: 'user-message' as const, message: m }),
      createRegenerate: (target: string, parent: string) => ({ kind: 'regenerate' as const, target, parent }),
      createEncoder: vi.fn(() => createMockEncoder()),
      createDecoder: vi.fn(() => ({ decode: () => ({ inputs: [], outputs: [] }) })),
    };
    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'cont-tool-only',
      codec,
      inputEventLookupTimeoutMs: 5000,
    });
    await session.connect();
    const run = createRunFromOpts(session, {
      runId: 'run-1',
      invocationId: 'inv-cont',
      inputEventId: 'p-tool',
    });
    const startPromise = run.start();
    // Deliver a continuation tool-resolution wire message — produces zero
    // MessageNodes but carries a wire run-id.
    deliverInputEvent(ch, {
      invocationId: 'inv-cont',
      runId: 'run-1',
      codecMessageId: 'm-tool',
      serial: 's-tool',
      inputEventId: 'p-tool',
      name: 'tool-output-available',
    });
    await startPromise;

    // The wire run-id (read from the tool-resolution wire's headers via
    // the firstHeaders fallback) makes the agent re-enter the run with
    // ai-run-resume rather than open a new ai-run-start.
    expect(ch.publishCalls.find((m) => m.name === 'ai-run-resume')).toBeDefined();
    expect(ch.publishCalls.find((m) => m.name === 'ai-run-start')).toBeUndefined();
    session.close();
  });

  it('returns the full conversation after loadConversation() is called', async () => {
    // Two-node model. Turn 1: input node u1 (run-less user) → reply run-1
    // (assistant a1). Turn 2: input node u2 (run-less user, parent=a1) → the
    // current reply run-2 (assistant a2). The agent serves run-2; u2 is its
    // triggering input event, delivered via deliverInputEvent so start() sets
    // assistantParentFallback=u2 and buildBranchChain walks u2→a1→u1.
    //
    // Before loadConversation: run.messages returns only the current run's
    // view messages (the input node u2). After loadConversation: the full
    // multi-turn conversation (ancestor input/reply nodes + current run).
    const ch = createMockChannel();
    const codec = codecWithFunctionalDecoder();
    // eslint-disable-next-line @typescript-eslint/no-misused-promises, @typescript-eslint/promise-function-async -- mock returns Promise directly
    ch.history.mockImplementation(() => {
      const items = [
        makeContentMsg('run-2', 'a2', 's-06'),
        makeRunStartMsg('run-2', 'u2'),
        makeInputMsg('u2', 's-05', { parent: 'a1' }),
        makeContentMsg('run-1', 'a1', 's-04'),
        makeRunStartMsg('run-1', 'u1'),
        makeInputMsg('u1', 's-02'),
      ];
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock pagination
      const page = { items, hasNext: () => false, next: () => Promise.resolve(page) };
      return Promise.resolve(page);
    });

    const runId = 'run-2';
    const invocationId = 'inv-2';
    const inputEventId = 'p-u2';
    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'msg-after-conversation',
      codec,
      inputEventLookupTimeoutMs: 5000,
    });
    await session.connect();
    const run = createRunFromOpts(session, { runId, invocationId, inputEventId });
    const startPromise = run.start();
    deliverInputEvent(ch, { invocationId, runId, codecMessageId: 'u2', serial: 's-05', inputEventId, parent: 'a1' });
    await startPromise;

    // Before loadConversation: only the current run's view messages (input u2).
    expect(run.messages).toEqual([{ id: 'u2', content: 'u2' }]);

    await run.loadConversation();

    // After loadConversation: full conversation chain u1 → a1 → u2 → (run-2: a2).
    expect(run.messages).toEqual([
      { id: 'u1', content: 'u1' },
      { id: 'a1', content: 'a1' },
      { id: 'u2', content: 'u2' },
      { id: 'a2', content: 'a2' },
    ]);
    // Each access returns a fresh array — mutations don't bleed back.
    run.messages.push({ id: 'leak', content: 'no' });
    expect(run.messages).toEqual([
      { id: 'u1', content: 'u1' },
      { id: 'a1', content: 'a1' },
      { id: 'u2', content: 'u2' },
      { id: 'a2', content: 'a2' },
    ]);
    session.close();
  });
});

// ---------------------------------------------------------------------------
// Helpers for Run.loadConversation tests
// ---------------------------------------------------------------------------

/**
 * Build a synthetic ai-run-start wire message for the given runId.
 * The second argument is the HEADER_PARENT value — the codec-message-id
 * of the last message from the parent run (not the run-id itself).
 * `loadConversation` resolves the parent runId by looking up that
 * codec-message-id in its codecMsgToRunId index.
 * @param runId - The run identifier stamped on the start event.
 * @param parentCodecMsgId - Optional codec-message-id of the parent message.
 * @param opts - Optional regenerates / forkOf codec-message-ids and serial override.
 * @param opts.regenerates - Codec-message-id of the message this run regenerates.
 * @param opts.forkOf - Codec-message-id of the message this run forks from.
 * @param opts.serial - Serial override. Defaults to `s-start-<runId>`. Supply an
 *   explicit value when the run-start must sort chronologically against
 *   surrounding wires (the View's node sort keys a reply run by its run-start
 *   serial, so a lexically-late default would scramble ordering).
 * @returns A synthetic inbound message mimicking an ai-run-start wire event.
 */
const makeRunStartMsg = (
  runId: string,
  parentCodecMsgId?: string,
  opts?: { regenerates?: string; forkOf?: string; serial?: string },
): Ably.InboundMessage => {
  const headers: Record<string, string> = { [HEADER_RUN_ID]: runId };
  if (parentCodecMsgId !== undefined) headers[HEADER_PARENT] = parentCodecMsgId;
  if (opts?.regenerates !== undefined) headers[HEADER_MSG_REGENERATE] = opts.regenerates;
  if (opts?.forkOf !== undefined) headers[HEADER_FORK_OF] = opts.forkOf;
  return {
    name: EVENT_RUN_START,
    serial: opts?.serial ?? `s-start-${runId}`,
    extras: { ai: { transport: headers } },
  } as unknown as Ably.InboundMessage;
};

/**
 * Build a synthetic content wire message for a run. The functional decoder
 * folds it into a TestMessage with id=codecMsgId.
 * @param runId - The run that owns this message.
 * @param codecMsgId - The message identifier (becomes the TestMessage id).
 * @param serial - Optional serial override; defaults to `s-<codecMsgId>`.
 * @returns A synthetic inbound message mimicking a codec content wire event.
 */
const makeContentMsg = (runId: string, codecMsgId: string, serial?: string): Ably.InboundMessage =>
  ({
    name: 'text',
    serial: serial ?? `s-${codecMsgId}`,
    extras: { ai: { transport: { [HEADER_RUN_ID]: runId, [HEADER_CODEC_MESSAGE_ID]: codecMsgId } } },
  }) as unknown as Ably.InboundMessage;

/**
 * Stamp an additional transport header onto a synthetic wire message built by
 * one of the `make*Msg` helpers (which don't expose every header as a
 * parameter). Mutates and returns the message for chaining.
 * @param item - The synthetic inbound message to mutate.
 * @param key - The transport header key to set under extras.ai.transport.
 * @param value - The header value.
 * @returns The same message, for chaining.
 */
const stampHeader = (item: Ably.InboundMessage, key: string, value: string): Ably.InboundMessage => {
  // CAST: synthetic wires built by the make*Msg helpers expose the transport
  // headers under extras.ai.transport.
  (item as unknown as { extras: { ai: { transport: Record<string, string> } } }).extras.ai.transport[key] = value;
  return item;
};

/**
 * Build a synthetic run-less user INPUT-node wire message (the two-node model:
 * the user prompt the client published before the agent minted a run-id). It
 * carries a codec-message-id and an optional structural `parent` but NO run-id,
 * so `loadConversation` classifies it as an input node and folds it via
 * `foldInputMessages`. The functional decoder folds it into a TestMessage with
 * id=codecMsgId.
 * @param codecMsgId - The input node's codec-message-id (becomes the TestMessage id).
 * @param serial - The Ably serial (drives chronological sort).
 * @param opts - Optional structural parent / forkOf codec-message-ids.
 * @param opts.parent - Codec-message-id of this input node's structural parent (the prior reply's assistant message).
 * @param opts.forkOf - Codec-message-id of the input node this one edits (forks from).
 * @returns A synthetic inbound message mimicking a run-less user-input wire event.
 */
const makeInputMsg = (
  codecMsgId: string,
  serial: string,
  opts?: { parent?: string; forkOf?: string },
): Ably.InboundMessage => {
  const headers: Record<string, string> = { [HEADER_ROLE]: 'user', [HEADER_CODEC_MESSAGE_ID]: codecMsgId };
  if (opts?.parent !== undefined) headers[HEADER_PARENT] = opts.parent;
  if (opts?.forkOf !== undefined) headers[HEADER_FORK_OF] = opts.forkOf;
  return {
    name: 'text',
    serial,
    extras: { ai: { transport: headers } },
  } as unknown as Ably.InboundMessage;
};

// ---------------------------------------------------------------------------
// Run.loadConversation
// ---------------------------------------------------------------------------

describe('Run.loadConversation', () => {
  it('returns current run messages for a root run with no ancestors', async () => {
    const ch = createMockChannel();
    const codec = codecWithFunctionalDecoder();
    // eslint-disable-next-line @typescript-eslint/no-misused-promises, @typescript-eslint/promise-function-async -- mock returns Promise directly
    ch.history.mockImplementation(() => {
      // Ably returns newest-first.
      const items = [makeContentMsg('run-1', 'msg-1'), makeRunStartMsg('run-1')];
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock pagination
      const page = { items, hasNext: () => false, next: () => Promise.resolve(page) };
      return Promise.resolve(page);
    });

    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'test-channel',
      codec,
      inputEventLookupTimeoutMs: 0,
    });
    await session.connect();
    const run = createRunFromOpts(session, { runId: 'run-1' });
    await run.start();

    const history = await run.loadConversation();
    expect(history).toEqual([{ id: 'msg-1', content: 'msg-1' }]);
    // Side effect: run.messages now returns the full conversation.
    expect(run.messages).toEqual(history);
    session.close();
  });

  it('concatenates ancestor messages then current run messages in a two-turn conversation', async () => {
    const ch = createMockChannel();
    const codec = codecWithFunctionalDecoder();
    // Two-node, two turns. Turn 1: input u1 → reply run-1 (assistant a1).
    // Turn 2 (current): input u2 (parent=a1, delivered) → reply run-2. run-2
    // has streamed no content yet, so the conversation is the spine u1→a1→u2.
    // buildBranchChain walks the structural parent chain from u2 (the agent's
    // assistantParentFallback) up to the root.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises, @typescript-eslint/promise-function-async -- mock returns Promise directly
    ch.history.mockImplementation(() => {
      // Ably returns newest-first; loadConversation sorts chronologically internally.
      const items = [
        makeRunStartMsg('run-2', 'u2'),
        makeInputMsg('u2', 's-05', { parent: 'a1' }),
        makeContentMsg('run-1', 'a1', 's-04'),
        makeRunStartMsg('run-1', 'u1'),
        makeInputMsg('u1', 's-02'),
      ];
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock pagination
      const page = { items, hasNext: () => false, next: () => Promise.resolve(page) };
      return Promise.resolve(page);
    });

    const runId = 'run-2';
    const invocationId = 'inv-2';
    const inputEventId = 'p-u2';
    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'test-channel',
      codec,
      inputEventLookupTimeoutMs: 5000,
    });
    await session.connect();
    const run = createRunFromOpts(session, { runId, invocationId, inputEventId });
    const startPromise = run.start();
    deliverInputEvent(ch, { invocationId, runId, codecMessageId: 'u2', serial: 's-05', inputEventId, parent: 'a1' });
    await startPromise;

    const history = await run.loadConversation();
    expect(history).toEqual([
      { id: 'u1', content: 'u1' },
      { id: 'a1', content: 'a1' },
      { id: 'u2', content: 'u2' },
    ]);
    expect(run.messages).toEqual(history);
    session.close();
  });

  it('walks the full ancestor chain oldest-first for a three-turn conversation', async () => {
    const ch = createMockChannel();
    const codec = codecWithFunctionalDecoder();
    // Two-node, three turns. u1→run-1(a1), u2→run-2(a2), u3(current)→run-3.
    // buildBranchChain walks u3→a2→u2→a1→u1 and reverses to root-first.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises, @typescript-eslint/promise-function-async -- mock returns Promise directly
    ch.history.mockImplementation(() => {
      const items = [
        makeRunStartMsg('run-3', 'u3'),
        makeInputMsg('u3', 's-07', { parent: 'a2' }),
        makeContentMsg('run-2', 'a2', 's-06'),
        makeRunStartMsg('run-2', 'u2'),
        makeInputMsg('u2', 's-05', { parent: 'a1' }),
        makeContentMsg('run-1', 'a1', 's-04'),
        makeRunStartMsg('run-1', 'u1'),
        makeInputMsg('u1', 's-02'),
      ];
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock pagination
      const page = { items, hasNext: () => false, next: () => Promise.resolve(page) };
      return Promise.resolve(page);
    });

    const runId = 'run-3';
    const invocationId = 'inv-3';
    const inputEventId = 'p-u3';
    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'test-channel',
      codec,
      inputEventLookupTimeoutMs: 5000,
    });
    await session.connect();
    const run = createRunFromOpts(session, { runId, invocationId, inputEventId });
    const startPromise = run.start();
    deliverInputEvent(ch, { invocationId, runId, codecMessageId: 'u3', serial: 's-07', inputEventId, parent: 'a2' });
    await startPromise;

    const history = await run.loadConversation();
    expect(history).toEqual([
      { id: 'u1', content: 'u1' },
      { id: 'a1', content: 'a1' },
      { id: 'u2', content: 'u2' },
      { id: 'a2', content: 'a2' },
      { id: 'u3', content: 'u3' },
    ]);
    expect(run.messages).toEqual(history);
    session.close();
  });

  it('excludes the superseded reply (un-taken sibling) when regenerating an assistant message', async () => {
    // Two-node model. Turn 1: input u1 → reply run-1 (assistant a1). The user
    // regenerates a1: the agent serves a NEW reply run-2 parented at the SAME
    // input node u1 (run-1 and run-2 are sibling reply runs — the regenerate
    // group). run-2's trigger is a regenerate carrier that decodes to zero
    // MessageNodes, so assistantParentFallback falls back to the carrier's own
    // parent header (u1).
    //
    // No per-ancestor truncation in the two-node model: buildBranchChain walks
    // structural parents up from u1, and u1's only ancestor is the root. The
    // superseded original reply a1 is an un-taken sibling reply run — it shares
    // u1 as parent but is not on the upward chain, so it is naturally excluded.
    const ch = createMockChannel();
    const codec = codecWithFunctionalDecoder();
    // eslint-disable-next-line @typescript-eslint/no-misused-promises, @typescript-eslint/promise-function-async -- mock returns Promise directly
    ch.history.mockImplementation(() => {
      const items = [
        makeRunStartMsg('run-2', 'u1', { regenerates: 'a1' }),
        makeContentMsg('run-1', 'a1', 's-04'),
        makeRunStartMsg('run-1', 'u1'),
        makeInputMsg('u1', 's-02'),
      ];
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock pagination
      const page = { items, hasNext: () => false, next: () => Promise.resolve(page) };
      return Promise.resolve(page);
    });

    const runId = 'run-2';
    const invocationId = 'inv-regen';
    const inputEventId = 'p-regen';
    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'test-channel',
      codec,
      inputEventLookupTimeoutMs: 5000,
    });
    await session.connect();
    const run = createRunFromOpts(session, { runId, invocationId, inputEventId });
    const startPromise = run.start();
    // The regenerate carrier decodes to zero MessageNodes (codecWithFunctionalDecoder
    // returns no events when msg-regenerate is present), so assistantParentFallback
    // resolves from the carrier's `parent` header (u1).
    deliverInputEvent(ch, {
      invocationId,
      runId,
      codecMessageId: 'rc',
      serial: 's-05',
      inputEventId,
      parent: 'u1',
      regenerates: 'a1',
    });
    await startPromise;

    const history = await run.loadConversation();
    // Chain is just the input node u1; the superseded reply a1 (sibling reply
    // run) is excluded; run-2 has streamed no content yet.
    expect(history).toEqual([{ id: 'u1', content: 'u1' }]);
    expect(run.messages).toEqual(history);
    session.close();
  });

  it('excludes the edited prompt and its reply (un-taken fork) when editing a user message', async () => {
    // Two-node model. Conversation: u1 → run-1(a1) → u2 → run-2(a2). The user
    // edits u2: the edit creates a NEW input node u2b that forks off u2
    // (forkOf=u2) and chains to the same structural parent a1 (parent=a1). The
    // agent serves the reply to the edited prompt (run-3, parented at u2b).
    //
    // buildBranchChain walks u2b→a1→u1 (root-first u1, a1, u2b). The un-taken
    // fork — the original prompt u2 and its reply a2 — shares the parent a1 but
    // is not on the upward chain from u2b, so it is naturally excluded. No
    // per-ancestor truncation needed.
    const ch = createMockChannel();
    const codec = codecWithFunctionalDecoder();
    // eslint-disable-next-line @typescript-eslint/no-misused-promises, @typescript-eslint/promise-function-async -- mock returns Promise directly
    ch.history.mockImplementation(() => {
      const items = [
        makeRunStartMsg('run-3', 'u2b'),
        makeInputMsg('u2b', 's-07', { parent: 'a1', forkOf: 'u2' }),
        makeContentMsg('run-2', 'a2', 's-06'),
        makeRunStartMsg('run-2', 'u2'),
        makeInputMsg('u2', 's-05', { parent: 'a1' }),
        makeContentMsg('run-1', 'a1', 's-04'),
        makeRunStartMsg('run-1', 'u1'),
        makeInputMsg('u1', 's-02'),
      ];
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock pagination
      const page = { items, hasNext: () => false, next: () => Promise.resolve(page) };
      return Promise.resolve(page);
    });

    const runId = 'run-3';
    const invocationId = 'inv-edit';
    const inputEventId = 'p-edit';
    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'test-channel',
      codec,
      inputEventLookupTimeoutMs: 5000,
    });
    await session.connect();
    const run = createRunFromOpts(session, { runId, invocationId, inputEventId });
    const startPromise = run.start();
    deliverInputEvent(ch, {
      invocationId,
      runId,
      codecMessageId: 'u2b',
      serial: 's-07',
      inputEventId,
      parent: 'a1',
      forkOf: 'u2',
    });
    await startPromise;

    const history = await run.loadConversation();
    // Chain is u1 → a1 → u2b (the edited prompt); the un-taken fork u2/a2 is
    // excluded; run-3 has streamed no content yet.
    expect(history).toEqual([
      { id: 'u1', content: 'u1' },
      { id: 'a1', content: 'a1' },
      { id: 'u2b', content: 'u2b' },
    ]);
    expect(run.messages).toEqual(history);
    session.close();
  });

  it('seeds the chain from the live-delivered input node when run-start is absent from history (indexing lag)', async () => {
    // Two-node model. Turn 1: input u1 → reply run-1 (assistant a1) — present in
    // history. Turn 2 (current): the run-less input node u2 was delivered live
    // (parent=a1) but neither u2 nor run-2's ai-run-start has been indexed into
    // channel.history yet (rare Ably lag). The agent still seeds the chain from
    // u2 because assistantParentFallback is computed at run-start from the live
    // input-event lookup, and u2 is folded from liveLookupMessages (merged into
    // the history fetch by withLiveMessages). buildBranchChain walks u2→a1→u1.
    const ch = createMockChannel();
    const codec = codecWithFunctionalDecoder();
    // eslint-disable-next-line @typescript-eslint/no-misused-promises, @typescript-eslint/promise-function-async -- mock returns Promise directly
    ch.history.mockImplementation(() => {
      // History has turn-1 only; the live-delivered u2 is not yet indexed.
      const items = [makeContentMsg('run-1', 'a1', 's-04'), makeRunStartMsg('run-1', 'u1'), makeInputMsg('u1', 's-02')];
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock pagination
      const page = { items, hasNext: () => false, next: () => Promise.resolve(page) };
      return Promise.resolve(page);
    });

    const runId = 'run-2';
    const invocationId = 'inv-2';
    const inputEventId = 'e-2';
    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'test-channel',
      codec,
      inputEventLookupTimeoutMs: 5000,
    });
    await session.connect();
    // Deliver the run-less user input node before start() so it buffers and
    // resolves during start(). parent='a1' chains it onto turn 1.
    deliverInputEvent(ch, {
      invocationId,
      codecMessageId: 'u2',
      serial: 's-05',
      inputEventId,
      parent: 'a1',
    });
    const run = createRunFromOpts(session, { runId, invocationId, inputEventId });
    await run.start();

    const history = await run.loadConversation();
    // u1 + a1 come from history; u2 from the live-delivered input node (merged
    // via liveLookupMessages); run-2 has streamed no content yet.
    expect(history).toEqual([
      { id: 'u1', content: 'u1' },
      { id: 'a1', content: 'a1' },
      { id: 'u2', content: 'u2' },
    ]);
    expect(run.messages).toEqual(history);
    session.close();
  });

  it('terminates without hanging when a cycle is detected in the ancestor chain', async () => {
    // run-1's ai-run-start has HEADER_PARENT='msg-1', which is also owned by run-1
    // (makeContentMsg('run-1','msg-1')). The parent codec-message-id resolves back
    // to run-1's own node — a self-referential cycle in the parent chain.
    const ch = createMockChannel();
    const codec = codecWithFunctionalDecoder();
    // eslint-disable-next-line @typescript-eslint/no-misused-promises, @typescript-eslint/promise-function-async -- mock returns Promise directly
    ch.history.mockImplementation(() => {
      const items = [makeContentMsg('run-1', 'msg-1'), makeRunStartMsg('run-1', 'msg-1')];
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock pagination
      const page = { items, hasNext: () => false, next: () => Promise.resolve(page) };
      return Promise.resolve(page);
    });

    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'test-channel',
      codec,
      inputEventLookupTimeoutMs: 0,
    });
    await session.connect();
    const run = createRunFromOpts(session, { runId: 'run-1' });
    await run.start();

    // Cycle guard prevents the while loop from running forever.
    const history = await run.loadConversation();
    expect(Array.isArray(history)).toBe(true);
    expect(run.messages).toEqual(history);
    session.close();
  });

  it('does not fold current-run messages twice when a continuation ai-run-start parents off the same run', async () => {
    const ch = createMockChannel();
    const codec = codecWithFunctionalDecoder();
    // eslint-disable-next-line @typescript-eslint/no-misused-promises, @typescript-eslint/promise-function-async -- mock returns Promise directly
    ch.history.mockImplementation(() => {
      const items = [
        // Newest first (Ably history order). serials are ascending for correct sort.
        makeContentMsg('run-1', 'msg-3', 's-05'), // continuation user/tool-output message
        makeRunStartMsg('run-1', 'msg-2'), // continuation run-start — parents off msg-2
        makeContentMsg('run-1', 'msg-2', 's-03'), // assistant message from initial pass
        makeContentMsg('run-1', 'msg-1', 's-02'), // user message from initial pass
        makeRunStartMsg('run-1'), // initial run-start (no parent — root run)
      ];
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock pagination
      const page = { items, hasNext: () => false, next: () => Promise.resolve(page) };
      return Promise.resolve(page);
    });

    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'test-channel',
      codec,
      inputEventLookupTimeoutMs: 0,
    });
    await session.connect();
    const run = createRunFromOpts(session, { runId: 'run-1' });
    await run.start();

    const history = await run.loadConversation();

    // Each of the three content messages must appear exactly once.
    expect(history).toEqual([
      { id: 'msg-1', content: 'msg-1' },
      { id: 'msg-2', content: 'msg-2' },
      { id: 'msg-3', content: 'msg-3' },
    ]);
    expect(run.messages).toEqual(history);
    session.close();
  });

  it('folds the current run exactly once on a continuation whose live input parents off a message INSIDE the run', async () => {
    // Regression: a tool-call approval / tool-result continuation reuses the
    // run-id (the input carries a wire run-id) and its triggering input parents
    // INSIDE the current run (parent = the tool-call assistant message a1). The live
    // input-event lookup therefore makes assistantParentFallback resolve to a
    // codec-message-id that belongs to the CURRENT run (tr1, a run-1 node).
    // buildBranchChain walks tr1 → a1 → u1 (root-first u1, a1, tr1), so the
    // chain-fold loop visits two run-1 nodes (a1 and tr1). Without the
    // `if (meta?.runId === runId) continue;` guard, the loop folds run-1
    // wholesale for each of those, and then run-1 is folded AGAIN at the tail —
    // duplicating a1 (the tool_use carrier) and tr1, which downstream surfaces
    // as Anthropic's "tool_use ids must be unique" 400. The current run must be
    // folded ONCE, at the tail.
    const ch = createMockChannel();
    const codec = codecWithFunctionalDecoder();
    // eslint-disable-next-line @typescript-eslint/no-misused-promises, @typescript-eslint/promise-function-async -- mock returns Promise directly
    ch.history.mockImplementation(() => {
      // Newest-first (Ably history order); serials ascending for the internal
      // chronological sort. Turn 1: run-less input u1 → reply run-1 emits the
      // tool-call assistant message a1. Continuation: tr1 reuses run-1 and
      // parents off a1 (INSIDE run-1).
      // makeContentMsg doesn't stamp parent, so add it here:
      // a1 (the tool-call assistant) is structurally parented at the input
      // node u1; tr1 (the continuation input) is parented INSIDE the run at a1.
      // Both already carry run-id = run-1 from makeContentMsg.
      const a1 = stampHeader(makeContentMsg('run-1', 'a1', 's-04'), HEADER_PARENT, 'u1'); // tool-call assistant
      const tr1 = stampHeader(makeContentMsg('run-1', 'tr1', 's-06'), HEADER_PARENT, 'a1'); // continuation input (tool-result), parents off a1, run-1
      const items = [
        tr1, // continuation input
        makeRunStartMsg('run-1', 'a1', { serial: 's-05' }), // continuation run-start — parents off a1 (inside run-1)
        a1, // tool-call assistant message
        makeRunStartMsg('run-1', 'u1', { serial: 's-03' }), // initial run-start — parents off the input node u1
        makeInputMsg('u1', 's-02'), // run-less user input node
      ];
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock pagination
      const page = { items, hasNext: () => false, next: () => Promise.resolve(page) };
      return Promise.resolve(page);
    });

    const runId = 'run-1';
    const invocationId = 'inv-cont';
    const inputEventId = 'p-tr1';
    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'test-channel',
      codec,
      inputEventLookupTimeoutMs: 5000,
    });
    await session.connect();
    const run = createRunFromOpts(session, { runId, invocationId, inputEventId });
    const startPromise = run.start();
    // Deliver the continuation input live: reuses run-1 (wire run-id), parents
    // off a1 (inside the run). This drives assistantParentFallback to tr1 (a
    // run-1 node), reproducing the double-fold trigger.
    deliverInputEvent(ch, {
      invocationId,
      runId,
      codecMessageId: 'tr1',
      serial: 's-06',
      inputEventId,
      parent: 'a1',
    });
    await startPromise;

    const history = await run.loadConversation();

    // The conversation is u1 (input node) + the current run folded once. The
    // current run's content (a1, tr1) appears EXACTLY ONCE — no duplication.
    expect(history).toEqual([
      { id: 'u1', content: 'u1' },
      { id: 'a1', content: 'a1' },
      { id: 'tr1', content: 'tr1' },
    ]);
    // Pin "current run folded once": each run-1 codec-message-id occurs once.
    const ids = history.map((m) => m.id);
    expect(ids.filter((id) => id === 'a1')).toHaveLength(1);
    expect(ids.filter((id) => id === 'tr1')).toHaveLength(1);
    expect(run.messages).toEqual(history);
    session.close();
  });

  it('throws InvalidArgument when the run signal is already aborted', async () => {
    const controller = new AbortController();
    const ch = createMockChannel();
    const codec = codecWithFunctionalDecoder();
    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'test-channel',
      codec,
      inputEventLookupTimeoutMs: 0,
    });
    await session.connect();
    const run = createRunFromOpts(session, { runId: 'run-abort', signal: controller.signal });
    await run.start();

    controller.abort();

    await expect(run.loadConversation()).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    session.close();
  });
});

// ---------------------------------------------------------------------------
// Cross-engine equivalence: agent loadConversation() ≡ client View.getMessages()
//
// The agent reconstructs a served branch by fold-walking the codec-message-id
// parent chain (buildBranchChain); the client View reconstructs the same
// visible branch from the Tree's visibleNodes(). These are two independent
// reconstruction engines over the same wire history. This block is drift
// insurance: for the same two-node history, both must produce the identical
// flat message sequence for the served branch. Both engines are driven from
// the SAME raw wire fixtures and the SAME codec, decoded through the codec's
// own decoder, so any divergence is a genuine engine disagreement.
// ---------------------------------------------------------------------------

/**
 * Extract the `extras.ai.transport` header bag from a synthetic inbound message.
 * @param m - The inbound message.
 * @returns The transport header record (empty if absent).
 */
const transportHeadersOf = (m: Ably.InboundMessage): Record<string, string> =>
  (m.extras as { ai?: { transport?: Record<string, string> } } | undefined)?.ai?.transport ?? {};

/**
 * Build a single-page history mock from a newest-first list of wire fixtures.
 * @param items - Wire fixtures in Ably history order (newest first).
 * @returns A history() implementation returning the items on one page.
 */
const singlePageHistory =
  (items: Ably.InboundMessage[]) =>
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise directly
  () => {
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock pagination
    const page = { items, hasNext: () => false, next: () => Promise.resolve(page) };
    return Promise.resolve(page);
  };

/**
 * Feed a chronological (oldest-first) wire list into a fresh Tree via the same
 * decode→applyMessage path the live client uses, then return the View's flat
 * message-id sequence for the visible branch.
 * @param wiresOldestFirst - Wire fixtures oldest-first (live arrival order).
 * @returns The View's visible message ids.
 */
const viewMessageIds = (wiresOldestFirst: Ably.InboundMessage[]): string[] => {
  const codec = codecWithFunctionalDecoder();
  const logger = makeLogger({ logLevel: LogLevel.Silent });
  const tree: DefaultTree<TestInput, TestOutput, TestProjection> = createTree<TestInput, TestOutput, TestProjection>(
    codec,
    logger,
  );
  const decoder = codec.createDecoder();
  for (const wire of wiresOldestFirst) {
    // Lifecycle wires carry no codec content — apply them as run lifecycle so
    // the Tree backfills run structural metadata, exactly as the live path does.
    if (wire.name === EVENT_RUN_START) {
      const h = transportHeadersOf(wire);
      tree.applyRunLifecycle({
        type: 'start',
        runId: h[HEADER_RUN_ID] ?? '',
        clientId: '',
        serial: wire.serial,
        invocationId: h[HEADER_INVOCATION_ID] ?? '',
        parent: h[HEADER_PARENT],
        forkOf: h[HEADER_FORK_OF],
        regenerates: h[HEADER_MSG_REGENERATE],
      });
      continue;
    }
    const decoded = decoder.decode(wire);
    tree.applyMessage(decoded, transportHeadersOf(wire), wire.serial);
  }
  const sendDelegate: SendDelegate<TestInput> =
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    vi.fn(() =>
      Promise.resolve({
        inputCodecMessageId: 'k',
        runId: Promise.resolve('r'),
        inputEventId: '',
        invocationId: 'inv',
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
        cancel: () => Promise.resolve(),
        optimisticCodecMessageIds: [],
        toInvocation: () => Invocation.fromJSON({ inputEventId: '', sessionName: 'test' }),
      }),
    );
  const view = new DefaultView<TestInput, TestOutput, TestProjection, TestMessage>({
    tree,
    channel: createMockChannel(),
    codec,
    sendDelegate,
    logger,
  });
  return view.getMessages().map((m) => m.id);
};

describe('agent loadConversation ≡ client View.getMessages (cross-engine equivalence)', () => {
  it('agrees on a two-turn linear conversation', async () => {
    // u1 → run-1(a1) → u2 → run-2(a2). The agent serves run-2 (input u2).
    // Newest-first for Ably history.
    // Serials are strictly monotonic across the live wire order so the View's
    // node sort (which keys a reply run by its run-start serial) reconstructs
    // the same chronological branch the agent fold-walk does.
    const wiresNewestFirst = [
      makeContentMsg('run-2', 'a2', 's-06'),
      makeRunStartMsg('run-2', 'u2', { serial: 's-055' }),
      makeInputMsg('u2', 's-05', { parent: 'a1' }),
      makeContentMsg('run-1', 'a1', 's-04'),
      makeRunStartMsg('run-1', 'u1', { serial: 's-03' }),
      makeInputMsg('u1', 's-02'),
    ];

    const ch = createMockChannel();
    const codec = codecWithFunctionalDecoder();
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- mock returns Promise directly
    ch.history.mockImplementation(singlePageHistory(wiresNewestFirst));

    const runId = 'run-2';
    const invocationId = 'inv-2';
    const inputEventId = 'p-u2';
    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'equiv-2turn',
      codec,
      inputEventLookupTimeoutMs: 5000,
    });
    await session.connect();
    const run = createRunFromOpts(session, { runId, invocationId, inputEventId });
    const startPromise = run.start();
    deliverInputEvent(ch, { invocationId, runId, codecMessageId: 'u2', serial: 's-05', inputEventId, parent: 'a1' });
    await startPromise;

    const agentMessages = await run.loadConversation();
    const agentIds = agentMessages.map((m) => m.id);
    const viewIds = viewMessageIds(wiresNewestFirst.toReversed());

    expect(agentIds).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(agentIds).toEqual(viewIds);
    session.close();
  });

  it('agrees on a three-turn linear conversation', async () => {
    // u1 → run-1(a1) → u2 → run-2(a2) → u3 → run-3(a3). Agent serves run-3.
    const wiresNewestFirst = [
      makeContentMsg('run-3', 'a3', 's-08'),
      makeRunStartMsg('run-3', 'u3', { serial: 's-075' }),
      makeInputMsg('u3', 's-07', { parent: 'a2' }),
      makeContentMsg('run-2', 'a2', 's-06'),
      makeRunStartMsg('run-2', 'u2', { serial: 's-055' }),
      makeInputMsg('u2', 's-05', { parent: 'a1' }),
      makeContentMsg('run-1', 'a1', 's-04'),
      makeRunStartMsg('run-1', 'u1', { serial: 's-03' }),
      makeInputMsg('u1', 's-02'),
    ];

    const ch = createMockChannel();
    const codec = codecWithFunctionalDecoder();
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- mock returns Promise directly
    ch.history.mockImplementation(singlePageHistory(wiresNewestFirst));

    const runId = 'run-3';
    const invocationId = 'inv-3';
    const inputEventId = 'p-u3';
    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'equiv-3turn',
      codec,
      inputEventLookupTimeoutMs: 5000,
    });
    await session.connect();
    const run = createRunFromOpts(session, { runId, invocationId, inputEventId });
    const startPromise = run.start();
    deliverInputEvent(ch, { invocationId, runId, codecMessageId: 'u3', serial: 's-07', inputEventId, parent: 'a2' });
    await startPromise;

    const agentMessages = await run.loadConversation();
    const agentIds = agentMessages.map((m) => m.id);
    const viewIds = viewMessageIds(wiresNewestFirst.toReversed());

    expect(agentIds).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3']);
    expect(agentIds).toEqual(viewIds);
    session.close();
  });
});
