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
  HEADER_INVOCATION_ID,
  HEADER_MSG_ID,
  HEADER_PARENT,
  HEADER_PROMPT_ID,
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
import type { AgentSession, MessageNode } from '../../../src/core/transport/types.js';
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
  msgId: overrides?.msgId ?? crypto.randomUUID(),
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
  } as Ably.ChannelStateChange);
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
    abort: vi.fn(() => Promise.resolve()),
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
    classifyEvent: vi.fn((event: TestEvent) =>
      event.type === 'user-message'
        ? ({ kind: 'user-message' as const, message: { id: '', content: event.text ?? '' } } as const)
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
 * codec. The decoder reads the msg-id header from each inbound message and
 * emits a `user-message` event carrying that id; `fold` appends it to the
 * projection's `messages` list so `getMessages` returns one message per
 * inbound Ably message.
 * @returns A codec that decodes each inbound message into a single message whose id reflects the inbound msgId header.
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
  classifyEvent: (event: TestEvent) =>
    event.type === 'user-message'
      ? ({ kind: 'user-message' as const, message: { id: event.text ?? '', content: event.text ?? '' } } as const)
      : ({ kind: 'other' as const } as const),
  // eslint-disable-next-line unicorn/no-useless-undefined -- codec contract returns string | undefined
  resolveToolTarget: () => undefined,
  createEncoder: vi.fn(() => createMockEncoder()),
  createDecoder: vi.fn(() => ({
    decode: (m: Ably.InboundMessage): TestEvent[] => {
      const hdrs = (m.extras as { headers?: Record<string, string> } | undefined)?.headers ?? {};
      const id = hdrs[HEADER_MSG_ID] ?? 'unknown';
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
  /** The msg-id header. */
  msgId: string;
  /** Ably serial (used for dedup and sort assertions). */
  serial: string;
  /** Optional Ably message name; defaults to 'text'. */
  name?: string;
  /** Prompt-id (`x-ably-prompt-id`) the agent matches against `invocation.promptIds`. */
  promptId?: string;
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
    [HEADER_MSG_ID]: opts.msgId,
  };
  if (opts.runId) headers[HEADER_RUN_ID] = opts.runId;
  if (opts.promptId) headers[HEADER_PROMPT_ID] = opts.promptId;
  const msg = {
    name: opts.name ?? 'text',
    serial: opts.serial,
    extras: { headers },
  } as unknown as Ably.InboundMessage;
  if (ch.listener) ch.listener(msg);
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
      const run = createRunFromOpts(session, { runId: 'run-1', clientId: 'user-a' });
      await run.start();

      const startMsg = channel.publishCalls.find((m) => m.name === 'x-ably-run-start');
      expect(startMsg).toBeDefined();
      const headers = (startMsg?.extras as { headers: Record<string, string> } | undefined)?.headers;
      expect(headers?.[HEADER_RUN_ID]).toBe('run-1');
    });

    it('start() stamps x-ably-run-continue on run-start when invocation.isContinuation is true', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1', isContinuation: true });
      await run.start();

      const startMsg = channel.publishCalls.find((m) => m.name === 'x-ably-run-start');
      const headers = (startMsg?.extras as { headers: Record<string, string> } | undefined)?.headers;
      expect(headers?.['x-ably-run-continue']).toBe('true');
    });

    it('start() omits x-ably-run-continue on run-start when invocation.isContinuation is false', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();

      const startMsg = channel.publishCalls.find((m) => m.name === 'x-ably-run-start');
      const headers = (startMsg?.extras as { headers: Record<string, string> } | undefined)?.headers;
      expect(headers?.['x-ably-run-continue']).toBeUndefined();
    });

    it('end() publishes run-end with reason', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1', clientId: 'user-a' });
      await run.start();
      await run.end('complete');

      const endMsg = channel.publishCalls.find((m) => m.name === 'x-ably-run-end');
      expect(endMsg).toBeDefined();
    });

    it('start() is idempotent (subsequent calls are no-ops)', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      await run.start();
      // Only one run-start publish on the channel
      const startMsgs = channel.publishCalls.filter((m) => m.name === 'x-ably-run-start');
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
      const run = createRunFromOpts(session, { runId: 'run-1', clientId: 'user-a' });
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
      const run = createRunFromOpts(session, { runId: 'run-1', clientId: 'user-a' });
      await run.start();
      await run.addMessages([makeNode({ id: 'm1', content: 'hi' })]);

      const opts = codec.lastEncoderOpts();
      const headers = opts?.extras?.headers ?? {};
      expect(headers[HEADER_ROLE]).toBe('user');
      expect(headers[HEADER_RUN_ID]).toBe('run-1');
      expect(headers[HEADER_MSG_ID]).toBeDefined();
    });

    it('creates one encoder per message (distinct headers)', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      await run.addMessages([makeNode({ id: 'm1', content: 'a' }), makeNode({ id: 'm2', content: 'b' })]);

      // Two messages → two createEncoder calls
      expect(codec.encoderCalls).toHaveLength(2);
    });

    it('returns published msg-ids in order', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      const node1 = makeNode({ id: 'm1', content: 'a' });
      const node2 = makeNode({ id: 'm2', content: 'b' });
      const { msgIds } = await run.addMessages([node1, node2]);

      expect(msgIds).toEqual([node1.msgId, node2.msgId]);
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
            msgId: 'client-assigned-id',
            headers: { [HEADER_MSG_ID]: 'client-assigned-id', 'x-domain-foo': 'bar' },
          },
        ),
      ]);

      const headers = codec.lastEncoderOpts()?.extras?.headers ?? {};
      expect(headers[HEADER_MSG_ID]).toBe('client-assigned-id');
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
  // addEvents — publish each event with target's msg-id + amend header
  // -------------------------------------------------------------------------

  describe('addEvents', () => {
    it('creates encoder with HEADER_MSG_ID pointing at the target msg-id', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1', clientId: 'user-a' });
      await run.start();
      await run.addEvents([{ kind: 'event', msgId: 'target-msg-1', events: [{ type: 'tool-output' }] }]);

      const headers = codec.lastEncoderOpts()?.extras?.headers ?? {};
      expect(headers[HEADER_ROLE]).toBe('assistant');
      // HEADER_MSG_ID = target's id so the reducer routes the events onto
      // the existing message via its standard per-message-id fold path.
      expect(headers[HEADER_MSG_ID]).toBe('target-msg-1');
      expect(headers[HEADER_RUN_ID]).toBe('run-1');
    });

    it('calls encoder.publish per event', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      await run.addEvents([
        {
          kind: 'event',
          msgId: 'target-1',
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
        run.addEvents([{ kind: 'event', msgId: 'target-1', events: [{ type: 'ev' }] }]),
      ).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });

    it('uses one encoder per EventsNode (distinct target msg-ids)', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1', clientId: 'user-a' });
      await run.start();
      // Reset counts after start (start publishes run-start, no encoder)
      const before = codec.encoderCalls.length;
      await run.addEvents([
        { kind: 'event', msgId: 'target-1', events: [{ type: 'ev-1' }] },
        { kind: 'event', msgId: 'target-2', events: [{ type: 'ev-2' }] },
      ]);
      // Two nodes → two encoders
      expect(codec.encoderCalls.length - before).toBe(2);
      // Each encoder stamps HEADER_MSG_ID = its target id
      const first = codec.encoderCalls[before]?.opts?.extras?.headers ?? {};
      const second = codec.encoderCalls[before + 1]?.opts?.extras?.headers ?? {};
      expect(first[HEADER_MSG_ID]).toBe('target-1');
      expect(second[HEADER_MSG_ID]).toBe('target-2');
    });

    it('closes each encoder after publishing all events', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      await run.addEvents([{ kind: 'event', msgId: 'target-1', events: [{ type: 'ev-1' }] }]);
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
        run.addEvents([{ kind: 'event', msgId: 'target-1', events: [{ type: 'ev' }] }]),
      ).rejects.toBeErrorInfoWithCode(ErrorCode.RunLifecycleError);
      failSession.close();
    });
  });

  // -------------------------------------------------------------------------
  // pipe — stream events through encoder.publish
  // -------------------------------------------------------------------------

  describe('pipe', () => {
    it('creates encoder with assistant-role transport headers', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1', clientId: 'user-a' });
      await run.start();
      await run.pipe(streamOf({ type: 'text', text: 'hi' }));

      const headers = codec.lastEncoderOpts()?.extras?.headers ?? {};
      expect(headers[HEADER_ROLE]).toBe('assistant');
      expect(headers[HEADER_RUN_ID]).toBe('run-1');
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
    it('aborts run when cancel by runId arrives', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1', clientId: 'user-a' });
      await run.start();

      simulateCancel(channel, { [HEADER_CANCEL_RUN_ID]: 'run-1' });
      await new Promise((r) => setTimeout(r, 5));

      expect(run.abortSignal.aborted).toBe(true);
    });

    it('aborts own runs when cancel-own arrives from the same clientId', async () => {
      const run1 = createRunFromOpts(session, { runId: 'run-1', clientId: 'user-a' });
      const run2 = createRunFromOpts(session, { runId: 'run-2', clientId: 'user-b' });
      await run1.start();
      await run2.start();

      simulateCancel(channel, { [HEADER_CANCEL_OWN]: 'true' }, 'user-a');
      await new Promise((r) => setTimeout(r, 5));

      expect(run1.abortSignal.aborted).toBe(true);
      expect(run2.abortSignal.aborted).toBe(false);
    });

    it('aborts runs by clientId', async () => {
      const run1 = createRunFromOpts(session, { runId: 'run-1', clientId: 'user-a' });
      const run2 = createRunFromOpts(session, { runId: 'run-2', clientId: 'user-b' });
      await run1.start();
      await run2.start();

      simulateCancel(channel, { [HEADER_CANCEL_CLIENT_ID]: 'user-b' });
      await new Promise((r) => setTimeout(r, 5));

      expect(run1.abortSignal.aborted).toBe(false);
      expect(run2.abortSignal.aborted).toBe(true);
    });

    it('aborts all runs when cancel-all arrives', async () => {
      const run1 = createRunFromOpts(session, { runId: 'run-1' });
      const run2 = createRunFromOpts(session, { runId: 'run-2' });
      await run1.start();
      await run2.start();

      simulateCancel(channel, { [HEADER_CANCEL_ALL]: 'true' });
      await new Promise((r) => setTimeout(r, 5));

      expect(run1.abortSignal.aborted).toBe(true);
      expect(run2.abortSignal.aborted).toBe(true);
    });

    it('onCancel returning false prevents abort', async () => {
      const run = createRunFromOpts(session, {
        runId: 'run-1',
        clientId: 'user-a',
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
    it('aborts the run when the external signal fires', async () => {
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

    it('onCancel throws → onError fires and other runs still get aborted', async () => {
      const onError = vi.fn();
      const run1 = createRunFromOpts(session, {
        runId: 'run-1',
        clientId: 'user-a',
        // eslint-disable-next-line @typescript-eslint/require-await -- mock
        onCancel: async () => {
          throw new Error('handler boom');
        },
        onError,
      });
      const run2 = createRunFromOpts(session, { runId: 'run-2', clientId: 'user-a' });
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
    it('aborts all registered runs', async () => {
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
      } as Ably.ChannelStateChange);

      expect(onError).toHaveBeenCalledWith(
        expect.toBeErrorInfo({ code: ErrorCode.ChannelContinuityLost, statusCode: 500 }),
      );
      s.close();
    });
  });

  describe('prompt lookup (multi-message)', () => {
    it('collects every expected prompt-id, dedupes by serial, and returns them sorted', async () => {
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
      const run = createRunFromOpts(s, { runId, invocationId, promptIds: ['p-a', 'p-b'] });
      const startPromise = run.start();

      // Deliver out of order with a duplicate of the first to assert dedup.
      deliverUserPrompt(ch, { invocationId, runId, msgId: 'b', serial: '02', promptId: 'p-b' });
      deliverUserPrompt(ch, { invocationId, runId, msgId: 'a', serial: '01', promptId: 'p-a' });
      deliverUserPrompt(ch, { invocationId, runId, msgId: 'b', serial: '02', promptId: 'p-b' });

      await startPromise;
      expect(run.view.messages).toHaveLength(2);
      expect(run.view.messages[0]?.msgId).toBe('a');
      expect(run.view.messages[1]?.msgId).toBe('b');
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
      const run = createRunFromOpts(s, { runId, invocationId, promptIds: ['p-a', 'p-b'] });
      const startPromise = run.start();

      // Deliver only 1 of 2 before timeout fires.
      deliverUserPrompt(ch, { invocationId, runId, msgId: 'only', serial: '01', promptId: 'p-a' });

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
      deliverUserPrompt(ch, { invocationId, runId, msgId: 'first', serial: '01', promptId: 'p-first' });

      const run = createRunFromOpts(s, { runId, invocationId, promptIds: ['p-first', 'p-second'] });
      const startPromise = run.start();

      // Second message arrives live after the listener registered.
      deliverUserPrompt(ch, { invocationId, runId, msgId: 'second', serial: '02', promptId: 'p-second' });

      await startPromise;
      expect(run.view.messages.map((m) => m.msgId)).toEqual(['first', 'second']);
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
      const run = createRunFromOpts(s, { runId, invocationId, promptIds: ['p-a'] });
      const startPromise = run.start();
      deliverUserPrompt(ch, { invocationId, runId, msgId: 'a', serial: '01', promptId: 'p-a' });
      await startPromise;

      warn.mockClear();
      // Extra arrival after the lookup completed — must warn and drop.
      deliverUserPrompt(ch, { invocationId, runId, msgId: 'b', serial: '02', promptId: 'p-b' });

      const overArrivalCalls = warn.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('over-arrival'),
      );
      expect(overArrivalCalls).toHaveLength(1);
      const ctx = overArrivalCalls[0]?.[1] as
        | { invocationId?: string; expectedCount?: number; msgId?: string }
        | undefined;
      expect(ctx?.invocationId).toBe(invocationId);
      expect(ctx?.expectedCount).toBe(1);
      expect(ctx?.msgId).toBe('b');

      // Prove the over-arrival did not occupy the single buffer slot:
      // deliver a different invocation and assert no FIFO eviction warn
      // fires. If `msg b` were buffered, the buffer would now hold one
      // entry and this would evict it.
      warn.mockClear();
      deliverUserPrompt(ch, { invocationId: 'inv-other', msgId: 'c', serial: '03' });
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
      const run = createRunFromOpts(s, { runId, invocationId, promptIds: ['p-a', 'p-b'] });
      const startPromise = run.start();
      deliverUserPrompt(ch, { invocationId, runId, msgId: 'a', serial: '01', promptId: 'p-a' });

      const rejection = await startPromise.catch((error: unknown) => error);
      expect(rejection).toBeErrorInfoWithCode(ErrorCode.PromptNotFound);
      expect((rejection as Ably.ErrorInfo).message).toContain('decode failed');
      s.close();
    });

    it('aborts the lookup when the run signal aborts mid-collection', async () => {
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
      const run = createRunFromOpts(s, { runId, invocationId, promptIds: ['p-a', 'p-b'] });
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
        deliverUserPrompt(ch, { invocationId: `inv-${String(i)}`, msgId: `m${String(i)}`, serial: `s${String(i)}` });
      }
      warn.mockClear();
      deliverUserPrompt(ch, { invocationId: 'inv-overflow', msgId: 'm-over', serial: 's-over' });

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
        deliverUserPrompt(ch, { invocationId: `inv-${String(i)}`, msgId: `m${String(i)}`, serial: `s${String(i)}` });
      }
      let evictCalls = warn.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('prompt buffer full'),
      );
      expect(evictCalls).toHaveLength(0);

      // The 4th distinct invocation-id must evict `inv-0` and log limit=3.
      deliverUserPrompt(ch, { invocationId: 'inv-3', msgId: 'm3', serial: 's3' });
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
  it('start() succeeds when invocation has no promptIds (continuation send)', async () => {
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
    // promptIds, the lookup is skipped and start() completes synchronously.
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
      promptIds: ['p-1'], // signal that a prompt should be looked up
    });

    await expect(run.start()).rejects.toBeErrorInfoWithCode(ErrorCode.PromptNotFound);
    // The agent should have published an error event
    const errMsg = channel.publishCalls.find((m) => m.name === 'x-ably-error');
    expect(errMsg).toBeDefined();
    session.close();
  });
});
