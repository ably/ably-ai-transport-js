/**
 * AgentSession unit tests.
 *
 * Rewritten against the event-sourced `Codec<TEvent, TProjection, TMessage>`
 * contract — mock encoder uses single-method `publish`, `addMessages` flows
 * through `codec.userMessageEvent` + `encoder.publish`, `addEvents` publishes
 * each event individually, and the channel subscription is unfiltered
 * (cancel + user-prompt + everything else dispatched via the same listener).
 */

import '../../helper/expectations.js';

import * as Ably from 'ably';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EVENT_CANCEL,
  HEADER_CANCEL_ALL,
  HEADER_CANCEL_CLIENT_ID,
  HEADER_CANCEL_INVOCATION_ID,
  HEADER_CANCEL_OWN,
  HEADER_CANCEL_RUN_ID,
  HEADER_CODEC_MESSAGE_ID,
  HEADER_EVENT_ID,
  HEADER_INVOCATION_ID,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_RUN_ID,
} from '../../../src/constants.js';
import type {
  ChannelWriter,
  Codec,
  Decoder,
  Encoder,
  EncoderOptions,
  ReducerMeta,
  WriteOptions,
} from '../../../src/core/codec/types.js';
import { createAgentSession } from '../../../src/core/transport/agent-session.js';
import type { AgentSession, CancelRequest, MessageNode, Run } from '../../../src/core/transport/types.js';
import { ErrorCode } from '../../../src/errors.js';
import { VERSION } from '../../../src/version.js';
import { createMockClient } from '../../helper/mock-client.js';
import { createRunFromOpts } from '../../helper/run-from-opts.js';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

interface TestEvent {
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

const makeNode = (message: TestMessage, overrides?: Partial<MessageNode<TestMessage>>): MessageNode<TestMessage> => ({
  kind: 'message',
  message,
  codecMessageId: overrides?.codecMessageId ?? crypto.randomUUID(),
  parentId: undefined,
  forkOf: undefined,
  headers: {},
  serial: undefined,
  ...overrides,
});

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

const simulateCancel = (channel: MockChannel, headers: Record<string, string>, clientId?: string): void => {
  if (!channel.listener) return;
  const msg = {
    name: EVENT_CANCEL,
    clientId,
    extras: { headers },
  } as unknown as Ably.InboundMessage;
  channel.listener(msg);
};

// ---------------------------------------------------------------------------
// Mock codec (Encoder.publish only)
// ---------------------------------------------------------------------------

interface MockEncoder extends Encoder<TestEvent> {
  publishCalls: { event: TestEvent; opts: WriteOptions | undefined }[];
  failPublishWith: Error | undefined;
}

interface MockCodec extends Codec<TestEvent, TestProjection, TestMessage> {
  encoderCalls: { writer: ChannelWriter; opts: EncoderOptions | undefined }[];
  encoders: MockEncoder[];
  lastEncoder(): MockEncoder | undefined;
  lastEncoderOpts(): EncoderOptions | undefined;
}

const createMockEncoder = (failWith?: Error): MockEncoder => {
  const calls: { event: TestEvent; opts: WriteOptions | undefined }[] = [];
  const enc: MockEncoder = {
    publishCalls: calls,
    failPublishWith: failWith,
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    publish: vi.fn((event: TestEvent, opts?: WriteOptions) => {
      if (enc.failPublishWith) return Promise.reject(enc.failPublishWith);
      calls.push({ event, opts });
      return Promise.resolve();
    }),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    cancel: vi.fn(() => Promise.resolve()),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    close: vi.fn(() => Promise.resolve()),
  };
  return enc;
};

const createMockDecoder = (): Decoder<TestEvent> => ({
  decode: vi.fn(() => []),
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
    fold: vi.fn((state: TestProjection, _event: TestEvent, _meta: ReducerMeta) => state),
    getMessages: vi.fn((p: TestProjection) => p.messages),
    userMessageEvent: vi.fn((m: TestMessage): TestEvent => ({ type: 'user-message', text: m.content })),
    createRegenerateEvent: vi.fn((): TestEvent => ({ type: 'user-message' })),
    classifyEvent: vi.fn((event: TestEvent) =>
      event.type === 'user-message'
        ? ({ kind: 'user-message' as const } as const)
        : ({ kind: 'other' as const } as const),
    ),
    // eslint-disable-next-line unicorn/no-useless-undefined -- vi.fn requires an explicit return matching the codec contract
    resolveToolTarget: vi.fn(() => undefined),
    createEncoder: vi.fn((writer: ChannelWriter, opts?: EncoderOptions) => {
      encoderCalls.push({ writer, opts });
      const enc = overrides?.encoderFactory ? overrides.encoderFactory() : createMockEncoder();
      encoders.push(enc);
      return enc;
    }),
    createDecoder: vi.fn(() => createMockDecoder()),
    isTerminal: vi.fn(() => false),
  };
  return codec;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const streamOf = (...events: TestEvent[]): ReadableStream<TestEvent> =>
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
const codecWithFunctionalDecoder = (): Codec<TestEvent, TestProjection, TestMessage> => ({
  init: (): TestProjection => ({ messages: [] }),
  fold: (state: TestProjection, event: TestEvent): TestProjection => {
    if (event.type === 'user-message' && event.text !== undefined) {
      return { messages: [...state.messages, { id: event.text, content: event.text }] };
    }
    return state;
  },
  getMessages: (p: TestProjection) => p.messages,
  userMessageEvent: (m: TestMessage): TestEvent => ({ type: 'user-message', text: m.id }),
  createRegenerateEvent: (): TestEvent => ({ type: 'user-message' }),
  classifyEvent: (event: TestEvent) =>
    event.type === 'user-message'
      ? ({ kind: 'user-message' as const } as const)
      : ({ kind: 'other' as const } as const),
  // eslint-disable-next-line unicorn/no-useless-undefined -- codec contract returns string | undefined
  resolveToolTarget: () => undefined,
  createEncoder: vi.fn(() => createMockEncoder()),
  createDecoder: vi.fn(() => ({
    decode: (m: Ably.InboundMessage): TestEvent[] => {
      const hdrs = (m.extras as { headers?: Record<string, string> } | undefined)?.headers ?? {};
      const id = hdrs[HEADER_CODEC_MESSAGE_ID] ?? 'unknown';
      return [{ type: 'user-message', text: id }];
    },
  })),
  isTerminal: vi.fn(() => false),
});

interface DeliverUserPromptOpts {
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
  /** Prompt-id (`x-ably-event-id`) the agent matches against `invocation.eventIds`. */
  eventId?: string;
  /** Optional `x-ably-run-client-id` header — populates the run's `clientId` resolution. */
  runClientId?: string;
  /**
   * Optional Ably-level publisher `clientId` (set on the inbound message's
   * `clientId` field, not in `extras.headers`). The agent reads this as the
   * `inputClientId` for re-stamping on its own published events.
   */
  publisherClientId?: string;
  /** Optional `x-ably-parent` header — resolves the run's parent during prompt lookup. */
  parent?: string;
  /** Optional `x-ably-fork-of` header — resolves the run's forkOf during prompt lookup. */
  forkOf?: string;
  /** Optional `x-ably-run-continue` flag — marks the publish as a continuation user-message. */
  runContinue?: boolean;
}

/**
 * Deliver a synthetic user-prompt message to the session's unfiltered
 * channel listener. Mirrors the path real Ably messages would take.
 * @param ch - The mock channel hosting the session's listener.
 * @param opts - Headers, serial, and message name for the synthetic message.
 */
const deliverUserPrompt = (ch: MockChannel, opts: DeliverUserPromptOpts): void => {
  const headers: Record<string, string> = {
    [HEADER_ROLE]: 'user',
    [HEADER_INVOCATION_ID]: opts.invocationId,
    [HEADER_CODEC_MESSAGE_ID]: opts.codecMessageId,
    // Always stamp a event-id — the agent dispatcher routes prompt-bearing
    // messages by `x-ably-event-id`, not by role, so without one the
    // synthetic message wouldn't reach the buffer/lookup path. Tests that
    // care about the specific id supply it via `opts.eventId`; otherwise
    // we derive a unique value from the codec-message-id.
    [HEADER_EVENT_ID]: opts.eventId ?? `p-${opts.codecMessageId}`,
  };
  if (opts.runId) headers[HEADER_RUN_ID] = opts.runId;
  if (opts.runClientId) headers['x-ably-run-client-id'] = opts.runClientId;
  if (opts.parent) headers[HEADER_PARENT] = opts.parent;
  if (opts.forkOf) headers['x-ably-fork-of'] = opts.forkOf;
  if (opts.runContinue) headers['x-ably-run-continue'] = 'true';
  const msg = {
    name: opts.name ?? 'text',
    serial: opts.serial,
    clientId: opts.publisherClientId,
    extras: { headers },
  } as unknown as Ably.InboundMessage;
  if (ch.listener) ch.listener(msg);
};

/**
 * Create a run whose `clientId` is resolved via a delivered user-prompt
 * carrying `x-ably-run-client-id`. Mirrors the wire-only resolution path
 * that production agents use post-AIT-769. Cancel-routing tests rely on
 * the resolved clientId to match `own` / `clientId` filters.
 * @param session - The agent session.
 * @param ch - Mock channel hosting the session's listener.
 * @param opts - Run identity + the clientId to surface via the prompt.
 * @param opts.runId - Run identifier.
 * @param opts.clientId - ClientId stamped on the delivered prompt as `x-ably-run-client-id`.
 * @param opts.invocationId - Optional invocation identifier; defaults to `${runId}-inv`.
 * @param opts.onCancel - Optional cancel handler forwarded to the run.
 * @param opts.onError - Optional error handler forwarded to the run.
 * @returns The created run, after start() has resolved.
 */
const startRunWithClientId = async <TEvent, TProjection, TMessage>(
  session: AgentSession<TEvent, TProjection, TMessage>,
  ch: MockChannel,
  opts: {
    runId: string;
    clientId: string;
    invocationId?: string;
    onCancel?: (req: CancelRequest) => Promise<boolean>;
    onError?: (e: Ably.ErrorInfo) => void;
  },
): Promise<Run<TEvent, TProjection, TMessage>> => {
  const invocationId = opts.invocationId ?? `${opts.runId}-inv`;
  const eventId = `p-${opts.runId}`;
  const run = createRunFromOpts(session, {
    runId: opts.runId,
    invocationId,
    eventIds: [eventId],
    onCancel: opts.onCancel,
    onError: opts.onError,
  });
  const startPromise = run.start();
  deliverUserPrompt(ch, {
    invocationId,
    runId: opts.runId,
    codecMessageId: `m-${opts.runId}`,
    serial: `s-${opts.runId}`,
    eventId,
    runClientId: opts.clientId,
  });
  await startPromise;
  return run;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentSession', () => {
  let channel: MockChannel & Ably.RealtimeChannel;
  let codec: MockCodec;
  let session: AgentSession<TestEvent, TestProjection, TestMessage>;

  beforeEach(async () => {
    channel = createMockChannel();
    codec = createMockCodec();
    session = createAgentSession<TestEvent, TestProjection, TestMessage>({
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
      const s = createAgentSession<TestEvent, TestProjection, TestMessage>({
        client,
        channelName: 'agent-channel',
        codec,
      });
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock check
      expect(client.channels.get).toHaveBeenCalled();
      s.close();
    });

    it('forwards a custom promptRewindWindow to params.rewind', () => {
      const ch = createMockChannel();
      const client = createMockClient(ch);
      const c = createMockCodec();
      const s = createAgentSession<TestEvent, TestProjection, TestMessage>({
        client,
        channelName: 'rewind-channel',
        codec: c,
        promptRewindWindow: '5m',
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
      const s1 = createAgentSession<TestEvent, TestProjection, TestMessage>({ client, channelName: 'ch-a', codec: c });
      // Swap the channel returned by channels.get for the second session so
      // each session has its own channel mock to publish to.
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.mocked takes a method reference
      vi.mocked(client.channels.get).mockReturnValue(ch2);
      const s2 = createAgentSession<TestEvent, TestProjection, TestMessage>({ client, channelName: 'ch-b', codec: c });
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
      const s = createAgentSession<TestEvent, TestProjection, TestMessage>({
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
      const s = createAgentSession<TestEvent, TestProjection, TestMessage>({
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
      const s = createAgentSession<TestEvent, TestProjection, TestMessage>({
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
      const headers = (startMsg?.extras as { headers: Record<string, string> } | undefined)?.headers;
      expect(headers?.[HEADER_RUN_ID]).toBe('run-1');
    });

    it('start() stamps x-ably-run-continue on run-start when the prompt-lookup result carries the continuation flag', async () => {
      // Per-run metadata (continuation, clientId, parent, forkOf) is now
      // resolved from the first prompt-lookup MessageNode's headers — the
      // agent reads `x-ably-run-continue` off the channel, not the body.
      const ch = createMockChannel();
      const c = codecWithFunctionalDecoder();
      const s = createAgentSession({
        client: createMockClient(ch),
        channelName: 'continue',
        codec: c,
        promptLookupTimeoutMs: 5000,
      });
      await s.connect();

      const runId = 'run-cont';
      const invocationId = 'inv-cont';
      const eventId = 'p-cont';
      const run = createRunFromOpts(s, { runId, invocationId, eventIds: [eventId] });
      const startPromise = run.start();
      deliverUserPrompt(ch, {
        invocationId,
        runId,
        codecMessageId: 'm-cont',
        serial: 's-cont',
        eventId,
        runContinue: true,
      });
      await startPromise;

      const startMsg = ch.publishCalls.find((m) => m.name === 'ai-run-start');
      const headers = (startMsg?.extras as { headers: Record<string, string> } | undefined)?.headers;
      expect(headers?.['x-ably-run-continue']).toBe('true');
      s.close();
    });

    it('start() omits x-ably-run-continue on run-start when no continuation header is present', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();

      const startMsg = channel.publishCalls.find((m) => m.name === 'ai-run-start');
      const headers = (startMsg?.extras as { headers: Record<string, string> } | undefined)?.headers;
      expect(headers?.['x-ably-run-continue']).toBeUndefined();
    });

    it('end() publishes run-end with reason', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      await run.end('complete');

      const endMsg = channel.publishCalls.find((m) => m.name === 'ai-run-end');
      expect(endMsg).toBeDefined();
    });

    it('start() stamps x-ably-input-client-id from the triggering input event publisher', async () => {
      // The agent reads the publisher's Ably-level clientId off the input
      // event matched by the prompt-lookup and re-stamps it on its own
      // published events. Here the synthetic prompt is published by
      // 'user-b', so every agent-published event in the invocation carries
      // inputClientId: 'user-b' — independent of who owns the run.
      const runId = 'run-icid-start';
      const invocationId = 'inv-icid-start';
      const eventId = 'p-icid-start';
      const run = createRunFromOpts(session, { runId, invocationId, eventIds: [eventId] });
      const startPromise = run.start();
      deliverUserPrompt(channel, {
        invocationId,
        runId,
        codecMessageId: 'm-icid-start',
        serial: 's-icid-start',
        eventId,
        publisherClientId: 'user-b',
      });
      await startPromise;

      const startMsg = channel.publishCalls.find((m) => m.name === 'ai-run-start');
      const headers = (startMsg?.extras as { headers: Record<string, string> } | undefined)?.headers;
      expect(headers?.['x-ably-input-client-id']).toBe('user-b');
    });

    it('end() stamps x-ably-input-client-id from the triggering input event publisher', async () => {
      const runId = 'run-icid-end';
      const invocationId = 'inv-icid-end';
      const eventId = 'p-icid-end';
      const run = createRunFromOpts(session, { runId, invocationId, eventIds: [eventId] });
      const startPromise = run.start();
      deliverUserPrompt(channel, {
        invocationId,
        runId,
        codecMessageId: 'm-icid-end',
        serial: 's-icid-end',
        eventId,
        publisherClientId: 'user-b',
      });
      await startPromise;
      await run.end('complete');

      const endMsg = channel.publishCalls.find((m) => m.name === 'ai-run-end');
      const headers = (endMsg?.extras as { headers: Record<string, string> } | undefined)?.headers;
      expect(headers?.['x-ably-input-client-id']).toBe('user-b');
    });

    it('start() is idempotent (subsequent calls are no-ops)', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      await run.start();
      // Only one run-start publish on the channel
      const startMsgs = channel.publishCalls.filter((m) => m.name === 'ai-run-start');
      expect(startMsgs).toHaveLength(1);
    });

    it('addMessages() throws if run not started', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await expect(run.addMessages([makeNode({ id: 'm1', content: 'hi' })])).rejects.toBeErrorInfoWithCode(
        ErrorCode.InvalidArgument,
      );
    });

    it('pipe() throws if run not started', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await expect(run.pipe(streamOf({ type: 'text' }))).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });

    it('end() throws if run not started', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await expect(run.end('complete')).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });
  });

  // -------------------------------------------------------------------------
  // addMessages — codec.userMessageEvent + encoder.publish
  // -------------------------------------------------------------------------

  describe('addMessages', () => {
    it('translates each TMessage via codec.userMessageEvent then encoder.publish', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      const node = makeNode({ id: 'm1', content: 'hello' });
      await run.addMessages([node]);

      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock check
      expect(codec.userMessageEvent).toHaveBeenCalledWith({ id: 'm1', content: 'hello' });
      const enc = codec.lastEncoder();
      expect(enc?.publishCalls).toHaveLength(1);
      expect(enc?.publishCalls[0]?.event.type).toBe('user-message');
    });

    it('creates encoder with user-role transport headers', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      await run.addMessages([makeNode({ id: 'm1', content: 'hi' })]);

      const opts = codec.lastEncoderOpts();
      const headers = opts?.extras?.headers ?? {};
      expect(headers[HEADER_ROLE]).toBe('user');
      expect(headers[HEADER_RUN_ID]).toBe('run-1');
      expect(headers[HEADER_CODEC_MESSAGE_ID]).toBeDefined();
    });

    it('stamps x-ably-input-client-id from the triggering input event publisher on addMessages publishes', async () => {
      const runId = 'run-icid-am';
      const invocationId = 'inv-icid-am';
      const eventId = 'p-icid-am';
      const run = createRunFromOpts(session, { runId, invocationId, eventIds: [eventId] });
      const startPromise = run.start();
      deliverUserPrompt(channel, {
        invocationId,
        runId,
        codecMessageId: 'm-icid-am',
        serial: 's-icid-am',
        eventId,
        publisherClientId: 'user-b',
      });
      await startPromise;
      await run.addMessages([makeNode({ id: 'm1', content: 'hi' })]);

      const headers = codec.lastEncoderOpts()?.extras?.headers ?? {};
      expect(headers['x-ably-input-client-id']).toBe('user-b');
    });

    it('creates one encoder per message (distinct headers)', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      await run.addMessages([makeNode({ id: 'm1', content: 'a' }), makeNode({ id: 'm2', content: 'b' })]);

      // Two messages → two createEncoder calls
      expect(codec.encoderCalls).toHaveLength(2);
    });

    it('returns published codec-message-ids in order', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      const node1 = makeNode({ id: 'm1', content: 'a' });
      const node2 = makeNode({ id: 'm2', content: 'b' });
      const { codecMessageIds } = await run.addMessages([node1, node2]);

      expect(codecMessageIds).toEqual([node1.codecMessageId, node2.codecMessageId]);
    });

    it('uses node parentId in transport headers', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      await run.addMessages([makeNode({ id: 'm1', content: 'hi' }, { parentId: 'parent-abc' })]);
      const headers = codec.lastEncoderOpts()?.extras?.headers ?? {};
      expect(headers[HEADER_PARENT]).toBe('parent-abc');
    });

    it('per-node headers override transport defaults', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      await run.addMessages([
        makeNode(
          { id: 'm1', content: 'hi' },
          {
            codecMessageId: 'client-assigned-id',
            headers: { [HEADER_CODEC_MESSAGE_ID]: 'client-assigned-id', 'x-domain-foo': 'bar' },
          },
        ),
      ]);

      const headers = codec.lastEncoderOpts()?.extras?.headers ?? {};
      expect(headers[HEADER_CODEC_MESSAGE_ID]).toBe('client-assigned-id');
      expect(headers['x-domain-foo']).toBe('bar');
      expect(headers[HEADER_ROLE]).toBe('user');
    });

    it('addMessages() throws on encoder.publish failure', async () => {
      const failCodec = createMockCodec({
        encoderFactory: () => createMockEncoder(new Ably.ErrorInfo('publish boom', 40000, 500)),
      });
      const failSession = createAgentSession<TestEvent, TestProjection, TestMessage>({
        client: createMockClient(channel),
        channelName: 'test-channel',
        codec: failCodec,
      });
      await failSession.connect();
      const run = createRunFromOpts(failSession, { runId: 'run-1' });
      await run.start();
      await expect(run.addMessages([makeNode({ id: 'm1', content: 'hi' })])).rejects.toBeErrorInfoWithCode(
        ErrorCode.RunLifecycleError,
      );
      failSession.close();
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
    });

    it('stamps x-ably-input-client-id from the triggering input event publisher on addEvents publishes', async () => {
      const runId = 'run-icid-ae';
      const invocationId = 'inv-icid-ae';
      const eventId = 'p-icid-ae';
      const run = createRunFromOpts(session, { runId, invocationId, eventIds: [eventId] });
      const startPromise = run.start();
      deliverUserPrompt(channel, {
        invocationId,
        runId,
        codecMessageId: 'm-icid-ae',
        serial: 's-icid-ae',
        eventId,
        publisherClientId: 'user-b',
      });
      await startPromise;
      await run.addEvents([{ kind: 'event', codecMessageId: 'target-1', events: [{ type: 'ev' }] }]);

      const headers = codec.lastEncoderOpts()?.extras?.headers ?? {};
      expect(headers['x-ably-input-client-id']).toBe('user-b');
    });

    it('calls encoder.publish per event', async () => {
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
      expect(enc?.publishCalls.map((c) => c.event.type)).toEqual(['ev-a', 'ev-b', 'ev-c']);
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

    it('throws RunLifecycleError when an encoder.publish fails', async () => {
      const failCodec = createMockCodec({
        encoderFactory: () => createMockEncoder(new Ably.ErrorInfo('boom', 40000, 500)),
      });
      const failSession = createAgentSession<TestEvent, TestProjection, TestMessage>({
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
    });

    it('stamps x-ably-input-client-id from the triggering input event publisher on assistant publishes', async () => {
      const runId = 'run-icid-pipe';
      const invocationId = 'inv-icid-pipe';
      const eventId = 'p-icid-pipe';
      const run = createRunFromOpts(session, { runId, invocationId, eventIds: [eventId] });
      const startPromise = run.start();
      deliverUserPrompt(channel, {
        invocationId,
        runId,
        codecMessageId: 'm-icid-pipe',
        serial: 's-icid-pipe',
        eventId,
        publisherClientId: 'user-b',
      });
      await startPromise;
      await run.pipe(streamOf({ type: 'text', text: 'hi' }));

      const headers = codec.lastEncoderOpts()?.extras?.headers ?? {};
      expect(headers['x-ably-input-client-id']).toBe('user-b');
    });

    it('publishes each stream event through encoder.publish', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      await run.pipe(streamOf({ type: 'text', text: 'a' }, { type: 'text', text: 'b' }));

      const enc = codec.lastEncoder();
      expect(enc?.publishCalls).toHaveLength(2);
      expect(enc?.publishCalls.map((c) => c.event.text)).toEqual(['a', 'b']);
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

    it('defaults assistant parent to the most recently looked-up user prompt', async () => {
      // Stand up a session whose prompt lookup will resolve via the channel
      // dispatcher — this populates `run.view.messages` with the user prompt
      // before pipe runs, exercising the new default.
      const ch = createMockChannel();
      const base = codecWithFunctionalDecoder();
      // Wrap createEncoder to capture the headers Run.pipe stamps as defaults.
      let capturedHeaders: Record<string, string> | undefined;
      const c: Codec<TestEvent, TestProjection, TestMessage> = {
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
        promptLookupTimeoutMs: 5000,
      });
      await s.connect();

      const runId = 'r-pp';
      const invocationId = 'inv-pp';
      const run = createRunFromOpts(s, { runId, invocationId, eventIds: ['p-u1'] });
      const startPromise = run.start();
      deliverUserPrompt(ch, { invocationId, runId, codecMessageId: 'user-1', serial: '01', eventId: 'p-u1' });
      await startPromise;

      await run.pipe(streamOf({ type: 'text', text: 'reply' }));

      expect(capturedHeaders?.[HEADER_PARENT]).toBe('user-1');
      s.close();
    });

    it('omits parent header when view.messages is empty and no pipe parent is supplied', async () => {
      // Per-message metadata is resolved from the prompt-lookup result. With
      // no event-id (and thus no lookup), `run.view.messages` stays empty
      // and pipe falls through with no parent header on the encoder defaults.
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      await run.pipe(streamOf({ type: 'text', text: 'reply' }));

      const headers = codec.lastEncoderOpts()?.extras?.headers ?? {};
      expect(headers[HEADER_PARENT]).toBeUndefined();
    });

    it('forwards resolveWriteOptions per-event overrides into encoder.publish', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      const events: TestEvent[] = [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ];
      await run.pipe(streamOf(...events), {
        resolveWriteOptions: (event: TestEvent) => (event.text === 'b' ? { messageId: 'override-b' } : undefined),
      });

      const enc = codec.lastEncoder();
      expect(enc?.publishCalls).toHaveLength(2);
      expect(enc?.publishCalls[0]?.opts).toBeUndefined();
      expect(enc?.publishCalls[1]?.opts).toEqual({ messageId: 'override-b' });
    });

    it('uses codec.resolveToolTarget to override messageId after loadProjection', async () => {
      const targetCodec = createMockCodec();
      // Mock codec.resolveToolTarget: for events tagged with text === 'tool-output',
      // return msg-X. Other events return undefined.
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.mocked accessor
      vi.mocked(targetCodec.resolveToolTarget).mockImplementation((event: TestEvent) =>
        event.text === 'tool-output' ? 'msg-X' : undefined,
      );
      const targetSession = createAgentSession<TestEvent, TestProjection, TestMessage>({
        client: createMockClient(channel),
        channelName: 'test',
        codec: targetCodec,
      });
      await targetSession.connect();
      const run = createRunFromOpts(targetSession, { runId: 'run-1' });
      await run.start();
      await run.loadProjection();

      await run.pipe(streamOf({ type: 'text', text: 'tool-output' }, { type: 'text', text: 'plain' }));

      const enc = targetCodec.lastEncoder();
      expect(enc?.publishCalls).toHaveLength(2);
      // First event: tool-output → messageId overridden to msg-X.
      expect(enc?.publishCalls[0]?.opts?.messageId).toBe('msg-X');
      // Second event: plain → no override, no messageId in per-write opts.
      expect(enc?.publishCalls[1]?.opts?.messageId).toBeUndefined();
      targetSession.close();
    });

    it('caller-supplied messageId wins over codec.resolveToolTarget', async () => {
      const targetCodec = createMockCodec();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.mocked accessor
      vi.mocked(targetCodec.resolveToolTarget).mockImplementation(() => 'codec-target');
      const targetSession = createAgentSession<TestEvent, TestProjection, TestMessage>({
        client: createMockClient(channel),
        channelName: 'test',
        codec: targetCodec,
      });
      await targetSession.connect();
      const run = createRunFromOpts(targetSession, { runId: 'run-1' });
      await run.start();
      await run.loadProjection();

      await run.pipe(streamOf({ type: 'text', text: 'a' }), {
        resolveWriteOptions: () => ({ messageId: 'caller-target' }),
      });

      const enc = targetCodec.lastEncoder();
      expect(enc?.publishCalls[0]?.opts?.messageId).toBe('caller-target');
      targetSession.close();
    });

    it('skips codec.resolveToolTarget when loadProjection has not been called', async () => {
      const targetCodec = createMockCodec();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.mocked accessor
      vi.mocked(targetCodec.resolveToolTarget).mockImplementation(() => 'codec-target');
      const targetSession = createAgentSession<TestEvent, TestProjection, TestMessage>({
        client: createMockClient(channel),
        channelName: 'test',
        codec: targetCodec,
      });
      await targetSession.connect();
      const run = createRunFromOpts(targetSession, { runId: 'run-1' });
      await run.start();
      // No loadProjection() call — pipe should NOT consult resolveToolTarget.

      await run.pipe(streamOf({ type: 'text', text: 'a' }));

      const enc = targetCodec.lastEncoder();
      // No override fired; opts is undefined (the default).
      expect(enc?.publishCalls[0]?.opts).toBeUndefined();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.mocked accessor
      expect(vi.mocked(targetCodec.resolveToolTarget)).not.toHaveBeenCalled();
      targetSession.close();
    });
  });

  // -------------------------------------------------------------------------
  // cancel routing
  // -------------------------------------------------------------------------

  describe('cancel routing', () => {
    it('cancels run when cancel by runId arrives', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();

      simulateCancel(channel, { [HEADER_CANCEL_RUN_ID]: 'run-1' });
      await new Promise((r) => setTimeout(r, 5));

      expect(run.abortSignal.aborted).toBe(true);
    });

    it('cancels own runs when cancel-own arrives from the same clientId', async () => {
      // Per-run clientId is resolved from the prompt-lookup result —
      // deliver a user-prompt carrying `x-ably-run-client-id` to populate it.
      // Use a functional-decoder session so the lookup populates viewMessages
      // with a real MessageNode (the cancel-routing path reads clientId off
      // the first node's headers).
      const ch = createMockChannel();
      const s = createAgentSession({
        client: createMockClient(ch),
        channelName: 'cancel-own',
        codec: codecWithFunctionalDecoder(),
        promptLookupTimeoutMs: 5000,
      });
      await s.connect();

      const run1 = await startRunWithClientId(s, ch, { runId: 'run-1', clientId: 'user-a' });
      const run2 = await startRunWithClientId(s, ch, { runId: 'run-2', clientId: 'user-b' });

      simulateCancel(ch, { [HEADER_CANCEL_OWN]: 'true' }, 'user-a');
      await new Promise((r) => setTimeout(r, 5));

      expect(run1.abortSignal.aborted).toBe(true);
      expect(run2.abortSignal.aborted).toBe(false);
      s.close();
    });

    it('cancels runs by clientId', async () => {
      const ch = createMockChannel();
      const s = createAgentSession({
        client: createMockClient(ch),
        channelName: 'cancel-by-client',
        codec: codecWithFunctionalDecoder(),
        promptLookupTimeoutMs: 5000,
      });
      await s.connect();

      const run1 = await startRunWithClientId(s, ch, { runId: 'run-1', clientId: 'user-a' });
      const run2 = await startRunWithClientId(s, ch, { runId: 'run-2', clientId: 'user-b' });

      simulateCancel(ch, { [HEADER_CANCEL_CLIENT_ID]: 'user-b' });
      await new Promise((r) => setTimeout(r, 5));

      expect(run1.abortSignal.aborted).toBe(false);
      expect(run2.abortSignal.aborted).toBe(true);
      s.close();
    });

    it('cancels all runs when cancel-all arrives', async () => {
      const run1 = createRunFromOpts(session, { runId: 'run-1' });
      const run2 = createRunFromOpts(session, { runId: 'run-2' });
      await run1.start();
      await run2.start();

      simulateCancel(channel, { [HEADER_CANCEL_ALL]: 'true' });
      await new Promise((r) => setTimeout(r, 5));

      expect(run1.abortSignal.aborted).toBe(true);
      expect(run2.abortSignal.aborted).toBe(true);
    });

    it('onCancel returning false prevents cancel', async () => {
      const run = createRunFromOpts(session, {
        runId: 'run-1',
        // eslint-disable-next-line @typescript-eslint/require-await -- mock
        onCancel: async () => false,
      });
      await run.start();

      simulateCancel(channel, { [HEADER_CANCEL_RUN_ID]: 'run-1' });
      await new Promise((r) => setTimeout(r, 5));

      expect(run.abortSignal.aborted).toBe(false);
    });

    it('no-op when no run matches the filter', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();

      simulateCancel(channel, { [HEADER_CANCEL_RUN_ID]: 'run-other' });
      await new Promise((r) => setTimeout(r, 5));

      expect(run.abortSignal.aborted).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // early cancel
  // -------------------------------------------------------------------------

  describe('early cancel', () => {
    it('fires abort signal even before start() is called', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      simulateCancel(channel, { [HEADER_CANCEL_RUN_ID]: 'run-1' });
      await new Promise((r) => setTimeout(r, 5));
      expect(run.abortSignal.aborted).toBe(true);
    });

    it('start() throws when run was cancelled early', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      simulateCancel(channel, { [HEADER_CANCEL_RUN_ID]: 'run-1' });
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

      const stream = new ReadableStream<TestEvent>({
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
      const failSession = createAgentSession<TestEvent, TestProjection, TestMessage>({
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
      const stream = new ReadableStream<TestEvent>({
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

    it('onCancel throws → onError fires and other runs still get cancelled', async () => {
      const onError = vi.fn();
      const run1 = createRunFromOpts(session, {
        runId: 'run-1',
        // eslint-disable-next-line @typescript-eslint/require-await -- mock
        onCancel: async () => {
          throw new Error('handler boom');
        },
        onError,
      });
      const run2 = createRunFromOpts(session, { runId: 'run-2' });
      await run1.start();
      await run2.start();

      simulateCancel(channel, { [HEADER_CANCEL_ALL]: 'true' });
      await new Promise((r) => setTimeout(r, 5));

      expect(run2.abortSignal.aborted).toBe(true);
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
        const s = createAgentSession<TestEvent, TestProjection, TestMessage>({
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
      const s = createAgentSession<TestEvent, TestProjection, TestMessage>({
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

  describe('prompt lookup (multi-message)', () => {
    it('collects every expected event-id, dedupes by serial, and returns them sorted', async () => {
      const ch = createMockChannel();
      const c = codecWithFunctionalDecoder();
      const s = createAgentSession({
        client: createMockClient(ch),
        channelName: 'multi-msg',
        codec: c,
        promptLookupTimeoutMs: 5000,
      });
      await s.connect();

      const runId = 'r-multi';
      const invocationId = 'inv-multi';
      const run = createRunFromOpts(s, { runId, invocationId, eventIds: ['p-a', 'p-b'] });
      const startPromise = run.start();

      // Deliver out of order with a duplicate of the first to assert dedup.
      deliverUserPrompt(ch, { invocationId, runId, codecMessageId: 'b', serial: '02', eventId: 'p-b' });
      deliverUserPrompt(ch, { invocationId, runId, codecMessageId: 'a', serial: '01', eventId: 'p-a' });
      deliverUserPrompt(ch, { invocationId, runId, codecMessageId: 'b', serial: '02', eventId: 'p-b' });

      await startPromise;
      expect(run.view.messages).toHaveLength(2);
      expect(run.view.messages[0]?.codecMessageId).toBe('a');
      expect(run.view.messages[1]?.codecMessageId).toBe('b');
      s.close();
    });

    it('rejects with PromptNotFound including "received X of Y" on partial collection at timeout', async () => {
      const ch = createMockChannel();
      const c = codecWithFunctionalDecoder();
      const s = createAgentSession({
        client: createMockClient(ch),
        channelName: 'partial',
        codec: c,
        promptLookupTimeoutMs: 5,
      });
      await s.connect();

      const runId = 'r-partial';
      const invocationId = 'inv-partial';
      const run = createRunFromOpts(s, { runId, invocationId, eventIds: ['p-a', 'p-b'] });
      const startPromise = run.start();

      // Deliver only 1 of 2 before timeout fires.
      deliverUserPrompt(ch, { invocationId, runId, codecMessageId: 'only', serial: '01', eventId: 'p-a' });

      const rejection = await startPromise.catch((error: unknown) => error);
      expect(rejection).toBeErrorInfoWithCode(ErrorCode.PromptNotFound);
      expect((rejection as Ably.ErrorInfo).message).toContain('received 1 of 2');
      s.close();
    });

    it('drains buffered prompts in insertion order and stays registered for the remainder', async () => {
      const ch = createMockChannel();
      const c = codecWithFunctionalDecoder();
      const s = createAgentSession({
        client: createMockClient(ch),
        channelName: 'drain',
        codec: c,
        promptLookupTimeoutMs: 5000,
      });
      await s.connect();

      const runId = 'r-drain';
      const invocationId = 'inv-drain';
      // Pre-buffer one message before any listener is registered.
      deliverUserPrompt(ch, { invocationId, runId, codecMessageId: 'first', serial: '01', eventId: 'p-first' });

      const run = createRunFromOpts(s, { runId, invocationId, eventIds: ['p-first', 'p-second'] });
      const startPromise = run.start();

      // Second message arrives live after the listener registered.
      deliverUserPrompt(ch, { invocationId, runId, codecMessageId: 'second', serial: '02', eventId: 'p-second' });

      await startPromise;
      expect(run.view.messages.map((m) => m.codecMessageId)).toEqual(['first', 'second']);
      s.close();
    });

    it('waits for continuation tool-resolution publishes via HEADER_RUN_CONTINUE + HEADER_EVENT_ID', async () => {
      // Continuation tool resolutions publish as `role: 'user'` channel
      // messages stamped with `x-ably-run-continue: 'true'` plus a
      // event-id. The agent dispatcher routes any inbound message
      // carrying `x-ably-event-id`, so the lookup picks up the
      // continuation publish regardless of how it was minted on the wire.
      const ch = createMockChannel();
      const c = codecWithFunctionalDecoder();
      const s = createAgentSession({
        client: createMockClient(ch),
        channelName: 'continuation-wait',
        codec: c,
        promptLookupTimeoutMs: 5000,
      });
      await s.connect();

      const runId = 'r-cont';
      const invocationId = 'inv-cont';
      const eventId = 'p-cont';
      const run = createRunFromOpts(s, { runId, invocationId, eventIds: [eventId] });
      const startPromise = run.start();

      // Deliver a synthetic continuation user-message — a `role: 'user'`
      // wire message stamped with HEADER_RUN_CONTINUE so the agent reads
      // the run as a continuation. The lookup resolves solely because
      // the event-id is in the expected set.
      deliverUserPrompt(ch, {
        invocationId,
        runId,
        codecMessageId: 'm-cont',
        serial: 's-cont',
        eventId,
        runContinue: true,
      });

      await expect(startPromise).resolves.toBeUndefined();
      s.close();
    });
  });

  describe('prompt lookup', () => {
    it('warns on over-arrival after a lookup has completed and does not buffer the extra message', async () => {
      const ch = createMockChannel();
      const c = codecWithFunctionalDecoder();
      const { logger, warn } = captureWarnLogger();
      const s = createAgentSession({
        client: createMockClient(ch),
        channelName: 'over-arrival',
        codec: c,
        promptLookupTimeoutMs: 5000,
        // Limit set to 1 so we can prove via the eviction warn that the
        // over-arrival did not occupy a buffer slot. If the over-arrival
        // were buffered, the next unrelated invocation would force a
        // FIFO eviction; with the drop-instead-of-buffer behavior, no
        // eviction occurs.
        promptBufferLimit: 1,
        logger,
      });
      await s.connect();

      const runId = 'r-over';
      const invocationId = 'inv-over';
      const run = createRunFromOpts(s, { runId, invocationId, eventIds: ['p-a'] });
      const startPromise = run.start();
      deliverUserPrompt(ch, { invocationId, runId, codecMessageId: 'a', serial: '01', eventId: 'p-a' });
      await startPromise;

      warn.mockClear();
      // Extra arrival after the lookup completed — must warn and drop.
      deliverUserPrompt(ch, { invocationId, runId, codecMessageId: 'b', serial: '02', eventId: 'p-b' });

      const overArrivalCalls = warn.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('over-arrival'),
      );
      expect(overArrivalCalls).toHaveLength(1);
      const ctx = overArrivalCalls[0]?.[1] as
        | { invocationId?: string; expectedCount?: number; codecMessageId?: string }
        | undefined;
      expect(ctx?.invocationId).toBe(invocationId);
      expect(ctx?.expectedCount).toBe(1);
      expect(ctx?.codecMessageId).toBe('b');

      // Prove the over-arrival did not occupy the single buffer slot:
      // deliver a different invocation and assert no FIFO eviction warn
      // fires. If `msg b` were buffered, the buffer would now hold one
      // entry and this would evict it.
      warn.mockClear();
      deliverUserPrompt(ch, { invocationId: 'inv-other', codecMessageId: 'c', serial: '03' });
      const evictCalls = warn.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('prompt buffer full'),
      );
      expect(evictCalls).toHaveLength(0);
      s.close();
    });

    it('rejects the entire lookup if any message fails to decode', async () => {
      const ch = createMockChannel();
      // Decoder throws on any input.
      const codec: Codec<TestEvent, TestProjection, TestMessage> = {
        init: (): TestProjection => ({ messages: [] }),
        fold: (state: TestProjection): TestProjection => state,
        getMessages: (p: TestProjection) => p.messages,
        userMessageEvent: (m: TestMessage): TestEvent => ({ type: 'user-message', text: m.id }),
        createRegenerateEvent: (): TestEvent => ({ type: 'user-message' }),
        classifyEvent: () => ({ kind: 'other' as const }) as const,
        // eslint-disable-next-line unicorn/no-useless-undefined -- codec contract returns string | undefined
        resolveToolTarget: () => undefined,
        createEncoder: vi.fn(() => createMockEncoder()),
        createDecoder: vi.fn(() => ({
          decode: () => {
            throw new Error('boom');
          },
        })),
        isTerminal: vi.fn(() => false),
      };
      const s = createAgentSession({
        client: createMockClient(ch),
        channelName: 'decode-fail',
        codec,
        promptLookupTimeoutMs: 5000,
      });
      await s.connect();

      const runId = 'r-bad';
      const invocationId = 'inv-bad';
      const run = createRunFromOpts(s, { runId, invocationId, eventIds: ['p-a', 'p-b'] });
      const startPromise = run.start();
      deliverUserPrompt(ch, { invocationId, runId, codecMessageId: 'a', serial: '01', eventId: 'p-a' });

      const rejection = await startPromise.catch((error: unknown) => error);
      expect(rejection).toBeErrorInfoWithCode(ErrorCode.PromptNotFound);
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
        promptLookupTimeoutMs: 5000,
      });
      await s.connect();

      const runId = 'r-abort';
      const invocationId = 'inv-abort';
      const run = createRunFromOpts(s, { runId, invocationId, eventIds: ['p-a', 'p-b'] });
      const startPromise = run.start();

      // Cancel-by-invocation-id triggers controller.abort() on the registered run.
      simulateCancel(ch, { [HEADER_CANCEL_INVOCATION_ID]: invocationId });

      await expect(startPromise).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
      s.close();
    });
  });

  describe('prompt buffer', () => {
    it('warns and FIFO-evicts the oldest entry when the prompt buffer is full', async () => {
      const ch = createMockChannel();
      const c = codecWithFunctionalDecoder();
      const { logger, warn } = captureWarnLogger();
      const s = createAgentSession({
        client: createMockClient(ch),
        channelName: 'evict',
        codec: c,
        promptLookupTimeoutMs: 5000,
        logger,
      });
      await s.connect();

      // Default limit is 200. Fill it, then push one more to trigger eviction.
      for (let i = 0; i < 200; i++) {
        deliverUserPrompt(ch, {
          invocationId: `inv-${String(i)}`,
          codecMessageId: `m${String(i)}`,
          serial: `s${String(i)}`,
        });
      }
      warn.mockClear();
      deliverUserPrompt(ch, { invocationId: 'inv-overflow', codecMessageId: 'm-over', serial: 's-over' });

      const evictCalls = warn.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('prompt buffer full'),
      );
      expect(evictCalls).toHaveLength(1);
      const ctx = evictCalls[0]?.[1] as { evictedInvocationId?: string; limit?: number } | undefined;
      expect(ctx?.evictedInvocationId).toBe('inv-0');
      expect(ctx?.limit).toBe(200);
      s.close();
    });

    it('honours a custom promptBufferLimit option', async () => {
      const ch = createMockChannel();
      const c = codecWithFunctionalDecoder();
      const { logger, warn } = captureWarnLogger();
      const s = createAgentSession({
        client: createMockClient(ch),
        channelName: 'evict-custom',
        codec: c,
        promptLookupTimeoutMs: 5000,
        promptBufferLimit: 3,
        logger,
      });
      await s.connect();

      // Fill the 3-slot buffer; no eviction warns should fire yet.
      for (let i = 0; i < 3; i++) {
        deliverUserPrompt(ch, {
          invocationId: `inv-${String(i)}`,
          codecMessageId: `m${String(i)}`,
          serial: `s${String(i)}`,
        });
      }
      let evictCalls = warn.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('prompt buffer full'),
      );
      expect(evictCalls).toHaveLength(0);

      // The 4th distinct invocation-id must evict `inv-0` and log limit=3.
      deliverUserPrompt(ch, { invocationId: 'inv-3', codecMessageId: 'm3', serial: 's3' });
      evictCalls = warn.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('prompt buffer full'),
      );
      expect(evictCalls).toHaveLength(1);
      const ctx = evictCalls[0]?.[1] as { evictedInvocationId?: string; limit?: number } | undefined;
      expect(ctx?.evictedInvocationId).toBe('inv-0');
      expect(ctx?.limit).toBe(3);
      s.close();
    });
  });
});

// ---------------------------------------------------------------------------
// Prompt lookup (covers AgentSession's channel-rewind user-prompt flow)
// ---------------------------------------------------------------------------

describe('AgentSession prompt lookup', () => {
  it('start() succeeds when invocation has no eventIds (continuation send)', async () => {
    const channel = createMockChannel();
    const codec = createMockCodec();
    const session = createAgentSession<TestEvent, TestProjection, TestMessage>({
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
    const session = createAgentSession<TestEvent, TestProjection, TestMessage>({
      client: createMockClient(channel),
      channelName: 'test-channel',
      codec,
    });
    await session.connect();

    // createRunFromOpts always passes messages: [] in invocation. Without
    // eventIds, the lookup is skipped and start() completes synchronously.
    const run = createRunFromOpts(session, { runId: 'run-1', invocationId: 'inv-1' });
    await expect(run.start()).resolves.toBeUndefined();
    session.close();
  });

  it('start() rejects with PromptNotFound when timeout lapses', async () => {
    const channel = createMockChannel();
    const codec = createMockCodec();
    const session = createAgentSession<TestEvent, TestProjection, TestMessage>({
      client: createMockClient(channel),
      channelName: 'test-channel',
      codec,
      promptLookupTimeoutMs: 10,
    });
    await session.connect();

    const run = createRunFromOpts(session, {
      runId: 'run-1',
      invocationId: 'inv-needs-prompt',
      eventIds: ['p-1'], // signal that a prompt should be looked up
    });

    await expect(run.start()).rejects.toBeErrorInfoWithCode(ErrorCode.PromptNotFound);
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
  it('equals invocation.history before start() resolves', () => {
    const channel = createMockChannel();
    const codec = codecWithFunctionalDecoder();
    const session = createAgentSession<TestEvent, TestProjection, TestMessage>({
      client: createMockClient(channel),
      channelName: 'test-channel',
      codec,
    });
    const history: TestMessage[] = [
      { id: 'h1', content: 'hello' },
      { id: 'h2', content: 'world' },
    ];
    const run = createRunFromOpts(session, { runId: 'run-1', history });
    expect(run.messages).toEqual(history);
    // Fresh array per access — mutating the return value doesn't bleed.
    run.messages.push({ id: 'leak', content: 'no' });
    expect(run.messages).toEqual(history);
    session.close();
  });

  it('appends view-message contributions after start() resolves (fresh send)', async () => {
    const ch = createMockChannel();
    const codec = codecWithFunctionalDecoder();
    const session = createAgentSession<TestEvent, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'fresh',
      codec,
      promptLookupTimeoutMs: 5000,
    });
    await session.connect();
    const history: TestMessage[] = [{ id: 'h1', content: 'old' }];
    const run = createRunFromOpts(session, {
      runId: 'run-1',
      invocationId: 'inv-1',
      eventIds: ['p-fresh'],
      history,
    });
    const startPromise = run.start();
    deliverUserPrompt(ch, {
      invocationId: 'inv-1',
      runId: 'run-1',
      codecMessageId: 'user-new',
      serial: 's-1',
      eventId: 'p-fresh',
    });
    await startPromise;

    // The functional decoder produces { id: codecMessageId, content: codecMessageId }.
    expect(run.messages).toEqual([
      { id: 'h1', content: 'old' },
      { id: 'user-new', content: 'user-new' },
    ]);
    session.close();
  });

  it('overlays history with projection-folded messages on continuation', async () => {
    const ch = createMockChannel();
    const codec = codecWithFunctionalDecoder();
    // channel.history() returns one wire message that the functional decoder
    // folds into a TestMessage with id='h2' — same id as one of the history
    // entries. The overlay must replace the history's `h2` with the projection's
    // version; `h1` passes through unchanged.
    const historyWire = {
      name: 'text',
      serial: 's-proj',
      extras: { headers: { [HEADER_RUN_ID]: 'run-1', [HEADER_CODEC_MESSAGE_ID]: 'h2' } },
    } as unknown as Ably.InboundMessage;
    // eslint-disable-next-line @typescript-eslint/no-misused-promises, @typescript-eslint/promise-function-async -- mock returns a Promise; vi.fn return type is inferred as void.
    ch.history.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock pagination
      const page = { items: [historyWire], hasNext: () => false, next: () => Promise.resolve(page) };
      return Promise.resolve(page);
    });

    const session = createAgentSession<TestEvent, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'cont-overlay',
      codec,
      promptLookupTimeoutMs: 5000,
    });
    await session.connect();
    const history: TestMessage[] = [
      { id: 'h1', content: 'kept' },
      { id: 'h2', content: 'stale' },
    ];
    const run = createRunFromOpts(session, {
      runId: 'run-1',
      invocationId: 'inv-cont',
      eventIds: ['p-cont'],
      history,
    });
    const startPromise = run.start();
    deliverUserPrompt(ch, {
      invocationId: 'inv-cont',
      runId: 'run-1',
      codecMessageId: 'm-cont',
      serial: 's-cont',
      eventId: 'p-cont',
      runContinue: true,
    });
    await startPromise;

    expect(run.messages).toEqual([
      { id: 'h1', content: 'kept' }, // unchanged
      { id: 'h2', content: 'h2' }, // overlaid by the projection
      { id: 'm-cont', content: 'm-cont' }, // view contribution
    ]);
    session.close();
  });

  it('leaves history unchanged on continuation when projection has no overlapping ids', async () => {
    const ch = createMockChannel();
    const codec = codecWithFunctionalDecoder();
    // channel.history returns a wire message with a non-overlapping id.
    const historyWire = {
      name: 'text',
      serial: 's-proj',
      extras: { headers: { [HEADER_RUN_ID]: 'run-1', [HEADER_CODEC_MESSAGE_ID]: 'no-match' } },
    } as unknown as Ably.InboundMessage;
    // eslint-disable-next-line @typescript-eslint/no-misused-promises, @typescript-eslint/promise-function-async -- mock returns a Promise; vi.fn return type is inferred as void.
    ch.history.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock pagination
      const page = { items: [historyWire], hasNext: () => false, next: () => Promise.resolve(page) };
      return Promise.resolve(page);
    });

    const session = createAgentSession<TestEvent, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'cont-no-overlap',
      codec,
      promptLookupTimeoutMs: 5000,
    });
    await session.connect();
    const history: TestMessage[] = [{ id: 'h1', content: 'kept' }];
    const run = createRunFromOpts(session, {
      runId: 'run-1',
      invocationId: 'inv-cont',
      eventIds: ['p-cont'],
      history,
    });
    const startPromise = run.start();
    deliverUserPrompt(ch, {
      invocationId: 'inv-cont',
      runId: 'run-1',
      codecMessageId: 'm-cont',
      serial: 's-cont',
      eventId: 'p-cont',
      runContinue: true,
    });
    await startPromise;

    expect(run.messages).toEqual([
      { id: 'h1', content: 'kept' }, // unchanged
      { id: 'm-cont', content: 'm-cont' },
    ]);
    session.close();
  });

  it('detects continuation status from a tool-resolution-only lookup (firstHeaders fallback)', async () => {
    // Simulates the production case: chat-transport's deriveContinuationEvents
    // publishes a `tool-output-available` wire message. The decoder produces
    // a chunk that folds into an empty per-message projection without an
    // assistant to land on — zero MessageNodes. The agent must still pick up
    // HEADER_RUN_CONTINUE from the wire headers so the run-start stamps it.
    const ch = createMockChannel();
    // A codec whose decoder produces NO events for non-text messages — mimics
    // the chunk-with-no-assistant case. The agent should still treat the
    // delivery as a event-id match.
    const codec: Codec<TestEvent, TestProjection, TestMessage> = {
      init: () => ({ messages: [] }),
      fold: (state) => state,
      getMessages: (p) => p.messages,
      userMessageEvent: (m: TestMessage): TestEvent => ({ type: 'user-message', text: m.id }),
      createRegenerateEvent: (): TestEvent => ({ type: 'user-message' }),
      classifyEvent: () => ({ kind: 'other' as const }) as const,
      // eslint-disable-next-line unicorn/no-useless-undefined -- codec contract
      resolveToolTarget: () => undefined,
      createEncoder: vi.fn(() => createMockEncoder()),
      createDecoder: vi.fn(() => ({ decode: () => [] })),
      isTerminal: vi.fn(() => false),
    };
    const session = createAgentSession<TestEvent, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'cont-tool-only',
      codec,
      promptLookupTimeoutMs: 5000,
    });
    await session.connect();
    const run = createRunFromOpts(session, {
      runId: 'run-1',
      invocationId: 'inv-cont',
      eventIds: ['p-tool'],
    });
    const startPromise = run.start();
    // Deliver a continuation tool-resolution wire message — produces zero
    // MessageNodes but carries HEADER_RUN_CONTINUE='true'.
    deliverUserPrompt(ch, {
      invocationId: 'inv-cont',
      runId: 'run-1',
      codecMessageId: 'm-tool',
      serial: 's-tool',
      eventId: 'p-tool',
      name: 'tool-output-available',
      runContinue: true,
    });
    await startPromise;

    const runStart = ch.publishCalls.find((m) => m.name === 'ai-run-start');
    const startHeaders = (runStart?.extras as { headers?: Record<string, string> } | undefined)?.headers;
    expect(startHeaders?.['x-ably-run-continue']).toBe('true');
    session.close();
  });
});
