/**
 * AgentSession unit tests.
 *
 * Mock encoder uses split-direction `publishInput` / `publishOutput`;
 * `pipe` flows through `encoder.publishOutput`, and the channel
 * subscription is unfiltered (cancel + input events + everything else dispatched
 * via the same listener).
 */

import '../../helper/expectations.js';

import * as Ably from 'ably';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EVENT_CANCEL,
  EVENT_RUN_END,
  EVENT_RUN_START,
  HEADER_CODEC_MESSAGE_ID,
  HEADER_EVENT_ID,
  HEADER_FORK_OF,
  HEADER_INPUT_CLIENT_ID,
  HEADER_INPUT_CODEC_MESSAGE_ID,
  HEADER_INVOCATION_ID,
  HEADER_MSG_REGENERATE,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_ID,
  HEADER_STEP_CLIENT_ID,
} from '../../../src/constants.js';
import type {
  ChannelWriter,
  Codec,
  CodecEvent,
  Decoder,
  Encoder,
  EncoderOptions,
  ReducerMeta,
  Regenerate,
  UserMessage,
  WriteOptions,
} from '../../../src/core/codec/types.js';
import { createAgentSession } from '../../../src/core/transport/agent-session.js';
import { createWireApplier } from '../../../src/core/transport/decode-fold.js';
import { createHistoryHydrator } from '../../../src/core/transport/history-hydrator.js';
import { Invocation } from '../../../src/core/transport/invocation.js';
import type { RunManager } from '../../../src/core/transport/run-manager.js';
import * as runManagerModule from '../../../src/core/transport/run-manager.js';
import type { DefaultTree } from '../../../src/core/transport/tree.js';
import { createTree } from '../../../src/core/transport/tree.js';
import type { AgentSession, ClientRun } from '../../../src/core/transport/types.js';
import type { SendDelegate } from '../../../src/core/transport/view.js';
import { createClientView } from '../../../src/core/transport/view.js';
import { ErrorCode } from '../../../src/errors.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';
import { VERSION } from '../../../src/version.js';
import { createMockClient } from '../../helper/mock-client.js';
import { createRunFromOpts } from '../../helper/run-from-opts.js';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Client-published input variants. */
type TestInput = UserMessage<TestMessage> | Regenerate;

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
  detach: ReturnType<typeof vi.fn>;
  history: ReturnType<typeof vi.fn>;
  state: Ably.ChannelState;
  publishCalls: Ably.Message[];
  listener: ((msg: Ably.InboundMessage) => void) | undefined;
  stateListeners: Set<Ably.channelEventCallback>;
  /** Sentinel presence object — asserted by identity via `session.presence`. */
  presence: Ably.RealtimePresence;
  /** Sentinel LiveObjects entry point — asserted by identity via `session.object`. */
  object: unknown;
}

const createMockChannel = (): MockChannel & Ably.RealtimeChannel => {
  const stateListeners = new Set<Ably.channelEventCallback>();
  const mock: MockChannel = {
    publishCalls: [],
    listener: undefined,
    stateListeners,
    state: 'attached',
    // CAST: only identity is asserted in tests; presence methods are unused here.
    presence: { get: vi.fn(), enter: vi.fn(), leave: vi.fn() } as unknown as Ably.RealtimePresence,
    // Sentinel — only identity is asserted via `session.object`.
    object: { get: vi.fn() },
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
    detach: vi.fn(() => Promise.resolve()),
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
    // `version` is present on every delivery; this cancel mock sets no top-level
    // serial (cancels route by run-id, never folded by serial), so version.serial
    // is unused here — the empty object just satisfies the `.version.serial` read.
    version: {},
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
  /**
   * The transport headers of each `publishOutput`, captured AFTER the encoder's
   * `onMessage` hook ran — so a test can observe the `start-serial` the writer's
   * composed hook stamps per message (the encoder core invokes `onMessage` on a
   * message whose `extras.ai.transport` is the default headers; this mock
   * mirrors that so the stamping path is exercised).
   */
  outputTransport: Record<string, string>[];
}

interface MockCodec extends Codec<TestInput, TestOutput, TestProjection, TestMessage> {
  encoderCalls: { writer: ChannelWriter; opts: EncoderOptions | undefined }[];
  encoders: MockEncoder[];
  lastEncoder(): MockEncoder | undefined;
  lastEncoderOpts(): EncoderOptions | undefined;
}

const createMockEncoder = (failWith?: Error, encoderOpts?: EncoderOptions): MockEncoder => {
  const calls: MockPublishCall[] = [];
  const outputTransport: Record<string, string>[] = [];
  const enc: MockEncoder = {
    publishCalls: calls,
    outputTransport,
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
      // Mirror the encoder core: build the message's transport tier from the
      // default + per-write headers, run the `onMessage` hook (which the writer
      // composes to stamp `start-serial`), then record the resulting headers.
      const transport: Record<string, string> = {
        ...encoderOpts?.extras?.headers,
        ...opts?.extras?.headers,
      };
      const msg: Ably.Message = { name: 'ai-output', extras: { ai: { transport } } };
      encoderOpts?.onMessage?.(msg);
      outputTransport.push((msg.extras as { ai: { transport: Record<string, string> } }).ai.transport);
      return Promise.resolve();
    }),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    cancelStreams: vi.fn(() => Promise.resolve()),
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
    fold: vi.fn((state: TestProjection, _event: CodecEvent<TestInput, TestOutput>, _meta: ReducerMeta) => state),
    getMessages: vi.fn((p: TestProjection) => p.messages.map((m) => ({ codecMessageId: m.id, message: m }))),
    createUserMessage: vi.fn((m: TestMessage) => ({ kind: 'user-message' as const, message: m })),
    createRegenerate: vi.fn(
      (target: string, parent: string) => ({ kind: 'regenerate' as const, target, parent }) as const,
    ),
    createEncoder: vi.fn((writer: ChannelWriter, opts?: EncoderOptions) => {
      encoderCalls.push({ writer, opts });
      const enc = overrides?.encoderFactory ? overrides.encoderFactory() : createMockEncoder(undefined, opts);
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

// A stream that enqueues one chunk then errors — drives a pipe to reason:'error'.
const erroringStream = (): ReadableStream<TestOutput> =>
  new ReadableStream<TestOutput>({
    start: (controller) => {
      controller.enqueue({ type: 'text', text: 'partial' });
      controller.error(new Error('rate limit'));
    },
  });

// The `extras.ai.transport` headers of every published message with a given name.
const stepHeadersOf = (channel: { publishCalls: Ably.Message[] }, name: string): Record<string, string>[] =>
  channel.publishCalls
    .filter((m) => m.name === name)
    .map((m) => (m.extras as { ai?: { transport?: Record<string, string> } }).ai?.transport ?? {});

// vitest's global invocation order of the first channel.publish whose message
// name matches, or undefined if none matched.
const firstPublishOrder = (channel: MockChannel, name: string): number | undefined => {
  const publishMock = vi.mocked(channel.publish);
  const idx = publishMock.mock.calls.findIndex(([msg]) => (msg as Ably.Message).name === name);
  return idx === -1 ? undefined : publishMock.mock.invocationCallOrder[idx];
};

// True iff an `ai-step-end` was published BEFORE the `ai-run-end` on the cancel
// path (the step-end-before-terminal wire invariant). Both must be present.
const stepEndBeforeRunEnd = (channel: MockChannel): boolean => {
  const stepEndOrder = firstPublishOrder(channel, 'ai-step-end');
  const runEndOrder = firstPublishOrder(channel, 'ai-run-end');
  return stepEndOrder !== undefined && runEndOrder !== undefined && stepEndOrder < runEndOrder;
};

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
  fold: (state: TestProjection, codecEvent: CodecEvent<TestInput, TestOutput>): TestProjection => {
    const event = codecEvent.event;
    // Inputs: `user-message` carries a message; `regenerate` is a wire-only
    // signal. Outputs (TestOutput) pass through unchanged.
    if ('kind' in event) {
      if (event.kind === 'regenerate') return state;
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
    // A never-mutated message's version serial equals its serial; carrying it
    // lets the Tree's replay guard dedup a wire delivered both live and via a
    // history walk (the role `_foldedSerials` used to play).
    version: { serial: opts.serial },
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

  afterEach(async () => {
    await session.close();
  });

  // -------------------------------------------------------------------------
  // construction
  // -------------------------------------------------------------------------

  describe('construction', () => {
    it('exposes a createRun factory and close method', () => {
      expect(typeof session.createRun).toBe('function');
      expect(typeof session.close).toBe('function');
    });

    it("exposes the underlying channel's presence object", () => {
      expect(session.presence).toBe(channel.presence);
    });

    it('exposes presence before connect() is called', async () => {
      const ch = createMockChannel();
      const s = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'agent-channel',
        codec,
      });
      expect(s.presence).toBe(ch.presence);
      await s.close();
    });

    it("exposes the underlying channel's object entry point", () => {
      expect(session.object).toBe(channel.object);
    });

    it('exposes object before connect() is called', async () => {
      const ch = createMockChannel();
      const s = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'agent-channel',
        codec,
      });
      expect(s.object).toBe(ch.object);
      await s.close();
    });

    it('requests the resolved modes on the channel when channelModes is supplied', async () => {
      const ch = createMockChannel();
      const client = createMockClient(ch);
      const s = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client,
        channelName: 'object-channel',
        codec,
        channelModes: ['OBJECT_SUBSCRIBE', 'OBJECT_PUBLISH'],
      });
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.mocked takes a method reference
      const options = vi.mocked(client.channels.get).mock.calls[0]?.[1];
      expect(options?.modes).toEqual([
        'PUBLISH',
        'SUBSCRIBE',
        'PRESENCE',
        'PRESENCE_SUBSCRIBE',
        'OBJECT_PUBLISH',
        'OBJECT_SUBSCRIBE',
        'ANNOTATION_PUBLISH',
      ]);
      await s.close();
    });

    it('sets no modes on the channel when channelModes is omitted', async () => {
      const ch = createMockChannel();
      const client = createMockClient(ch);
      const s = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client,
        channelName: 'agent-channel',
        codec,
      });
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.mocked takes a method reference
      const options = vi.mocked(client.channels.get).mock.calls[0]?.[1];
      expect(options?.modes).toBeUndefined();
      await s.close();
    });

    it('registers the agent and resolves the channel via client.channels.get', async () => {
      const ch = createMockChannel();
      const client = createMockClient(ch);
      const s = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client,
        channelName: 'agent-channel',
        codec,
      });
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock check
      expect(client.channels.get).toHaveBeenCalled();
      await s.close();
    });

    it('attaches the channel without a rewind window (untilAttach + Tree covers continuity)', async () => {
      const ch = createMockChannel();
      const client = createMockClient(ch);
      const c = createMockCodec();
      const s = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client,
        channelName: 'rewind-channel',
        codec: c,
      });
      // eslint-disable-next-line @typescript-eslint/unbound-method -- accessing vi mock
      expect(client.channels.get).toHaveBeenCalledWith('rewind-channel', {
        params: { agent: `ai-transport-js/${VERSION}` },
      });
      await s.close();
    });

    it('does not pollute options.agents when constructing multiple sessions on the same client', async () => {
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
      await s1.close();
      await s2.close();
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
      await s.close();
    });

    it('subscribes unfiltered (single listener installed)', () => {
      // beforeEach already connected, so listener is set
      expect(channel.subscribe).toHaveBeenCalledTimes(1);
      expect(typeof channel.listener).toBe('function');
    });

    it('rejects connect when subscribe fails', async () => {
      const ch = createMockChannel();
      // CAST: assign through MockChannel's loose mock type — RealtimeChannel.subscribe's
      // overloads reject vi.fn's inferred signature under ably >= 2.22.
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.reject directly
      (ch as MockChannel).subscribe = vi.fn(() => Promise.reject(new Error('subscribe down')));
      const onError = vi.fn();
      const s = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: createMockCodec(),
      });
      s.on('error', onError);
      await expect(s.connect()).rejects.toBeErrorInfoWithCode(ErrorCode.SessionSubscriptionError);
      expect(onError).toHaveBeenCalled();
      await s.close();
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
      await s.close();
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
      await s.close();
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
      await s.close();
    });

    it('end() publishes run-end with reason', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      await run.end({ reason: 'complete' });

      const endMsg = channel.publishCalls.find((m) => m.name === 'ai-run-end');
      expect(endMsg).toBeDefined();
    });

    it('end() stamps error-code and error-message when an error is supplied with reason error', async () => {
      const run = createRunFromOpts(session, { runId: 'run-err' });
      await run.start();
      await run.end({ reason: 'error', error: new Ably.ErrorInfo('invalid x-api-key', 104008, 500) });

      const endMsg = channel.publishCalls.find((m) => m.name === 'ai-run-end');
      const headers = (endMsg?.extras as { ai?: { transport?: Record<string, string> } } | undefined)?.ai?.transport;
      expect(headers?.['run-reason']).toBe('error');
      expect(headers?.['error-code']).toBe('104008');
      expect(headers?.['error-message']).toBe('invalid x-api-key');
    });

    it('end() omits error headers when reason is error but no error is supplied', async () => {
      const run = createRunFromOpts(session, { runId: 'run-err-bare' });
      await run.start();
      await run.end({ reason: 'error' });

      const endMsg = channel.publishCalls.find((m) => m.name === 'ai-run-end');
      const headers = (endMsg?.extras as { ai?: { transport?: Record<string, string> } } | undefined)?.ai?.transport;
      expect(headers?.['run-reason']).toBe('error');
      expect(headers?.['error-code']).toBeUndefined();
      expect(headers?.['error-message']).toBeUndefined();
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
      await run.end({ reason: 'complete' });

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
      await expect(run.end({ reason: 'complete' })).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
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
      await run.end({ reason: 'complete' });

      // The run was suspended, not ended — no run-end is published.
      expect(channel.publishCalls.filter((m) => m.name === 'ai-run-suspend')).toHaveLength(1);
      expect(channel.publishCalls.find((m) => m.name === 'ai-run-end')).toBeUndefined();
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

    it('publishes ai-run-end(reason:cancelled) on a cancelled pipe without an explicit end()', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();

      // Cancel the run, then pipe a stream that never completes: pipeStream
      // observes the aborted signal and returns reason:'cancelled'. Run.pipe
      // must then guarantee the transport terminator itself.
      simulateCancel(channel, { [HEADER_RUN_ID]: 'run-1' });
      await new Promise((r) => setTimeout(r, 5));

      const paused = new ReadableStream<TestOutput>({
        start: () => {
          /* never enqueues or closes */
        },
      });
      const result = await run.pipe(paused);
      expect(result.reason).toBe('cancelled');

      const endMsg = channel.publishCalls.find((m) => m.name === 'ai-run-end');
      expect(endMsg).toBeDefined();
      const headers = (endMsg?.extras as { ai?: { transport?: Record<string, string> } } | undefined)?.ai?.transport;
      expect(headers?.['run-reason']).toBe('cancelled');
    });

    it('a developer run.end() after a cancelled pipe is a no-op (no second run-end)', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      simulateCancel(channel, { [HEADER_RUN_ID]: 'run-1' });
      await new Promise((r) => setTimeout(r, 5));

      const paused = new ReadableStream<TestOutput>({
        start: () => {
          /* never enqueues or closes */
        },
      });
      await run.pipe(paused);
      await run.end({ reason: 'cancelled' });

      const endMsgs = channel.publishCalls.filter((m) => m.name === 'ai-run-end');
      expect(endMsgs).toHaveLength(1);
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
      await s.close();
    });

    it('defaults assistant parent to the most recently looked-up input event', async () => {
      // Stand up a session whose input-event lookup will resolve via the channel
      // dispatcher — this populates `run.view.getMessages()` with the input event
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
      await s.close();
    });

    it('omits parent header when the run has no resolved input and no pipe parent is supplied', async () => {
      // Per-message metadata is resolved from the input-event lookup result. With
      // no event-id (and thus no lookup), `run.view.getMessages()` stays empty
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

    // -----------------------------------------------------------------------
    // implicit step bracket (lazy at first output)
    // -----------------------------------------------------------------------

    describe('implicit step bracket', () => {
      it('brackets a producing pipe with ai-step-start -> ai-step-end(complete) and stamps step-id/start-serial on output', async () => {
        const run = createRunFromOpts(session, { runId: 'run-1' });
        await run.start();
        await run.pipe(streamOf({ type: 'text', text: 'hi' }));

        const starts = stepHeadersOf(channel, 'ai-step-start');
        const ends = stepHeadersOf(channel, 'ai-step-end');
        expect(starts).toHaveLength(1);
        expect(ends).toHaveLength(1);
        expect(starts[0]?.[HEADER_RUN_ID]).toBe('run-1');
        // The implicit step uses the same monotonic default id Run.createStep mints,
        // scoped to the invocation (createRunFromOpts pins it to `run-1-inv`).
        expect(starts[0]?.['step-id']).toBe('run-1-inv-step-0');
        // A step-start carries no back-ref — its own serial is the identity.
        expect(starts[0]?.['start-serial']).toBeUndefined();
        expect(ends[0]?.['step-reason']).toBe('complete');
        // The step-end carries the same step-id and back-references the
        // step-start's serial (the mock channel ACKs every publish as serial-1).
        expect(ends[0]?.['step-id']).toBe(starts[0]?.['step-id']);
        expect(ends[0]?.['start-serial']).toBe('serial-1');

        // The piped output's default headers carry the step-id; the per-message
        // start-serial is stamped by the writer's composed onMessage hook.
        const headers = codec.lastEncoderOpts()?.extras?.headers ?? {};
        expect(headers['step-id']).toBe(starts[0]?.['step-id']);
        expect(headers['start-serial']).toBeUndefined();
        // The composed hook stamps start-serial on every output message.
        expect(codec.lastEncoder()?.outputTransport[0]?.['start-serial']).toBe('serial-1');
      });

      it('does not throw when the implicit step-end publish fails (best-effort close)', async () => {
        // A fire-and-forget run.pipe whose connection dies mid-stream must not
        // escape an unhandled rejection from the best-effort step-close. Spy the
        // run manager so the step-end publish (endStep) rejects like a closed
        // connection; the run-level terminal is the authority for completion.
        const orig = runManagerModule.createRunManager;
        const createSpy = vi
          .spyOn(runManagerModule, 'createRunManager')
          .mockImplementation((ch, logger): RunManager => {
            const manager = orig(ch, logger);
            manager.endStep = vi.fn().mockRejectedValue(new Error('connection closed'));
            return manager;
          });
        const failChannel = createMockChannel();
        const failSession = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
          client: createMockClient(failChannel),
          channelName: 'test-channel',
          codec,
        });
        await failSession.connect();
        const run = createRunFromOpts(failSession, { runId: 'run-1' });
        await run.start();
        await expect(run.pipe(streamOf({ type: 'text', text: 'hi' }))).resolves.toMatchObject({
          reason: 'complete',
        });
        await failSession.close();
        createSpy.mockRestore();
      });

      it('opens the step LAZILY at first output: step-start is published before the first output is encoded', async () => {
        const run = createRunFromOpts(session, { runId: 'run-1' });
        await run.start();
        await run.pipe(streamOf({ type: 'text', text: 'hi' }));

        // The implicit step-start (a channel.publish of `ai-step-start`) must
        // precede the first encoder.publishOutput call — proving the step opens
        // from the before-first-write hook, not eagerly at pipe() entry.
        // Compare vitest's global invocation order across the two spies.
        const publishMock = vi.mocked(channel.publish);
        const stepStartCallIdx = publishMock.mock.calls.findIndex(([msg]) => {
          const m = msg as Ably.Message;
          return m.name === 'ai-step-start';
        });
        expect(stepStartCallIdx).toBeGreaterThanOrEqual(0);
        const stepStartOrder = publishMock.mock.invocationCallOrder[stepStartCallIdx];

        const enc = codec.lastEncoder();
        // eslint-disable-next-line @typescript-eslint/unbound-method -- reading the vi.fn mock, not invoking
        const firstOutputOrder = vi.mocked(enc?.publishOutput ?? vi.fn()).mock.invocationCallOrder[0];

        expect(stepStartOrder).toBeDefined();
        expect(firstOutputOrder).toBeDefined();
        // Non-null asserted via the toBeDefined guards above.
        expect(stepStartOrder ?? 0).toBeLessThan(firstOutputOrder ?? 0);
      });

      it('brackets ZERO steps for a pipe that produces no output (empty stream)', async () => {
        const run = createRunFromOpts(session, { runId: 'run-1' });
        await run.start();
        const result = await run.pipe(streamOf());

        expect(result.reason).toBe('complete');
        expect(stepHeadersOf(channel, 'ai-step-start')).toHaveLength(0);
        expect(stepHeadersOf(channel, 'ai-step-end')).toHaveLength(0);
      });

      it('brackets ZERO steps when the stream errors BEFORE any output (no empty bracket)', async () => {
        const run = createRunFromOpts(session, { runId: 'run-1' });
        await run.start();
        // Errors on the first read, before enqueuing anything — the
        // before-first-write hook never fires, so no step opens.
        const failBeforeOutput = new ReadableStream<TestOutput>({
          start: (controller) => {
            controller.error(new Error('upstream failed before any chunk'));
          },
        });
        const result = await run.pipe(failBeforeOutput);

        expect(result.reason).toBe('error');
        expect(stepHeadersOf(channel, 'ai-step-start')).toHaveLength(0);
        expect(stepHeadersOf(channel, 'ai-step-end')).toHaveLength(0);
      });

      it('brackets a step that closes failed when the stream errors AFTER producing output', async () => {
        const run = createRunFromOpts(session, { runId: 'run-1' });
        await run.start();
        // Deliver one chunk on the first pull, then error on the next pull — so
        // a chunk genuinely reaches the encoder (the step opens) before the
        // error. (Enqueue-then-error in one tick lets the error pre-empt the
        // chunk, which is the separate "errors before output" case.)
        let pulls = 0;
        const errorAfterOutput = new ReadableStream<TestOutput>({
          pull: (controller) => {
            pulls++;
            if (pulls === 1) {
              controller.enqueue({ type: 'text', text: 'partial' });
            } else {
              controller.error(new Error('rate limit after first chunk'));
            }
          },
        });
        const result = await run.pipe(errorAfterOutput);

        expect(result.reason).toBe('error');
        const starts = stepHeadersOf(channel, 'ai-step-start');
        const ends = stepHeadersOf(channel, 'ai-step-end');
        expect(starts).toHaveLength(1);
        expect(ends).toHaveLength(1);
        expect(ends[0]?.['step-reason']).toBe('failed');
      });

      it('brackets ZERO steps when cancelled BEFORE any output (cancel safety-net still ends the run)', async () => {
        const run = createRunFromOpts(session, { runId: 'run-1' });
        await run.start();
        simulateCancel(channel, { [HEADER_RUN_ID]: 'run-1' });
        await new Promise((r) => setTimeout(r, 5));

        const paused = new ReadableStream<TestOutput>({
          start: () => {
            /* never enqueues or closes */
          },
        });
        const result = await run.pipe(paused);

        expect(result.reason).toBe('cancelled');
        // No output ever flowed, so no step opened — but the run still ends,
        // exactly once.
        expect(stepHeadersOf(channel, 'ai-step-start')).toHaveLength(0);
        expect(stepHeadersOf(channel, 'ai-step-end')).toHaveLength(0);
        expect(channel.publishCalls.filter((m) => m.name === 'ai-run-end')).toHaveLength(1);
      });

      it('closes the implicit step cancelled (step-end before run-end) when cancelled mid-output', async () => {
        const run = createRunFromOpts(session, { runId: 'run-1' });
        await run.start();

        // Pull #1 enqueues a chunk so the implicit step OPENS (the
        // before-first-write hook fires); pull #2 fires the cancel while the
        // next read is pending, so pipeStream returns 'cancelled' with the step
        // already open. (Mirrors the "errors AFTER output" pull pattern.)
        let pulls = 0;
        const cancelAfterOutput = new ReadableStream<TestOutput>({
          pull: async (controller) => {
            pulls++;
            if (pulls === 1) {
              controller.enqueue({ type: 'text', text: 'partial' });
              return;
            }
            simulateCancel(channel, { [HEADER_RUN_ID]: 'run-1' });
            // Never enqueue/close: the abort wins the read race.
            await new Promise<void>(() => {
              /* pending forever */
            });
          },
        });
        const result = await run.pipe(cancelAfterOutput);

        expect(result.reason).toBe('cancelled');
        const starts = stepHeadersOf(channel, 'ai-step-start');
        const ends = stepHeadersOf(channel, 'ai-step-end');
        expect(starts).toHaveLength(1);
        expect(ends).toHaveLength(1);
        // The open step closes 'cancelled' (a run-level terminal), not
        // 'complete'/'failed'.
        expect(ends[0]?.['step-reason']).toBe('cancelled');
        // Exactly one run terminal (no double-publish from the safety-net).
        const runEnds = channel.publishCalls.filter((m) => m.name === 'ai-run-end');
        expect(runEnds).toHaveLength(1);
        const runEndHeaders = (runEnds[0]?.extras as { ai?: { transport?: Record<string, string> } } | undefined)?.ai
          ?.transport;
        expect(runEndHeaders?.['run-reason']).toBe('cancelled');
        // Wire ORDER: ai-step-end{cancelled} precedes ai-run-end{cancelled}.
        expect(stepEndBeforeRunEnd(channel)).toBe(true);
      });

      it('two pipe calls open TWO independent steps (distinct monotonic step-ids) — no supersede', async () => {
        const run = createRunFromOpts(session, { runId: 'run-1' });
        await run.start();
        await run.pipe(streamOf({ type: 'text', text: 'a' }));
        await run.pipe(streamOf({ type: 'text', text: 'b' }));

        const starts = stepHeadersOf(channel, 'ai-step-start');
        const ends = stepHeadersOf(channel, 'ai-step-end');
        expect(starts).toHaveLength(2);
        expect(ends).toHaveLength(2);
        // Distinct, monotonic step-ids: the second pipe is a fresh step, not a
        // retry of the first (supersession keys by step-id), so it never
        // supersedes it. Each step-start's own serial is its attempt identity.
        expect(starts.map((h) => h['step-id'])).toEqual(['run-1-inv-step-0', 'run-1-inv-step-1']);
      });

      it('continues the same monotonic step index across a pipe and a following step', async () => {
        // The implicit pipe step and an explicit step share one per-run index,
        // so a pipe then a step do not collide on the default id.
        const run = createRunFromOpts(session, { runId: 'run-1' });
        await run.start();
        await run.pipe(streamOf({ type: 'text', text: 'a' }));
        const step = run.createStep();
        await step.start();
        await step.pipe(streamOf({ type: 'text', text: 'b' }));
        await step.end();

        const starts = stepHeadersOf(channel, 'ai-step-start');
        expect(starts.map((h) => h['step-id'])).toEqual(['run-1-inv-step-0', 'run-1-inv-step-1']);
      });
    });
  });

  // -------------------------------------------------------------------------
  // createStep
  // -------------------------------------------------------------------------

  describe('createStep', () => {
    it('brackets start()/pipe()/end() with ai-step-start and ai-step-end(complete)', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();

      const step = run.createStep();
      await step.start();
      await step.pipe(streamOf({ type: 'text', text: 'hi' }));
      await step.end();

      const starts = stepHeadersOf(channel, 'ai-step-start');
      const ends = stepHeadersOf(channel, 'ai-step-end');
      expect(starts).toHaveLength(1);
      expect(ends).toHaveLength(1);
      expect(starts[0]?.[HEADER_RUN_ID]).toBe('run-1');
      // Default id is scoped to the invocation (createRunFromOpts pins it to
      // `run-1-inv`), so continuations of the same run never collide.
      expect(starts[0]?.['step-id']).toBe('run-1-inv-step-0');
      // A step-start carries no back-ref — its own serial is the identity.
      expect(starts[0]?.['start-serial']).toBeUndefined();
      expect(ends[0]?.['step-reason']).toBe('complete');
      // The step-end carries the same step-id and back-references the
      // step-start's serial (the mock channel ACKs every publish as serial-1).
      expect(ends[0]?.['step-id']).toBe(starts[0]?.['step-id']);
      expect(ends[0]?.['start-serial']).toBe('serial-1');
    });

    it('resolves stepId synchronously at createStep, before start() publishes', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();

      // createStep does no I/O: the id is available immediately, and nothing
      // is published until start().
      const step = run.createStep();
      expect(step.stepId).toBe('run-1-inv-step-0');
      expect(stepHeadersOf(channel, 'ai-step-start')).toHaveLength(0);

      await step.start();
      expect(stepHeadersOf(channel, 'ai-step-start')).toHaveLength(1);
      await step.end();
    });

    it('stamps step-id (default header) and start-serial (composed hook) on output piped within the step', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();

      const step = run.createStep();
      const seenStepId = step.stepId;
      await step.start();
      await step.pipe(streamOf({ type: 'text', text: 'hi' }));
      await step.end();

      const headers = codec.lastEncoderOpts()?.extras?.headers ?? {};
      expect(headers['step-id']).toBe(seenStepId);
      // start-serial is not a default header; the writer's composed onMessage
      // stamps it per output (the mock ACKs the step-start publish as serial-1).
      expect(headers['start-serial']).toBeUndefined();
      expect(headers[HEADER_ROLE]).toBe('assistant');
      expect(codec.lastEncoder()?.outputTransport[0]?.['start-serial']).toBe('serial-1');
    });

    it('ends the step failed (with no explicit reason) when a piped stream errors', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();

      // end() with no reason derives `failed` from the errored pipe — mirroring
      // the vercelRunOutcome flow that needs no try/catch.
      const step = run.createStep();
      await step.start();
      const r = await step.pipe(erroringStream());
      await step.end();

      expect(r.reason).toBe('error');
      const ends = stepHeadersOf(channel, 'ai-step-end');
      expect(ends[0]?.['step-reason']).toBe('failed');
    });

    it('ends the step failed when end({ reason: failed }) is passed explicitly', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();

      // The caller's own try/catch path: on a thrown error it closes the step
      // failed and drives the run terminal itself (the handle has no closure to
      // auto-bracket the throw).
      const step = run.createStep();
      await step.start();
      await step.end({ reason: 'failed' });

      const ends = stepHeadersOf(channel, 'ai-step-end');
      expect(ends).toHaveLength(1);
      expect(ends[0]?.['step-reason']).toBe('failed');
    });

    it('closes the step cancelled via the safety-net; a later step.end() cannot override it', async () => {
      // A cancelled step.pipe is a run-level terminal: the cancel safety-net
      // closes the step 'cancelled' and ends the run (step-end before run-end).
      // 'cancelled' wins: a later explicit step.end({ reason: 'failed' }) is
      // idempotent and neither double-publishes nor re-labels the step.
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();

      simulateCancel(channel, { [HEADER_RUN_ID]: 'run-1' });
      await new Promise((r) => setTimeout(r, 5));

      const paused = new ReadableStream<TestOutput>({
        start: () => {
          /* never enqueues or closes */
        },
      });
      const step = run.createStep();
      await step.start();
      const result = await step.pipe(paused); // returns 'cancelled'
      expect(result.reason).toBe('cancelled');
      await step.end({ reason: 'failed' }); // no-op: the step already closed 'cancelled'

      const ends = stepHeadersOf(channel, 'ai-step-end');
      expect(ends).toHaveLength(1);
      expect(ends[0]?.['step-reason']).toBe('cancelled');
      const runEnds = channel.publishCalls.filter((m) => m.name === 'ai-run-end');
      expect(runEnds).toHaveLength(1);
      const runEndHeaders = (runEnds[0]?.extras as { ai?: { transport?: Record<string, string> } } | undefined)?.ai
        ?.transport;
      expect(runEndHeaders?.['run-reason']).toBe('cancelled');
      expect(stepEndBeforeRunEnd(channel)).toBe(true);
    });

    it('reuses the previous step id on a no-id retry after a failure (coalescing)', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();

      const first = run.createStep();
      await first.start();
      await first.end({ reason: 'failed' });

      const second = run.createStep();
      await second.start();
      await second.pipe(streamOf({ type: 'text', text: 'ok' }));
      await second.end();

      const starts = stepHeadersOf(channel, 'ai-step-start');
      expect(starts).toHaveLength(2);
      // Same step-id (coalesced retry); each step-start's own serial is its
      // distinct attempt identity (the latest-serial start is canonical).
      expect(starts[0]?.['step-id']).toBe('run-1-inv-step-0');
      expect(starts[1]?.['step-id']).toBe('run-1-inv-step-0');
    });

    it('advances the step index across sequential successful steps', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();

      const a = run.createStep();
      await a.start();
      await a.pipe(streamOf({ type: 'text', text: 'a' }));
      await a.end();
      const b = run.createStep();
      await b.start();
      await b.pipe(streamOf({ type: 'text', text: 'b' }));
      await b.end();

      const starts = stepHeadersOf(channel, 'ai-step-start');
      expect(starts.map((h) => h['step-id'])).toEqual(['run-1-inv-step-0', 'run-1-inv-step-1']);
    });

    it('scopes the default step id to the invocation so continuations do not collide', async () => {
      // Two invocations of the SAME run (the original turn + a suspend/resume
      // continuation) are distinct Run objects with distinct invocation ids.
      // Their default step ids must differ, or the continuation's step would
      // supersede the original's output (e.g. the tool-call bubble).
      const original = createRunFromOpts(session, { runId: 'run-1', invocationId: 'inv-A' });
      await original.start();
      const originalStep = original.createStep();
      await originalStep.start();
      await originalStep.pipe(streamOf({ type: 'text', text: 'a' }));
      await originalStep.end();

      const continuation = createRunFromOpts(session, { runId: 'run-1', invocationId: 'inv-B' });
      await continuation.start();
      const continuationStep = continuation.createStep();
      await continuationStep.start();
      await continuationStep.pipe(streamOf({ type: 'text', text: 'b' }));
      await continuationStep.end();

      const ids = stepHeadersOf(channel, 'ai-step-start').map((h) => h['step-id']);
      expect(ids).toEqual(['inv-A-step-0', 'inv-B-step-0']);
      expect(ids[0]).not.toBe(ids[1]);
    });

    it('honours an explicit stepId', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();

      const step = run.createStep({ stepId: 'answer' });
      await step.start();
      await step.pipe(streamOf({ type: 'text', text: 'a' }));
      await step.end();

      const starts = stepHeadersOf(channel, 'ai-step-start');
      expect(starts[0]?.['step-id']).toBe('answer');
    });

    it('start() throws when the run has not been started', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      // createStep is synchronous and never throws; the publish guard is on start().
      const step = run.createStep();
      await expect(step.start()).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });

    it('start() throws when the run has ended', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      await run.end({ reason: 'complete' });
      const step = run.createStep();
      await expect(step.start()).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });

    it('pipe() throws before start() and after end()', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();

      const step = run.createStep();
      await expect(step.pipe(streamOf({ type: 'text', text: 'x' }))).rejects.toBeErrorInfoWithCode(
        ErrorCode.InvalidArgument,
      );

      await step.start();
      await step.end();
      await expect(step.pipe(streamOf({ type: 'text', text: 'x' }))).rejects.toBeErrorInfoWithCode(
        ErrorCode.InvalidArgument,
      );
    });

    it('start() rejects a second step while one is already active', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();

      const first = run.createStep();
      await first.start();

      // Only one step may be open at a time.
      const second = run.createStep();
      await expect(second.start()).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);

      // The first step is unaffected and still closes cleanly.
      await first.end();
      expect(stepHeadersOf(channel, 'ai-step-end')).toHaveLength(1);
    });

    it('run.pipe rejects while an explicit step is active', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();

      const step = run.createStep();
      await step.start();
      // An explicit step is open; run.pipe must not open a concurrent implicit
      // step on the same run (the one-active-step latch covers run.pipe too).
      await expect(run.pipe(streamOf({ type: 'text', text: 'x' }))).rejects.toBeErrorInfoWithCode(
        ErrorCode.InvalidArgument,
      );

      await step.end();
    });

    it('run.pipe rejects a second concurrent run.pipe before its implicit step opens', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();

      // Fire the first pipe WITHOUT awaiting: it latches `opening` synchronously
      // at entry, before its implicit step opens lazily at first output. A second
      // pipe started in that window must be rejected rather than open a second
      // concurrent implicit step (the regression this guards: pipe used to set
      // the latch only lazily, so two un-awaited pipes each opened a step).
      const first = run.pipe(streamOf({ type: 'text', text: 'a' }));
      await expect(run.pipe(streamOf({ type: 'text', text: 'b' }))).rejects.toBeErrorInfoWithCode(
        ErrorCode.InvalidArgument,
      );
      await first;

      // Exactly one implicit step bracketed the surviving pipe.
      expect(stepHeadersOf(channel, 'ai-step-start')).toHaveLength(1);
      expect(stepHeadersOf(channel, 'ai-step-end')).toHaveLength(1);
    });

    it('start() rejects a second overlapping start() before the first latches (opening race)', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();

      // Fire two start()s without awaiting the first: the first sets `opening`
      // synchronously before its publish, so the second is rejected before
      // `activeStep` latches — exercising the opening-flag arm of the guard (the
      // already-awaited case above only exercises the activeStep arm).
      const first = run.createStep();
      const second = run.createStep();
      const p1 = first.start();
      await expect(second.start()).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
      await p1;

      // Exactly one ai-step-start was published despite the overlap.
      expect(stepHeadersOf(channel, 'ai-step-start')).toHaveLength(1);
      await first.end();
    });

    it('end() is idempotent', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();

      const step = run.createStep();
      await step.start();
      await step.end();
      await step.end();

      expect(stepHeadersOf(channel, 'ai-step-end')).toHaveLength(1);
    });

    it('exposes the run abort signal as step.abortSignal', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      const step = run.createStep();
      const seen = step.abortSignal;
      await step.start();
      await step.pipe(streamOf({ type: 'text', text: 'a' }));
      await step.end();
      expect(seen).toBe(run.abortSignal);
    });

    it('run.end() auto-closes a still-open step ahead of the run terminal', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();

      // A forgotten step.end() must not strand observers: run.end closes the
      // open step (complete, since the run did not error) before ai-run-end.
      const step = run.createStep();
      await step.start();
      await run.end({ reason: 'complete' });

      const ends = stepHeadersOf(channel, 'ai-step-end');
      expect(ends).toHaveLength(1);
      expect(ends[0]?.['step-reason']).toBe('complete');
      // The handle's own end() afterwards is a no-op.
      await step.end();
      expect(stepHeadersOf(channel, 'ai-step-end')).toHaveLength(1);
    });

    it('run.suspend() rejects while a step is active', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();

      const step = run.createStep();
      await step.start();
      // A suspend mid-step would strand the open step; the caller must end it.
      await expect(run.suspend()).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);

      await step.end();
      await run.suspend();
      expect(channel.publishCalls.some((m) => m.name === 'ai-run-suspend')).toBe(true);
    });

    it('closes the step cancelled and ends the run cancelled when a step pipe is cancelled', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();

      // Cancel the run, then pipe a never-completing stream inside the step:
      // pipeStream observes the abort and returns reason:'cancelled', which the
      // shared doPipe turns into a run-end terminal whose auto-close settles the
      // open step cancelled ahead of the run-end.
      simulateCancel(channel, { [HEADER_RUN_ID]: 'run-1' });
      await new Promise((r) => setTimeout(r, 5));

      const paused = new ReadableStream<TestOutput>({
        start: () => {
          /* never enqueues or closes */
        },
      });
      const step = run.createStep();
      await step.start();
      const result = await step.pipe(paused);
      await step.end();

      expect(result.reason).toBe('cancelled');
      const ends = stepHeadersOf(channel, 'ai-step-end');
      // A cancel ends the run while the step was open: the step closes
      // 'cancelled' (neither completed its output nor failed retryably) and the
      // run-end carries the cancellation.
      expect(ends[0]?.['step-reason']).toBe('cancelled');
      // Exactly one run terminal (the safety-net does not double-publish).
      const runEnds = channel.publishCalls.filter((m) => m.name === 'ai-run-end');
      expect(runEnds).toHaveLength(1);
      const runEndHeaders = (runEnds[0]?.extras as { ai?: { transport?: Record<string, string> } } | undefined)?.ai
        ?.transport;
      expect(runEndHeaders?.['run-reason']).toBe('cancelled');

      // Wire ORDER: ai-step-end{cancelled} must precede ai-run-end{cancelled}
      // (the step-end-before-terminal invariant). Compare the two publishes'
      // global invocation order.
      expect(stepEndBeforeRunEnd(channel)).toBe(true);
    });

    it('coalesces a cross-process retry that supplies the same explicit stepId', async () => {
      // A durable-execution retry is a fresh Run (new invocation id, no
      // in-memory step history) that re-attempts the same logical step by
      // passing its stable id. Both attempts then carry the same step-id, so
      // the later attempt's output supersedes the earlier one's.
      const original = createRunFromOpts(session, { runId: 'run-1', invocationId: 'inv-A' });
      await original.start();
      const originalStep = original.createStep({ stepId: 'turn-1' });
      await originalStep.start();
      await originalStep.pipe(streamOf({ type: 'text', text: 'a' }));
      await originalStep.end();

      const retry = createRunFromOpts(session, { runId: 'run-1', invocationId: 'inv-B' });
      await retry.start();
      const retryStep = retry.createStep({ stepId: 'turn-1' });
      await retryStep.start();
      await retryStep.pipe(streamOf({ type: 'text', text: 'b' }));
      await retryStep.end();

      const starts = stepHeadersOf(channel, 'ai-step-start');
      expect(starts.map((h) => h['step-id'])).toEqual(['turn-1', 'turn-1']);
      // Each attempt is identified by its own step-start serial; the
      // latest-serial start is the canonical attempt and its output wins.
      // (Neither step-start carries a `start-serial` back-ref of its own.)
      expect(starts.every((h) => h['start-serial'] === undefined)).toBe(true);
    });

    describe('step client-id scopes', () => {
      it('stamps invocation-id + run-client-id + input-client-id + step-client-id on ai-step-start AND ai-step-end', async () => {
        // The run owner is 'owner' (run-client-id on the input), the triggering
        // input's publisher is 'user-b' (input-client-id). With no steer the
        // first step's client defaults to the publisher.
        const run = createRunFromOpts(session, {
          runId: 'run-scopes',
          invocationId: 'inv-scopes',
          inputEventId: 'p-scopes',
        });
        const startPromise = run.start();
        deliverInputEvent(channel, {
          invocationId: 'inv-scopes',
          runId: 'run-scopes',
          codecMessageId: 'm-scopes',
          serial: 's-scopes',
          inputEventId: 'p-scopes',
          runClientId: 'owner',
          publisherClientId: 'user-b',
        });
        await startPromise;

        const s1 = run.createStep({ stepId: 'S1' });
        await s1.start();
        await s1.pipe(streamOf({ type: 'text', text: 'a' }));
        await s1.end();

        const starts = stepHeadersOf(channel, 'ai-step-start');
        const ends = stepHeadersOf(channel, 'ai-step-end');
        expect(starts).toHaveLength(1);
        expect(ends).toHaveLength(1);
        for (const h of [starts[0], ends[0]]) {
          expect(h?.[HEADER_INVOCATION_ID]).toBe('inv-scopes');
          expect(h?.[HEADER_RUN_CLIENT_ID]).toBe('owner');
          // invocationClientId rides input-client-id (the publisher lineage).
          expect(h?.[HEADER_INPUT_CLIENT_ID]).toBe('user-b');
          // First step, no steer -> step client defaults to the input publisher.
          expect(h?.[HEADER_STEP_CLIENT_ID]).toBe('user-b');
        }
      });

      it('stamps step-client-id (and still run-client-id / input-client-id) on every output of the step', async () => {
        const run = createRunFromOpts(session, {
          runId: 'run-out',
          invocationId: 'inv-out',
          inputEventId: 'p-out',
        });
        const startPromise = run.start();
        deliverInputEvent(channel, {
          invocationId: 'inv-out',
          runId: 'run-out',
          codecMessageId: 'm-out',
          serial: 's-out',
          inputEventId: 'p-out',
          runClientId: 'owner',
          publisherClientId: 'user-b',
        });
        await startPromise;

        const s1 = run.createStep({ stepId: 'S1' });
        await s1.start();
        await s1.pipe(streamOf({ type: 'text', text: 'a' }));
        await s1.end();

        const headers = codec.lastEncoderOpts()?.extras?.headers ?? {};
        expect(headers[HEADER_STEP_CLIENT_ID]).toBe('user-b');
        expect(headers[HEADER_RUN_CLIENT_ID]).toBe('owner');
        expect(headers[HEADER_INPUT_CLIENT_ID]).toBe('user-b');
      });

      it('an implicit run.pipe step also stamps step-client-id on its output and bracket', async () => {
        const run = createRunFromOpts(session, {
          runId: 'run-pipe-sc',
          invocationId: 'inv-pipe-sc',
          inputEventId: 'p-pipe-sc',
        });
        const startPromise = run.start();
        deliverInputEvent(channel, {
          invocationId: 'inv-pipe-sc',
          runId: 'run-pipe-sc',
          codecMessageId: 'm-pipe-sc',
          serial: 's-pipe-sc',
          inputEventId: 'p-pipe-sc',
          runClientId: 'owner',
          publisherClientId: 'user-b',
        });
        await startPromise;

        await run.pipe(streamOf({ type: 'text', text: 'hi' }));

        const starts = stepHeadersOf(channel, 'ai-step-start');
        expect(starts[0]?.[HEADER_STEP_CLIENT_ID]).toBe('user-b');
        const headers = codec.lastEncoderOpts()?.extras?.headers ?? {};
        expect(headers[HEADER_STEP_CLIENT_ID]).toBe('user-b');
      });

      it('defaults the first step client to the input PUBLISHER, which differs from the run owner on a non-owner continuation', async () => {
        // A non-owner continuation: the run is owned by 'owner' (run-client-id),
        // but the triggering input was published by a DIFFERENT client
        // ('user-b'). The step client is the publisher lineage, NOT the owner —
        // the two diverge here even though they coincide on a fresh owner turn.
        const run = createRunFromOpts(session, {
          runId: 'run-nonowner',
          invocationId: 'inv-nonowner',
          inputEventId: 'p-nonowner',
        });
        const startPromise = run.start();
        deliverInputEvent(channel, {
          invocationId: 'inv-nonowner',
          runId: 'run-nonowner',
          codecMessageId: 'm-nonowner',
          serial: 's-nonowner',
          inputEventId: 'p-nonowner',
          runClientId: 'owner',
          publisherClientId: 'user-b',
        });
        await startPromise;

        const s1 = run.createStep({ stepId: 'S1' });
        await s1.start();
        await s1.pipe(streamOf({ type: 'text', text: 'a' }));
        await s1.end();

        const starts = stepHeadersOf(channel, 'ai-step-start');
        // invocationClientId (input-client-id) is the resuming publisher; the
        // step client defaults to it; run-client-id stays the run owner. The
        // documented publisher-vs-issuer reconciliation: the SDK stamps the
        // triggering input's PUBLISHER as input-client-id.
        expect(starts[0]?.[HEADER_INPUT_CLIENT_ID]).toBe('user-b');
        expect(starts[0]?.[HEADER_STEP_CLIENT_ID]).toBe('user-b');
        expect(starts[0]?.[HEADER_RUN_CLIENT_ID]).toBe('owner');
        expect(starts[0]?.[HEADER_STEP_CLIENT_ID]).not.toBe(starts[0]?.[HEADER_RUN_CLIENT_ID]);
      });

      it('is sticky across steps of a single-input turn (every step inherits the first step client)', async () => {
        const run = createRunFromOpts(session, {
          runId: 'run-sticky',
          invocationId: 'inv-sticky',
          inputEventId: 'p-sticky',
        });
        const startPromise = run.start();
        deliverInputEvent(channel, {
          invocationId: 'inv-sticky',
          runId: 'run-sticky',
          codecMessageId: 'm-sticky',
          serial: 's-sticky',
          inputEventId: 'p-sticky',
          runClientId: 'owner',
          publisherClientId: 'user-b',
        });
        await startPromise;

        const s1 = run.createStep({ stepId: 'S1' });
        await s1.start();
        await s1.pipe(streamOf({ type: 'text', text: 'a' }));
        await s1.end();
        const s2 = run.createStep({ stepId: 'S2' });
        await s2.start();
        await s2.pipe(streamOf({ type: 'text', text: 'b' }));
        await s2.end();

        const starts = stepHeadersOf(channel, 'ai-step-start');
        expect(starts).toHaveLength(2);
        // Both steps carry the SAME client (sticky): the second inherits the
        // first via the in-process cursor, not a re-default.
        expect(starts[0]?.[HEADER_STEP_CLIENT_ID]).toBe('user-b');
        expect(starts[1]?.[HEADER_STEP_CLIENT_ID]).toBe('user-b');
      });

      it('an explicit StepOptions.stepClientId wins over the default and the sticky inheritance (the steer seam)', async () => {
        const run = createRunFromOpts(session, {
          runId: 'run-explicit',
          invocationId: 'inv-explicit',
          inputEventId: 'p-explicit',
        });
        const startPromise = run.start();
        deliverInputEvent(channel, {
          invocationId: 'inv-explicit',
          runId: 'run-explicit',
          codecMessageId: 'm-explicit',
          serial: 's-explicit',
          inputEventId: 'p-explicit',
          runClientId: 'owner',
          publisherClientId: 'user-b',
        });
        await startPromise;

        // First step: default (publisher). Second step: a steer incorporates a
        // fresh input from 'user-c', supplied explicitly — it overrides the
        // sticky 'user-b' AND becomes the new sticky value.
        const s1 = run.createStep({ stepId: 'S1' });
        await s1.start();
        await s1.pipe(streamOf({ type: 'text', text: 'a' }));
        await s1.end();
        const s2 = run.createStep({ stepId: 'S2', stepClientId: 'user-c' });
        await s2.start();
        await s2.pipe(streamOf({ type: 'text', text: 'b' }));
        await s2.end();
        const s3 = run.createStep({ stepId: 'S3' });
        await s3.start();
        await s3.pipe(streamOf({ type: 'text', text: 'c' }));
        await s3.end();

        const starts = stepHeadersOf(channel, 'ai-step-start');
        expect(starts[0]?.[HEADER_STEP_CLIENT_ID]).toBe('user-b');
        expect(starts[1]?.[HEADER_STEP_CLIENT_ID]).toBe('user-c');
        // The explicit value is now sticky: the third step inherits 'user-c'.
        expect(starts[2]?.[HEADER_STEP_CLIENT_ID]).toBe('user-c');
      });
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
      await s.close();
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
      await s.close();
    });

    it('still lands a balanced ai-run-end after start + pipe (no orphaned run)', async () => {
      // A cancel buffered before run-start aborts the controller during the
      // lookup, but start() still publishes ai-run-start (run-start is
      // unconditional once the linkage resolves). The run is therefore visible
      // to observers and MUST be terminated: when the agent goes on to pipe its
      // response, the already-aborted signal makes the pipe return 'cancelled'
      // and Run.pipe guarantees the ai-run-end terminal — so the buffered-cancel
      // path leaves no run stuck active. (PR 5c run-end guarantee reaching the
      // deferred-cancel path.)
      const { session: s, ch } = lookupSession();
      await s.connect();

      const inputEventId = 'p-early-end';
      const inputCodecMessageId = 'm-early-end';
      const run = createRunFromOpts(s, { runId: 'run-early-end', invocationId: 'inv-early-end', inputEventId });

      // The cancel has no run-id and the input→run linkage isn't indexed until
      // start() resolves the lookup, so it takes the buffer path — which runs
      // synchronously (no await before `_bufferDeferredCancel`). The cancel is
      // therefore buffered by the time simulateCancel returns; no wait needed.
      simulateCancel(ch, { [HEADER_INPUT_CODEC_MESSAGE_ID]: inputCodecMessageId });

      const startPromise = run.start();
      deliverInputEvent(ch, {
        invocationId: 'inv-early-end',
        codecMessageId: inputCodecMessageId,
        serial: 's-early-end',
        inputEventId,
      });
      await startPromise;

      expect(run.abortSignal.aborted).toBe(true);
      // run-start WAS published (start() publishes it even though the pulled
      // cancel aborted the controller), so the run is observable.
      expect(ch.publishCalls.find((m) => m.name === 'ai-run-start')).toBeDefined();

      const paused = new ReadableStream<TestOutput>({
        start: () => {
          /* never enqueues or closes */
        },
      });
      const result = await run.pipe(paused);
      expect(result.reason).toBe('cancelled');

      // The run-start is balanced by a run-end(reason:cancelled) — no orphan.
      const endMsg = ch.publishCalls.find((m) => m.name === 'ai-run-end');
      expect(endMsg).toBeDefined();
      const headers = (endMsg?.extras as { ai?: { transport?: Record<string, string> } } | undefined)?.ai?.transport;
      expect(headers?.['run-reason']).toBe('cancelled');
      await s.close();
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
      await s.close();
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
      await s.close();
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
      await s.close();
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
      await s.close();
    });

    it('FIFO-evicts the oldest deferred cancel beyond the buffer limit', async () => {
      const ch = createMockChannel();
      const { logger, warn } = captureWarnLogger();
      const s = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'cancel-evict',
        codec: codecWithFunctionalDecoder(),
        logger,
      });
      await s.connect();

      // The deferred-cancel buffer is bounded at 200. Fill it, then push one
      // more — the oldest ('m-0') is FIFO-evicted with a warn.
      for (let i = 0; i <= 200; i++) {
        simulateCancel(ch, { [HEADER_INPUT_CODEC_MESSAGE_ID]: `m-${String(i)}` });
      }
      // Cancel handling is dispatched fire-and-forget; let the microtasks run.
      await new Promise((r) => setTimeout(r, 5));

      const evictWarns = warn.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('deferred-cancel buffer full'),
      );
      expect(evictWarns).toHaveLength(1);
      // CAST: warn-logger context is untyped; narrow to the fields under test.
      const ctx = evictWarns[0]?.[1] as { evictedInputCodecMessageId?: string; limit?: number } | undefined;
      expect(ctx?.evictedInputCodecMessageId).toBe('m-0');
      expect(ctx?.limit).toBe(200);

      // The evicted cancel ('m-0') no longer fires; the newest ('m-200') does.
      const evicted = createRunFromOpts(s, { runId: 'run-old', invocationId: 'inv-old', inputEventId: 'p-old' });
      const evictedStart = evicted.start();
      deliverInputEvent(ch, { invocationId: 'inv-old', codecMessageId: 'm-0', serial: 's-old', inputEventId: 'p-old' });
      await evictedStart;
      expect(evicted.abortSignal.aborted).toBe(false);

      const retained = createRunFromOpts(s, { runId: 'run-new', invocationId: 'inv-new', inputEventId: 'p-new' });
      const retainedStart = retained.start();
      deliverInputEvent(ch, {
        invocationId: 'inv-new',
        codecMessageId: 'm-200',
        serial: 's-new',
        inputEventId: 'p-new',
      });
      await retainedStart;
      expect(retained.abortSignal.aborted).toBe(true);

      await s.close();
    });

    it('clears deferred cancels on close so they are not honoured by a later run', async () => {
      const { session: s, ch } = lookupSession();
      await s.connect();

      simulateCancel(ch, { [HEADER_INPUT_CODEC_MESSAGE_ID]: 'm-stale' });
      await new Promise((r) => setTimeout(r, 5));
      await s.close();

      // A fresh session reusing the same input id sees no buffered cancel.
      const s2 = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'cancel-before-start',
        codec: codecWithFunctionalDecoder(),
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
      await s2.close();
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
      await run.end({ reason: 'complete' });

      simulateCancel(ch, { [HEADER_INPUT_CODEC_MESSAGE_ID]: inputCodecMessageId });
      await new Promise((r) => setTimeout(r, 5));

      // No throw, no abort attempt against a non-existent registration.
      expect(run.abortSignal.aborted).toBe(false);
      await s.close();
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
      });
      failSession.on('error', onError);
      await failSession.connect();
      const run = createRunFromOpts(failSession, { runId: 'run-1', onError });
      await expect(run.start()).rejects.toBeErrorInfoWithCode(ErrorCode.RunLifecycleError);
      expect(onError).not.toHaveBeenCalled();
      await failSession.close();
    });

    it('end() throws on run-end publish failure', async () => {
      const run = createRunFromOpts(session, { runId: 'run-1' });
      await run.start();
      vi.mocked(channel.publish).mockRejectedValueOnce(new Error('publish failed'));
      await expect(run.end({ reason: 'complete' })).rejects.toBeErrorInfoWithCode(ErrorCode.RunLifecycleError);
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

    it('onCancel throws with no run onError → falls back to the session on(error)', async () => {
      // A run-scoped error with no per-run `onError` must still surface — it
      // falls back to the session emitter rather than being silently dropped.
      const sessionOnError = vi.fn();
      session.on('error', sessionOnError);
      const run = createRunFromOpts(session, {
        runId: 'run-1',
        // eslint-disable-next-line @typescript-eslint/require-await -- mock
        onCancel: async () => {
          throw new Error('handler boom');
        },
      });
      await run.start();

      simulateCancel(channel, { [HEADER_RUN_ID]: 'run-1' });
      await new Promise((r) => setTimeout(r, 5));

      expect(sessionOnError).toHaveBeenCalledWith(expect.toBeErrorInfo({ code: ErrorCode.CancelListenerError }));
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
      await session.close();
      expect(run1.abortSignal.aborted).toBe(true);
      expect(run2.abortSignal.aborted).toBe(true);
    });

    it('unsubscribes from the channel', async () => {
      await session.close();
      expect(channel.unsubscribe).toHaveBeenCalled();
    });

    it('detaches the channel it attached', async () => {
      await session.close();
      expect(channel.detach).toHaveBeenCalledTimes(1);
    });

    it('does not close the injected client', async () => {
      const ch = createMockChannel();
      const client = createMockClient(ch);
      // Attach a spy so the assertion proves the SDK never calls client.close():
      // the client is injected and the caller owns its lifecycle.
      // CAST: the mock client is a plain object; add a close spy for the assertion.
      const close = vi.fn();
      (client as unknown as { close: () => void }).close = close;
      const s = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client,
        channelName: 'no-client-close',
        codec: createMockCodec(),
      });
      await s.connect();
      await s.close();
      expect(close).not.toHaveBeenCalled();
    });

    it('does not detach when connect() was never called', async () => {
      const ch = createMockChannel();
      const s = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'never-connected',
        codec: createMockCodec(),
      });
      await s.close();
      expect(ch.detach).not.toHaveBeenCalled();
    });

    it('swallows a detach failure and logs it at debug', async () => {
      const ch = createMockChannel();
      ch.detach.mockRejectedValueOnce(new Error('detach failed'));
      const debug = vi.fn();
      // Minimal logger spy; withContext returns the same instance so the
      // session's child-context logs reach this debug spy.
      const logger: import('../../../src/logger.js').Logger = {
        trace: vi.fn(),
        debug,
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        withContext: () => logger,
      };
      const s = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'detach-fail',
        codec: createMockCodec(),
        logger,
      });
      await s.connect();
      // Best-effort teardown: close() resolves despite the detach rejection...
      await expect(s.close()).resolves.toBeUndefined();
      // ...and the failure is logged at debug for observability.
      expect(debug).toHaveBeenCalledWith(expect.stringContaining('channel detach failed'), expect.anything());
    });

    it('is idempotent', async () => {
      await session.close();
      await session.close();
      expect(channel.unsubscribe).toHaveBeenCalledTimes(1);
      expect(channel.detach).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // channel continuity
  // -------------------------------------------------------------------------

  describe('channel continuity', () => {
    it.each([['failed' as const], ['suspended' as const], ['detached' as const]])(
      'emits onError with ChannelContinuityLost when channel enters %s',
      async (state) => {
        const onError = vi.fn();
        const ch = createMockChannel();
        ch.state = 'initialized';
        const s = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
          client: createMockClient(ch),
          channelName: 'test-channel',
          codec: createMockCodec(),
        });
        s.on('error', onError);
        simulateInitialAttach(ch);
        simulateStateChange(ch, {
          current: state,
          previous: 'attached',
        } as Ably.ChannelStateChange);

        expect(onError).toHaveBeenCalledWith(
          expect.toBeErrorInfo({ code: ErrorCode.ChannelContinuityLost, statusCode: 500 }),
        );
        await s.close();
      },
    );

    it('emits onError on UPDATE (attached → attached, resumed: false)', async () => {
      const onError = vi.fn();
      const ch = createMockChannel();
      ch.state = 'initialized';
      const s = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: createMockCodec(),
      });
      s.on('error', onError);
      simulateInitialAttach(ch);
      simulateStateChange(ch, {
        current: 'attached',
        previous: 'attached',
        resumed: false,
      });

      expect(onError).toHaveBeenCalledWith(
        expect.toBeErrorInfo({ code: ErrorCode.ChannelContinuityLost, statusCode: 500 }),
      );
      await s.close();
    });

    it('on(error) unsubscribe stops further delivery', async () => {
      const onError = vi.fn();
      const ch = createMockChannel();
      ch.state = 'initialized';
      const s = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: createMockCodec(),
      });
      const unsub = s.on('error', onError);
      simulateInitialAttach(ch);
      unsub();
      simulateStateChange(ch, { current: 'failed', previous: 'attached' } as Ably.ChannelStateChange);

      expect(onError).not.toHaveBeenCalled();
      await s.close();
    });

    it('on(error) is a no-op once the session is closed', async () => {
      const onError = vi.fn();
      const ch = createMockChannel();
      const s = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: createMockCodec(),
      });
      await s.close();
      // Registering after close does nothing and the returned unsubscribe is a
      // safe no-op (the handler was never registered).
      const unsub = s.on('error', onError);
      expect(() => {
        unsub();
      }).not.toThrow();
      expect(onError).not.toHaveBeenCalled();
    });
  });

  describe('input-event lookup (matching)', () => {
    it('matches the triggering event-id and ignores re-delivery of the same event', async () => {
      const ch = createMockChannel();
      const c = codecWithFunctionalDecoder();
      const s = createAgentSession({
        client: createMockClient(ch),
        channelName: 'multi-msg',
        codec: c,
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
      expect(run.view.getMessages()).toHaveLength(1);
      expect(run.view.getMessages()[0]?.codecMessageId).toBe('a');
      await s.close();
    });

    it('drains buffered input events in insertion order and stays registered for the remainder', async () => {
      const ch = createMockChannel();
      const c = codecWithFunctionalDecoder();
      const s = createAgentSession({
        client: createMockClient(ch),
        channelName: 'drain',
        codec: c,
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
      expect(run.view.getMessages().map((m) => m.codecMessageId)).toEqual(['first']);
      await s.close();
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
      await s.close();
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
      });
      await s.connect();

      const runId = 'r-buf';
      const invocationId = 'inv-buf';
      // Arrives before any lookup is registered — buffered by event-id.
      deliverInputEvent(ch, { invocationId, runId, codecMessageId: 'a', serial: '01', inputEventId: 'p-a' });

      const run = createRunFromOpts(s, { runId, invocationId, inputEventId: 'p-a' });
      await run.start();

      expect(run.view.getMessages().map((m) => m.codecMessageId)).toEqual(['a']);
      await s.close();
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
      expect(run.view.getMessages().map((m) => m.codecMessageId)).toEqual(['a']);
      await s.close();
    });

    it('cancels the lookup when the run signal aborts mid-collection', async () => {
      const ch = createMockChannel();
      const c = codecWithFunctionalDecoder();
      const s = createAgentSession({
        client: createMockClient(ch),
        channelName: 'abort-mid',
        codec: c,
      });
      await s.connect();

      const runId = 'r-abort';
      const invocationId = 'inv-abort';
      const run = createRunFromOpts(s, { runId, invocationId, inputEventId: 'p-a' });
      const startPromise = run.start();

      // Cancel-by-runId triggers controller.abort() on the registered run.
      simulateCancel(ch, { [HEADER_RUN_ID]: runId });

      await expect(startPromise).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
      await s.close();
    });
  });

  // Input-event buffer eviction tests removed: D18/D21 unified the per-event-id
  // input-event buffer into a session-level live buffer that is unbounded for
  // the session's lifetime (cleared on continuity loss / close). There is no
  // configurable buffer limit and no eviction warn-log to assert against.
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
    await session.close();
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
    await session.close();
  });

  it('start() resolves from channel history when the trigger was published before the agent attached', async () => {
    // The agent may be spun up after the client's POST: the triggering input
    // event is already in channel history and will never arrive live. The agent
    // pages it in with the one history driver — `run.view.loadOlder()` — which
    // folds the trigger into the Tree; `located` (which `start()` awaits)
    // resolves on that fold.
    const ch = createMockChannel();
    const triggerWire = {
      name: 'text',
      serial: 's-hist-01',
      version: { serial: 's-hist-01' },
      extras: {
        ai: {
          transport: {
            [HEADER_ROLE]: 'user',
            [HEADER_CODEC_MESSAGE_ID]: 'u1',
            [HEADER_EVENT_ID]: 'p-u1',
            [HEADER_INVOCATION_ID]: 'inv-hist',
          },
        },
      },
    } as unknown as Ably.InboundMessage;
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- mock returns Promise directly
    ch.history.mockImplementation(singlePageHistory([triggerWire]));

    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'history-only-trigger',
      codec: codecWithFunctionalDecoder(),
    });
    await session.connect();

    const run = createRunFromOpts(session, { runId: 'run-h', invocationId: 'inv-hist', inputEventId: 'p-u1' });
    // No deliverInputEvent — history is the only source for the trigger. Page it
    // in via the sole history driver, then start.
    while (run.view.hasOlder()) await run.view.loadOlder();
    await expect(run.start()).resolves.toBeUndefined();

    expect(ch.history).toHaveBeenCalled();
    expect(run.view.getMessages().map((m) => m.codecMessageId)).toEqual(['u1']);
    await session.close();
  });

  it('forwards historyPageSize to the channel-history fetch limit used by run.view.loadOlder()', async () => {
    const ch = createMockChannel();
    const triggerWire = {
      name: 'text',
      serial: 's-hist-ps',
      version: { serial: 's-hist-ps' },
      extras: {
        ai: {
          transport: {
            [HEADER_ROLE]: 'user',
            [HEADER_CODEC_MESSAGE_ID]: 'u1',
            [HEADER_EVENT_ID]: 'p-u1',
            [HEADER_INVOCATION_ID]: 'inv-ps',
          },
        },
      },
    } as unknown as Ably.InboundMessage;
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- mock returns Promise directly
    ch.history.mockImplementation(singlePageHistory([triggerWire]));

    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'history-page-size',
      codec: codecWithFunctionalDecoder(),
      historyPageSize: 7,
    });
    await session.connect();

    const run = createRunFromOpts(session, { runId: 'run-ps', invocationId: 'inv-ps', inputEventId: 'p-u1' });
    while (run.view.hasOlder()) await run.view.loadOlder();
    await expect(run.start()).resolves.toBeUndefined();

    expect(ch.history).toHaveBeenCalledWith(expect.objectContaining({ limit: 7 }));
    await session.close();
  });

  it('start() rejects promptly when channel continuity is lost while awaiting the trigger', async () => {
    // Continuity loss aborts every registered run BEFORE swapping the Tree, so a
    // run parked in start() awaiting `located` must reject via its run signal
    // rather than hang (located has no deadline). The trigger never arrives.
    const ch = createMockChannel();
    const onError = vi.fn();
    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'continuity-mid-lookup',
      codec: codecWithFunctionalDecoder(),
    });
    session.on('error', onError);
    await session.connect();

    const run = createRunFromOpts(session, { runId: 'run-c5', invocationId: 'inv-c5', inputEventId: 'p-never' });
    const startPromise = run.start();

    simulateStateChange(ch, { current: 'suspended', previous: 'attached' } as Ably.ChannelStateChange);

    await expect(startPromise).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    expect(onError).toHaveBeenCalledWith(expect.toBeErrorInfo({ code: ErrorCode.ChannelContinuityLost }));
    await session.close();
  });
});

// ---------------------------------------------------------------------------
// AgentRun.located — the no-deadline trigger watcher start() awaits
// ---------------------------------------------------------------------------

// A run-less user input wire carrying the given event-id / codec-message-id.
const locatedHistoryInput = (eventId: string, codecMessageId: string, serial: string): Ably.InboundMessage =>
  ({
    name: 'text',
    serial,
    version: { serial },
    extras: {
      ai: {
        transport: {
          [HEADER_ROLE]: 'user',
          [HEADER_CODEC_MESSAGE_ID]: codecMessageId,
          [HEADER_EVENT_ID]: eventId,
        },
      },
    },
  }) as unknown as Ably.InboundMessage;

describe('AgentRun.located', () => {
  it('resolves immediately when the invocation carries no inputEventId', async () => {
    const ch = createMockChannel();
    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'located-no-trigger',
      codec: codecWithFunctionalDecoder(),
    });
    await session.connect();

    const run = createRunFromOpts(session, { runId: 'run-1', invocationId: 'inv-1' });
    await expect(run.located).resolves.toBeUndefined();
    await session.close();
  });

  it('resolves when the triggering input arrives live', async () => {
    const ch = createMockChannel();
    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'located-live',
      codec: codecWithFunctionalDecoder(),
    });
    await session.connect();

    const run = createRunFromOpts(session, { runId: 'run-1', invocationId: 'inv-1', inputEventId: 'p-u1' });
    let resolved = false;
    void run.located.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    deliverInputEvent(ch, { invocationId: 'inv-1', codecMessageId: 'u1', serial: 's-01', inputEventId: 'p-u1' });
    await expect(run.located).resolves.toBeUndefined();
    await session.close();
  });

  it('resolves when a run.view.loadOlder() page folds a history-only trigger (cold start)', async () => {
    const ch = createMockChannel();
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- mock returns Promise directly
    ch.history.mockImplementation(singlePageHistory([locatedHistoryInput('p-u1', 'u1', 's-hist-01')]));
    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'located-cold-start',
      codec: codecWithFunctionalDecoder(),
    });
    await session.connect();

    const run = createRunFromOpts(session, { runId: 'run-1', invocationId: 'inv-1', inputEventId: 'p-u1' });
    let resolved = false;
    void run.located.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    // Nothing has folded the trigger yet — located is still pending.
    expect(resolved).toBe(false);

    // The one history driver pages the trigger in; located resolves on that fold.
    while (run.view.hasOlder()) await run.view.loadOlder();
    await expect(run.located).resolves.toBeUndefined();
    expect(run.view.getMessages().map((m) => m.codecMessageId)).toEqual(['u1']);
    await session.close();
  });

  it('rejects with InvalidArgument when the run is cancelled before the trigger arrives', async () => {
    const ch = createMockChannel();
    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'located-cancel',
      codec: codecWithFunctionalDecoder(),
    });
    await session.connect();

    const controller = new AbortController();
    const run = createRunFromOpts(session, {
      runId: 'run-1',
      invocationId: 'inv-1',
      inputEventId: 'p-u1',
      signal: controller.signal,
    });
    controller.abort();
    await expect(run.located).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    await session.close();
  });

  it('rejects with SessionClosed when the session closes before the trigger arrives', async () => {
    const ch = createMockChannel();
    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'located-close',
      codec: codecWithFunctionalDecoder(),
    });
    await session.connect();

    const run = createRunFromOpts(session, { runId: 'run-1', invocationId: 'inv-1', inputEventId: 'p-u1' });
    const located = run.located;
    await session.close();
    await expect(located).rejects.toBeErrorInfoWithCode(ErrorCode.SessionClosed);
  });

  it('start() blocks until located resolves, then publishes run-start', async () => {
    const ch = createMockChannel();
    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'located-start-blocks',
      codec: codecWithFunctionalDecoder(),
    });
    await session.connect();

    const run = createRunFromOpts(session, { runId: 'run-1', invocationId: 'inv-1', inputEventId: 'p-u1' });
    let started = false;
    const startPromise = run.start().then(() => {
      started = true;
    });
    // start() must not resolve while the trigger is unseen.
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toBe(false);
    expect(ch.publishCalls.find((m) => m.name === 'ai-run-start')).toBeUndefined();

    deliverInputEvent(ch, { invocationId: 'inv-1', codecMessageId: 'u1', serial: 's-01', inputEventId: 'p-u1' });
    await startPromise;
    expect(started).toBe(true);
    expect(ch.publishCalls.find((m) => m.name === 'ai-run-start')).toBeDefined();
    await session.close();
  });
});

// ---------------------------------------------------------------------------
// AgentRun.messages — projection-overlaid history + view contributions
// ---------------------------------------------------------------------------

describe('AgentRun.messages', () => {
  it('is empty before start() resolves (no loadProjection yet)', async () => {
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
    await session.close();
  });

  it('returns view-message contributions after start() resolves (fresh send)', async () => {
    const ch = createMockChannel();
    const codec = codecWithFunctionalDecoder();
    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'fresh',
      codec,
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
    await session.close();
  });

  it('returns view messages after start() resolves on continuation (no history overlay)', async () => {
    const ch = createMockChannel();
    const codec = codecWithFunctionalDecoder();

    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'cont-overlay',
      codec,
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
    await session.close();
  });

  it('returns only view messages after start() on continuation (no history to pass through)', async () => {
    const ch = createMockChannel();
    const codec = codecWithFunctionalDecoder();

    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'cont-no-overlap',
      codec,
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
    await session.close();
  });

  it('detects continuation status from a tool-resolution-only lookup (matched-event headers)', async () => {
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

    // The wire run-id (read from the matched tool-resolution event's
    // headers) makes the agent re-enter the run with
    // ai-run-resume rather than open a new ai-run-start.
    expect(ch.publishCalls.find((m) => m.name === 'ai-run-resume')).toBeDefined();
    expect(ch.publishCalls.find((m) => m.name === 'ai-run-start')).toBeUndefined();
    await session.close();
  });

  it('is this run’s whole turn (input + own output), decoupled from the run.view ancestor walk', async () => {
    // Two-node model. Turn 1: input node u1 (run-less user) → reply run-1
    // (assistant a1). Turn 2: input node u2 (run-less user, parent=a1) → the
    // current reply run-2 (assistant a2). The agent serves run-2; u2 is its
    // triggering input event, delivered via deliverInputEvent so start() sets
    // assistantParentFallback=u2.
    //
    // run.messages is this run's WHOLE TURN — its triggering input (u2) plus
    // its own streamed output — never the ancestor chain. Draining run.view
    // hydrates run-2's reply (a2) into the Tree, which grows the turn to
    // [u2, a2]; it never pulls the prior turn (u1, a1) into run.messages.
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
    });
    await session.connect();
    const run = createRunFromOpts(session, { runId, invocationId, inputEventId });
    const startPromise = run.start();
    // Fresh-send ai-input carries no run-id on the wire (live-confirmed) — the agent mints the run separately.
    deliverInputEvent(ch, { invocationId, codecMessageId: 'u2', serial: 's-05', inputEventId, parent: 'a1' });
    await startPromise;

    // Before draining run.view: this run's triggering input only (run-2 has
    // streamed no output yet).
    expect(run.messages).toEqual([{ id: 'u2', content: 'u2' }]);

    while (run.view.hasOlder()) await run.view.loadOlder();

    // After the ancestor walk: still just this run's turn — its input u2 plus
    // its own reply a2 (now folded) — NOT the ancestor turn u1/a1.
    expect(run.messages).toEqual([
      { id: 'u2', content: 'u2' },
      { id: 'a2', content: 'a2' },
    ]);
    // Each access returns a fresh array — mutations don't bleed back.
    run.messages.push({ id: 'leak', content: 'no' });
    expect(run.messages).toEqual([
      { id: 'u2', content: 'u2' },
      { id: 'a2', content: 'a2' },
    ]);
    await session.close();
  });

  it('exposes status/error read off the Tree (active, no error, through createRun)', async () => {
    // status/error are the shared BaseRun members the agent run gains. The full
    // status matrix (suspended/complete/cancelled/error) is unit-tested in
    // base-run.test.ts; here we assert the agent's createRun path wires them.
    const ch = createMockChannel();
    const codec = codecWithFunctionalDecoder();
    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'status',
      codec,
    });
    await session.connect();
    const run = createRunFromOpts(session, { runId: 'run-1', invocationId: 'inv-1', inputEventId: 'p1' });

    // Before start: no run node folded yet → active by default, no error.
    expect(run.status).toBe('active');
    expect(run.error).toBeUndefined();

    const startPromise = run.start();
    deliverInputEvent(ch, {
      invocationId: 'inv-1',
      runId: 'run-1',
      codecMessageId: 'u1',
      serial: 's-1',
      inputEventId: 'p1',
    });
    await startPromise;

    // After start the optimistic run node is active and carries no error.
    expect(run.status).toBe('active');
    expect(run.error).toBeUndefined();
    await session.close();
  });
});

// ---------------------------------------------------------------------------
// Helpers for the agent run.view / messages tests
// ---------------------------------------------------------------------------

/**
 * Build a synthetic ai-run-start wire message for the given runId.
 * The second argument is the HEADER_PARENT value — the codec-message-id
 * of the last message from the parent run (not the run-id itself). The Tree's
 * ancestor walk resolves the parent runId by looking up that codec-message-id.
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
 * Build a synthetic ai-run-end wire message. With no explicit reason header the
 * wire decodes the run-end reason as 'complete', so the Tree records the run as
 * completed — the normal terminal state a finished turn carries in channel
 * history. The agent's run.view only retains completed ancestor runs, so a
 * served conversation's prior turns must carry their run-end to be hydrated.
 * @param runId - The run that ended.
 * @param serial - Serial override; defaults to `s-end-<runId>`. Supply an explicit
 *   value when the run-end must sort chronologically against surrounding wires.
 * @returns A synthetic inbound message mimicking an ai-run-end wire event.
 */
const makeRunEndMsg = (runId: string, serial?: string): Ably.InboundMessage =>
  ({
    name: EVENT_RUN_END,
    serial: serial ?? `s-end-${runId}`,
    extras: { ai: { transport: { [HEADER_RUN_ID]: runId } } },
  }) as unknown as Ably.InboundMessage;

/**
 * Build a synthetic content wire message for a run. The functional decoder
 * folds it into a TestMessage with id=codecMsgId.
 * @param runId - The run that owns this message.
 * @param codecMsgId - The message identifier (becomes the TestMessage id).
 * @param serial - Optional serial override; defaults to `s-<codecMsgId>`.
 * @returns A synthetic inbound message mimicking a codec content wire event.
 */
const makeContentMsg = (runId: string, codecMsgId: string, serial?: string): Ably.InboundMessage => {
  const wireSerial = serial ?? `s-${codecMsgId}`;
  return {
    name: 'text',
    serial: wireSerial,
    extras: { ai: { transport: { [HEADER_RUN_ID]: runId, [HEADER_CODEC_MESSAGE_ID]: codecMsgId } } },
    // A never-mutated message's version serial equals its serial; carrying it
    // lets the Tree's replay guard dedup a wire delivered both live and via a
    // history walk (the role `_foldedSerials` used to play).
    version: { serial: wireSerial },
  } as unknown as Ably.InboundMessage;
};

/**
 * Build a synthetic run-less user INPUT-node wire message (the two-node model:
 * the user prompt the client published before the agent minted a run-id). It
 * carries a codec-message-id and an optional structural `parent` but NO run-id,
 * so the Tree classifies it as an input node and folds it via
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
    // A never-mutated message's version serial equals its serial; carrying it
    // lets the Tree's replay guard dedup a wire delivered both live and via a
    // history walk (the role `_foldedSerials` used to play).
    version: { serial },
  } as unknown as Ably.InboundMessage;
};

// ---------------------------------------------------------------------------
// Shared wire-history fixtures for the run.view tests
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
    if (wire.name === EVENT_RUN_END) {
      const h = transportHeadersOf(wire);
      tree.applyRunLifecycle({
        type: 'end',
        runId: h[HEADER_RUN_ID] ?? '',
        clientId: '',
        invocationId: h[HEADER_INVOCATION_ID] ?? '',
        // The fixtures only emit completed run-ends (the wire default reason);
        // a run-end carries no codec content, so it must not be decoded.
        reason: 'complete',
        serial: wire.serial,
      });
      continue;
    }
    const decoded = decoder.decode(wire);
    tree.applyMessage(decoded, transportHeadersOf(wire), wire.serial);
  }
  const sendDelegate: SendDelegate<TestInput, TestMessage> =
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    vi.fn(() =>
      Promise.resolve<ClientRun<TestMessage>>({
        inputCodecMessageId: 'k',
        runId: 'r',
        status: 'active',
        error: undefined,
        messages: [],
        started: Promise.resolve(),
        inputEventId: '',
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
        cancel: () => Promise.resolve(),
        toInvocation: () => Invocation.fromJSON({ inputEventId: '', sessionName: 'test' }),
      }),
    );
  const view = createClientView<TestInput, TestOutput, TestProjection, TestMessage>({
    tree,
    codec,
    hydrator: createHistoryHydrator({
      channel: createMockChannel(),
      tree,
      applier: createWireApplier(tree, codec.createDecoder()),
      logger,
    }),
    sendDelegate,
    logger,
  });
  return view.getMessages().map((m) => m.message.id);
};

// ---------------------------------------------------------------------------
// run.view: the agent's leaf-pinned read of the SHARED View base
//
// run.view is the same paginating View the client exposes, projecting the leaf
// source's branch. These prove its lifecycle (empty until the input-event
// watcher pins its branch when the trigger folds in) and that, drained, it
// reconstructs the identical branch the client View does over the same wire
// history.
// ---------------------------------------------------------------------------

describe('agent run.view (shared read base)', () => {
  it('is empty before start() and reflects the trigger once the run pins it', async () => {
    const ch = createMockChannel();
    const codec = codecWithFunctionalDecoder();
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- mock returns Promise directly
    ch.history.mockImplementation(singlePageHistory([]));

    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'run-view-lifecycle',
      codec,
    });
    await session.connect();

    const run = createRunFromOpts(session, { runId: 'run-1', invocationId: 'inv-1', inputEventId: 'p-u1' });
    // No branch is pinned until the watcher matches the trigger, so run.view is empty here.
    expect(run.view.getMessages()).toEqual([]);

    const startPromise = run.start();
    deliverInputEvent(ch, { invocationId: 'inv-1', codecMessageId: 'u1', serial: 's-01', inputEventId: 'p-u1' });
    await startPromise;

    // The watcher pinned the branch when the trigger folded (here during start(),
    // as it arrives live) and nudged the view to recompute.
    expect(run.view.getMessages().map((m) => m.codecMessageId)).toEqual(['u1']);
    await session.close();
  });

  it('drained, reconstructs the identical multi-turn branch the client View does', async () => {
    // Same two-turn history as the cross-engine block; the agent serves run-2.
    // The prior turn (run-1) carries its run-end, as a completed turn does in a
    // served conversation's history — so the agent's completed-run-only walk
    // retains it and stays equivalent to the unfiltered client View.
    const wiresNewestFirst = [
      makeContentMsg('run-2', 'a2', 's-06'),
      makeRunStartMsg('run-2', 'u2', { serial: 's-055' }),
      makeInputMsg('u2', 's-05', { parent: 'a1' }),
      makeRunEndMsg('run-1', 's-045'),
      makeContentMsg('run-1', 'a1', 's-04'),
      makeRunStartMsg('run-1', 'u1', { serial: 's-03' }),
      makeInputMsg('u1', 's-02'),
    ];

    const ch = createMockChannel();
    const codec = codecWithFunctionalDecoder();
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- mock returns Promise directly
    ch.history.mockImplementation(singlePageHistory(wiresNewestFirst));

    const session = createAgentSession<TestInput, TestOutput, TestProjection, TestMessage>({
      client: createMockClient(ch),
      channelName: 'run-view-parity',
      codec,
    });
    await session.connect();
    const run = createRunFromOpts(session, { runId: 'run-2', invocationId: 'inv-2', inputEventId: 'p-u2' });
    const startPromise = run.start();
    deliverInputEvent(ch, {
      invocationId: 'inv-2',
      codecMessageId: 'u2',
      serial: 's-05',
      inputEventId: 'p-u2',
      parent: 'a1',
    });
    await startPromise;

    // Page run.view back to the conversation root — the same loadOlder drain the
    // client uses — then read its branch.
    while (run.view.hasOlder()) await run.view.loadOlder();
    const runViewIds = run.view.getMessages().map((m) => m.message.id);
    const clientIds = viewMessageIds(wiresNewestFirst.toReversed());

    expect(runViewIds).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(runViewIds).toEqual(clientIds);
    await session.close();
  });
});
