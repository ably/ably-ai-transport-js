/**
 * ClientSession unit tests.
 *
 * Mock encoder uses split-direction `publishInput` / `publishOutput`; mock
 * decoder returns `{ inputs, outputs }`; projection state is folded via
 * `init` / `fold` / `getMessages`.
 *
 * Coverage: connect, send, regenerate, edit, cancel, run lifecycle,
 * observer routing, optimistic relay, channel state, continuation
 * (suspend / resume) sends, and close.
 */

import * as Ably from 'ably';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EVENT_RUN_END,
  EVENT_RUN_START,
  HEADER_CODEC_MESSAGE_ID,
  HEADER_ERROR_CODE,
  HEADER_ERROR_MESSAGE,
  HEADER_EVENT_ID,
  HEADER_FORK_OF,
  HEADER_INPUT_CODEC_MESSAGE_ID,
  HEADER_INVOCATION_ID,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_CONTINUE,
  HEADER_RUN_ID,
  HEADER_RUN_REASON,
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
import { createClientSession } from '../../../src/core/transport/client-session.js';
import type { ClientSession, RunLifecycleEvent } from '../../../src/core/transport/types.js';
import { ErrorCode } from '../../../src/errors.js';
import { createMockClient } from '../../helper/mock-client.js';

// ---------------------------------------------------------------------------
// Test event / projection / message shapes
// ---------------------------------------------------------------------------

/**
 * Inputs published by the client. The `user-message` variant is the codec's
 * well-known {@link UserMessage} shape; `regenerate-input` carries a
 * `target` so the session reads it as the `msg-regenerate` anchor;
 * `edit-input` carries a `target` that becomes the `fork-of` anchor.
 */
type TestInput =
  | ({ kind: 'user-message'; text?: string; message?: TestMessage } & CodecInputEvent)
  | ({ kind: 'regenerate'; target: string; parent: string } & CodecInputEvent)
  | ({ kind: 'edit'; target: string; parent: string; text?: string; message?: TestMessage } & CodecInputEvent);

/** Outputs published by the agent and surfaced on the consumer's stream. */
interface TestOutput {
  type: string;
  text?: string;
}

type TestEvent = TestInput | TestOutput;

interface TestMessage {
  id: string;
  content: string;
}

interface TestProjection {
  messages: TestMessage[];
  /** Events folded in this projection — used for assertions. */
  foldedEvents: { event: TestEvent; meta: ReducerMeta }[];
}

// ---------------------------------------------------------------------------
// Mock channel
// ---------------------------------------------------------------------------

interface MockChannel {
  publish: ReturnType<typeof vi.fn>;
  publishCalls: Ably.Message[];
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  attach: ReturnType<typeof vi.fn>;
  history: ReturnType<typeof vi.fn>;
  state: Ably.ChannelState;
  listener: ((msg: Ably.InboundMessage) => void) | undefined;
  stateListeners: Set<Ably.channelEventCallback>;
}

const createMockChannel = (): MockChannel & Ably.RealtimeChannel => {
  const stateListeners = new Set<Ably.channelEventCallback>();
  const mock: MockChannel = {
    listener: undefined,
    stateListeners,
    state: 'attached',
    publishCalls: [],
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    publish: vi.fn((message: Ably.Message | Ably.Message[]) => {
      if (Array.isArray(message)) mock.publishCalls.push(...message);
      else mock.publishCalls.push(message);
      return Promise.resolve({ serials: ['serial-x'] });
    }),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    subscribe: vi.fn((callback: (msg: Ably.InboundMessage) => void) => {
      mock.listener = callback;
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
      const emptyPage = {
        items: [],
        hasNext: () => false,
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
        next: () => Promise.resolve(emptyPage),
      };
      return Promise.resolve(emptyPage);
    }),
  };
  // CAST: tests only use the listed members; the rest of RealtimeChannel is unused.
  return mock as unknown as MockChannel & Ably.RealtimeChannel;
};

const simulateMessage = (ch: MockChannel, msg: Ably.InboundMessage): void => {
  if (ch.listener) ch.listener(msg);
};

const simulateStateChange = (ch: MockChannel, stateChange: Ably.ChannelStateChange): void => {
  for (const listener of ch.stateListeners) {
    listener(stateChange);
  }
};

let serialCounter = 0;
const nextSerial = (): string => `serial-${String(serialCounter++).padStart(10, '0')}`;

const ablyMsg = (
  name: string,
  headers: Record<string, string>,
  data?: unknown,
  action = 'message.create',
  serial?: string,
): Ably.InboundMessage =>
  ({
    name,
    data,
    action,
    extras: { ai: { transport: headers } },
    serial: serial ?? nextSerial(),
  }) as unknown as Ably.InboundMessage;

// ---------------------------------------------------------------------------
// Mock codec — direction-split encoder (publishInput / publishOutput)
// ---------------------------------------------------------------------------

/** Single shape captured for both input and output publishes. */
interface MockPublishCall {
  /** Tagged direction so assertions can distinguish input vs output publishes. */
  direction: 'input' | 'output';
  /** The TInput or TOutput that was published. */
  event: TestInput | TestOutput;
  /** Per-write overrides supplied at publish time. */
  opts: WriteOptions | undefined;
}

interface MockEncoder extends Encoder<TestInput, TestOutput> {
  publishCalls: MockPublishCall[];
  /** Set to a non-null Error to make subsequent publish*() reject. */
  failPublishWith: Error | undefined;
}

interface MockDecoder extends Decoder<TestInput, TestOutput> {
  /** Queue of inputs to return on the next decode() call. */
  inputQueue: TestInput[];
  /** Queue of outputs to return on the next decode() call. */
  queue: TestOutput[];
}

interface MockCodec extends Codec<TestInput, TestOutput, TestProjection, TestMessage> {
  encoders: MockEncoder[];
  /** Most recent encoder created via `createEncoder`. */
  lastEncoder(): MockEncoder | undefined;
}

const createMockEncoder = (): MockEncoder => {
  const calls: MockPublishCall[] = [];
  const enc: MockEncoder = {
    publishCalls: calls,
    failPublishWith: undefined,
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

const createMockDecoder = (): MockDecoder => {
  const queue: TestOutput[] = [];
  const inputQueue: TestInput[] = [];
  return {
    queue,
    inputQueue,
    decode: vi.fn(() => {
      const outputs = [...queue];
      const inputs = [...inputQueue];
      queue.length = 0;
      inputQueue.length = 0;
      return { inputs, outputs };
    }),
  };
};

const createMockCodec = (decoder?: MockDecoder): MockCodec => {
  const encoders: MockEncoder[] = [];
  const codec: MockCodec = {
    encoders,
    lastEncoder: () => encoders.at(-1),
    init: vi.fn(
      (): TestProjection => ({
        messages: [],
        foldedEvents: [],
      }),
    ),
    fold: vi.fn((state: TestProjection, event: TestEvent, meta: ReducerMeta) => {
      state.foldedEvents.push({ event, meta });
      if ('type' in event) {
        // The mock fold treats `text` outputs with a `text` payload as message
        // text — it appends to (or creates) a message keyed by meta.messageId.
        if (event.type === 'text' && typeof event.text === 'string') {
          const id = meta.messageId ?? 'unknown';
          let msg = state.messages.find((m) => m.id === id);
          if (!msg) {
            msg = { id, content: '' };
            state.messages.push(msg);
          }
          msg.content += event.text;
        }
        return state;
      }
      // User-message inputs fold into the projection by meta.messageId so
      // getMessages() yields them for the tree to surface.
      if (event.kind === 'user-message') {
        const id = meta.messageId ?? 'unknown';
        const content = event.message?.content ?? event.text ?? '';
        const next: TestMessage = { id, content };
        const idx = state.messages.findIndex((m) => m.id === id);
        if (idx === -1) state.messages.push(next);
        else state.messages[idx] = next;
      }
      return state;
    }),
    getMessages: vi.fn((p: TestProjection) => p.messages),
    createUserMessage: vi.fn((m: TestMessage) => ({ kind: 'user-message' as const, message: m })),
    createRegenerate: vi.fn(
      (target: string, parent: string) => ({ kind: 'regenerate' as const, target, parent }) as const,
    ),
    // eslint-disable-next-line unicorn/no-useless-undefined -- vi.fn requires an explicit return matching the codec contract
    resolveToolTarget: vi.fn(() => undefined),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- writer/options unused by stub
    createEncoder: vi.fn((_writer: ChannelWriter, _opts?: EncoderOptions) => {
      const enc = createMockEncoder();
      encoders.push(enc);
      return enc;
    }),
    createDecoder: vi.fn(() => decoder ?? createMockDecoder()),
  };
  return codec;
};

// ---------------------------------------------------------------------------
// Run-start helper — simulates the agent acknowledging an invocation
// ---------------------------------------------------------------------------

/**
 * Wait for at least one user-message publish, then simulate the matching
 * agent run-start so the run's `started` promise resolves. Returns the
 * simulated runId / invocationId / codecMessageId triple.
 *
 * `send()` itself no longer blocks on run-start, so this is only needed by
 * tests that assert on `run.started` or that drive subsequent run lifecycle.
 * @param channel - Mock channel.
 * @param codec - Mock codec.
 * @returns The published codecMessageId/runId/invocationId.
 */
const ackPendingSend = async (
  channel: MockChannel,
  codec: MockCodec,
): Promise<{ runId: string; invocationId: string; codecMessageId: string }> => {
  // Wait for an encoder.publish() call (the user-message). Reads the first
  // publish, so this helper assumes single-input sends — where the first
  // publish IS the trigger whose codec-message-id keys `started`.
  let publishedHeaders: Record<string, string> | undefined;
  for (let i = 0; i < 100; i++) {
    const enc = codec.lastEncoder();
    if (enc && enc.publishCalls.length > 0) {
      const opts = enc.publishCalls[0]?.opts;
      publishedHeaders = opts?.extras?.headers;
      if (publishedHeaders) break;
    }
    await Promise.resolve();
  }
  if (!publishedHeaders) throw new Error('no user-message publish observed');

  const runId = publishedHeaders[HEADER_RUN_ID] ?? '';
  const invocationId = publishedHeaders[HEADER_INVOCATION_ID] ?? '';
  const codecMessageId = publishedHeaders[HEADER_CODEC_MESSAGE_ID] ?? '';
  const runContinue = publishedHeaders[HEADER_RUN_CONTINUE] === 'true';
  // Mirror the agent: thread the triggering input's codec-message-id back as
  // `input-codec-message-id` (the handle a fresh send's `started` resolves on)
  // and mark continuations with `run-continue` (which the client resolves by
  // the reused runId instead).
  simulateMessage(
    channel,
    ablyMsg(EVENT_RUN_START, {
      [HEADER_RUN_ID]: runId,
      [HEADER_RUN_CLIENT_ID]: 'client-1',
      [HEADER_INVOCATION_ID]: invocationId,
      [HEADER_INPUT_CODEC_MESSAGE_ID]: codecMessageId,
      ...(runContinue ? { [HEADER_RUN_CONTINUE]: 'true' } : {}),
    }),
  );
  return { runId, invocationId, codecMessageId };
};

interface SessionFixture {
  channel: MockChannel & Ably.RealtimeChannel;
  decoder: MockDecoder;
  codec: MockCodec;
  session: ClientSession<TestInput, TestOutput, TestProjection, TestMessage>;
}

const createFixture = async (overrides?: { clientId?: string }): Promise<SessionFixture> => {
  const channel = createMockChannel();
  const decoder = createMockDecoder();
  const codec = createMockCodec(decoder);
  const session = createClientSession<TestInput, TestOutput, TestProjection, TestMessage>({
    client: createMockClient(channel),
    channelName: 'test-channel',
    codec,
    clientId: overrides?.clientId ?? 'client-1',
  });
  await session.connect();
  return { channel, decoder, codec, session };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClientSession', () => {
  let fix: SessionFixture;

  beforeEach(async () => {
    fix = await createFixture();
  });

  afterEach(async () => {
    await fix.session.close();
  });

  // -------------------------------------------------------------------------
  // connect() contract
  // -------------------------------------------------------------------------

  describe('connect()', () => {
    it('is idempotent — repeated calls return the same promise', async () => {
      const ch = createMockChannel();
      const s = createClientSession<TestInput, TestOutput, TestProjection, TestMessage>({
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

    it('subscribes via channel.subscribe(callback)', () => {
      expect(fix.channel.subscribe).toHaveBeenCalledTimes(1);
      expect(typeof fix.channel.listener).toBe('function');
    });

    it('send() throws InvalidArgument before connect()', async () => {
      const ch = createMockChannel();
      const s = createClientSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: createMockCodec(),
      });
      await expect(s.view.sendInput({ kind: 'user-message', text: 'hi' })).rejects.toBeErrorInfoWithCode(
        ErrorCode.InvalidArgument,
      );
      await s.close();
    });

    it('cancel() throws InvalidArgument before connect()', async () => {
      const ch = createMockChannel();
      const s = createClientSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: createMockCodec(),
      });
      await expect(s.cancel('run-x')).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
      await s.close();
    });

    it('rejects connect when subscribe fails', async () => {
      const ch = createMockChannel();
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.reject directly
      ch.subscribe = vi.fn(() => Promise.reject(new Ably.ErrorInfo('subscribe failed', 40000, 400)));
      const s = createClientSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: createMockCodec(),
      });
      await expect(s.connect()).rejects.toBeErrorInfoWithCode(ErrorCode.SessionSubscriptionError);
      await s.close();
    });
  });

  // -------------------------------------------------------------------------
  // construction
  // -------------------------------------------------------------------------

  describe('construction', () => {
    it('exposes tree and view', () => {
      expect(fix.session.tree).toBeDefined();
      expect(fix.session.view).toBeDefined();
    });

    it('createView returns a fresh view backed by the same tree', () => {
      const v = fix.session.createView();
      expect(v).toBeDefined();
      expect(v).not.toBe(fix.session.view);
      v.close();
    });

    it('seeds initial messages into the tree', async () => {
      const ch = createMockChannel();
      const s = createClientSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: createMockCodec(),
        messages: [
          { id: 'seed-1', content: 'first' },
          { id: 'seed-2', content: 'second' },
        ],
      });
      await s.connect();

      const messages = s.view.getMessages();
      expect(messages.map((m) => m.content)).toEqual(['first', 'second']);
      // Subsequent seed Runs chain off the prior one via parentRunId.
      const nodes = s.tree.runs();
      expect(nodes).toHaveLength(2);
      expect(nodes[1]?.parentRunId).toBe(nodes[0]?.runId);
      await s.close();
    });
  });

  // -------------------------------------------------------------------------
  // send — happy path
  // -------------------------------------------------------------------------

  describe('send', () => {
    it('returns an ActiveRun with runId, invocationId, cancel', async () => {
      const run = await fix.session.view.sendInput({ kind: 'user-message', text: 'hi' });
      expect(typeof run.runId).toBe('string');
      expect(typeof run.invocationId).toBe('string');
      expect(typeof run.cancel).toBe('function');
    });

    it('inserts an optimistic user message into the tree', async () => {
      await fix.session.view.sendInput({ kind: 'user-message', text: 'hello' });
      const messages = fix.session.view.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]?.content).toBe('hello');
    });

    it('publishes the user-message TInput on the channel via encoder.publishInput with transport headers', async () => {
      const before = fix.codec.lastEncoder()?.publishCalls.length ?? 0;
      await fix.session.view.sendInput({ kind: 'user-message', text: 'hello' });

      const enc = fix.codec.lastEncoder();
      expect(enc).toBeDefined();
      expect((enc?.publishCalls.length ?? 0) - before).toBe(1);

      const call = enc?.publishCalls.at(-1);
      expect(call?.direction).toBe('input');
      expect(call?.event && 'kind' in call.event ? call.event.kind : undefined).toBe('user-message');
      const opts = call?.opts;
      expect(opts?.messageId).toBeDefined();
      expect(opts?.extras?.headers?.[HEADER_RUN_ID]).toBeDefined();
      expect(opts?.extras?.headers?.[HEADER_INVOCATION_ID]).toBeDefined();
      expect(opts?.extras?.headers?.[HEADER_ROLE]).toBe('user');
      expect(opts?.extras?.headers?.['event-id']).toBeDefined();
      // `ai-input` events do not carry `input-client-id` — the wire
      // publisher's Ably `clientId` already conveys that on the input event
      // itself. The agent re-stamps it on its own subsequent publishes.
      expect(opts?.extras?.headers?.['input-client-id']).toBeUndefined();
    });

    it('pins the wire codec-message-id from TInput.codecMessageId instead of minting a fresh id', async () => {
      // Each TInput carries its routing fields directly via the
      // {@link CodecInputEvent} base. When `codecMessageId` is set, the
      // session stamps that value on the wire `codec-message-id`
      // header instead of minting a UUID. For a fresh user-message this
      // pins the message's own id (the TMessage.id == wire id convention);
      // for a continuation input it targets the assistant being amended.
      await fix.session.view.sendInput([
        { kind: 'user-message', text: 'first', codecMessageId: 'target-a' },
        { kind: 'user-message', text: 'second' },
      ]);

      const enc = fix.codec.lastEncoder();
      const userPublishes =
        enc?.publishCalls.filter(
          (c) => c.direction === 'input' && 'kind' in c.event && c.event.kind === 'user-message',
        ) ?? [];
      expect(userPublishes).toHaveLength(2);

      // First entry used the supplied codecMessageId; second fell back to a fresh UUID.
      expect(userPublishes[0]?.opts?.extras?.headers?.[HEADER_CODEC_MESSAGE_ID]).toBe('target-a');
      const secondMsgId = userPublishes[1]?.opts?.extras?.headers?.[HEADER_CODEC_MESSAGE_ID];
      expect(secondMsgId).toBeDefined();
      expect(secondMsgId).not.toBe('target-a');
    });

    it('folds an optimistic user message even when it carries a caller-supplied codecMessageId', async () => {
      // Regression: a fresh user-message that pins its own codec-message-id
      // (the path View.sendMessage takes for every message with an id) must
      // still fold into the local projection synchronously. Treating the
      // presence of `codecMessageId` as "wire-only" suppressed the optimistic
      // fold, so the user bubble only appeared once the publish echoed back
      // off the channel — a round-trip race that flaked integration tests.
      await fix.session.view.sendInput({
        kind: 'user-message',
        text: 'hello',
        codecMessageId: 'pinned-id',
      });

      // No channel echo simulated — the message must be present purely from
      // the optimistic fold.
      const nodes = fix.session.tree.runs();
      expect(nodes).toHaveLength(1);
      expect(nodes[0]?.runId).toBeDefined();
      expect(nodes[0]?.invocationId).toBeDefined();

      const messages = fix.session.view.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]?.id).toBe('pinned-id');
      expect(messages[0]?.content).toBe('hello');
    });

    it('mints a distinct event-id per user-message; ActiveRun.inputEventId is the last (primary trigger)', async () => {
      const run = await fix.session.view.sendInput([
        { kind: 'user-message', text: 'first' },
        { kind: 'user-message', text: 'second' },
      ]);

      const enc = fix.codec.lastEncoder();
      const userPublishes =
        enc?.publishCalls.filter(
          (c) => c.direction === 'input' && 'kind' in c.event && c.event.kind === 'user-message',
        ) ?? [];
      expect(userPublishes).toHaveLength(2);
      const stampedIds = userPublishes.map((c) => c.opts?.extras?.headers?.['event-id']);
      expect(stampedIds[0]).toBeDefined();
      expect(stampedIds[1]).toBeDefined();
      expect(stampedIds[0]).not.toBe(stampedIds[1]);

      // The run's primary trigger event is the last input — the one a caller's
      // invocation points at.
      expect(run.inputEventId).toBe(stampedIds[1]);
    });

    it('auto-computes parent from the last visible message', async () => {
      const ch = createMockChannel();
      const seeded = createClientSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: createMockCodec(),
        messages: [{ id: 'seed', content: 'first' }],
      });
      await seeded.connect();

      const seedRunId = seeded.tree.runs()[0]?.runId;
      const run = await seeded.view.sendInput({ kind: 'user-message', text: 'next' });

      // Find the new Run — it should be parented to the seed Run.
      const nodes = seeded.tree.runs();
      expect(nodes.length).toBeGreaterThan(1);
      const newNode = nodes.find((n) => n.parentRunId === seedRunId);
      expect(newNode).toBeDefined();
      expect(run.optimisticCodecMessageIds).toHaveLength(1);
      await seeded.close();
    });

    it('chains multi-message sends in a thread', async () => {
      await fix.session.view.sendInput([
        { kind: 'user-message', text: 'first' },
        { kind: 'user-message', text: 'second' },
      ]);
      // Both messages land in the same Run's projection (one Run per send).
      const messages = fix.session.view.getMessages();
      expect(messages).toHaveLength(2);
      expect(messages[0]?.content).toBe('first');
      expect(messages[1]?.content).toBe('second');

      // The encoder publishes each event with chained parents: second's parent header == first's codec-message-id.
      const enc = fix.codec.lastEncoder();
      const userPublishes =
        enc?.publishCalls.filter(
          (c) => c.direction === 'input' && 'kind' in c.event && c.event.kind === 'user-message',
        ) ?? [];
      expect(userPublishes).toHaveLength(2);
      const firstMsgId = userPublishes[0]?.opts?.extras?.headers?.[HEADER_CODEC_MESSAGE_ID];
      const secondParent = userPublishes[1]?.opts?.extras?.headers?.[HEADER_PARENT];
      expect(secondParent).toBe(firstMsgId);
    });

    it('stamps forkOf on the publish headers when set', async () => {
      // forkOf rides the channel headers — the agent resolves it from the
      // first input-event lookup user-message header.
      await fix.session.view.sendInput({ kind: 'user-message', text: 'hi' }, { forkOf: 'msg-original' });
      const enc = fix.codec.lastEncoder();
      const headers = enc?.publishCalls.at(-1)?.opts?.extras?.headers;
      expect(headers?.['fork-of']).toBe('msg-original');
    });

    it('throws when session is closed', async () => {
      await fix.session.close();
      // View error wrapping: the view rejects with its "view is closed" error.
      await expect(fix.session.view.sendInput({ kind: 'user-message', text: 'hi' })).rejects.toThrow();
    });

    for (const state of ['failed', 'suspended', 'detached', 'initialized'] as const) {
      it(`rejects when channel state is ${state}`, async () => {
        // Mark initial attach as observed so further state changes don't get filtered.
        simulateStateChange(fix.channel, {
          current: 'attached',
          previous: 'attaching',
          resumed: false,
        });
        fix.channel.state = state;
        await expect(fix.session.view.sendInput({ kind: 'user-message', text: 'hi' })).rejects.toBeErrorInfoWithCode(
          ErrorCode.ChannelNotReady,
        );
      });
    }

    it('allows send when channel is ATTACHING', async () => {
      simulateStateChange(fix.channel, {
        current: 'attached',
        previous: 'attaching',
        resumed: false,
      });
      fix.channel.state = 'attaching';
      const run = await fix.session.view.sendInput({ kind: 'user-message', text: 'hi' });
      expect(typeof run.runId).toBe('string');
    });
  });

  // -------------------------------------------------------------------------
  // send — continuation (options.runId reuses the suspended run)
  // -------------------------------------------------------------------------

  describe('send — continuation', () => {
    it('reuses the runId and mints a fresh invocationId', async () => {
      const initial = await fix.session.view.sendInput({ kind: 'user-message', text: 'hi' });

      const cont = await fix.session.view.sendInput([{ kind: 'user-message', text: 'more' }], {
        runId: initial.runId,
      });

      expect(cont.runId).toBe(initial.runId);
      expect(cont.invocationId).not.toBe(initial.invocationId);
    });

    it('publishes the continuation user-message with HEADER_RUN_ID and HEADER_RUN_CONTINUE', async () => {
      const initial = await fix.session.view.sendInput({ kind: 'user-message', text: 'hi' });
      const enc = fix.codec.lastEncoder();
      // Drop the initial publish from the call count
      const baseCalls = enc?.publishCalls.length ?? 0;

      await fix.session.view.sendInput([{ kind: 'user-message', text: 'more' }], { runId: initial.runId });

      const newCalls = (enc?.publishCalls.length ?? 0) - baseCalls;
      expect(newCalls).toBe(1);
      const call = enc?.publishCalls.at(-1);
      expect(call?.direction).toBe('input');
      expect(call?.event && 'kind' in call.event ? call.event.kind : undefined).toBe('user-message');
      const headers = call?.opts?.extras?.headers;
      expect(headers?.[HEADER_RUN_ID]).toBe(initial.runId);
      // A fresh invocation-id is minted for the continuation.
      expect(headers?.[HEADER_INVOCATION_ID]).toBeDefined();
      expect(headers?.[HEADER_INVOCATION_ID]).not.toBe(initial.invocationId);
      // Continuation publishes carry HEADER_RUN_CONTINUE='true' on the wire.
      expect(headers?.['run-continue']).toBe('true');
      // Continuation user-messages publish as role:'user'.
      expect(headers?.[HEADER_ROLE]).toBe('user');
      // No amend header — the old amend header is gone from the wire.
      expect(headers?.amend).toBeUndefined();
    });

    it('surfaces the continuation trigger event id and run identity on the ActiveRun', async () => {
      const initial = await fix.session.view.sendInput({ kind: 'user-message', text: 'hi' });

      const cont = await fix.session.view.sendInput([{ kind: 'user-message', text: 'more' }], {
        runId: initial.runId,
      });

      expect(typeof cont.inputEventId).toBe('string');
      expect(cont.runId).toBe(initial.runId);
      expect(cont.invocationId).not.toBe(initial.invocationId);
    });

    it('stamps the continuation event-id on the publish and surfaces it on the ActiveRun', async () => {
      const initial = await fix.session.view.sendInput({ kind: 'user-message', text: 'hi' });
      const before = fix.codec.lastEncoder()?.publishCalls.length ?? 0;

      const cont = await fix.session.view.sendInput([{ kind: 'user-message', text: 'more' }], { runId: initial.runId });

      const enc = fix.codec.lastEncoder();
      const contPublish = enc?.publishCalls
        .slice(before)
        .find((c) => c.direction === 'input' && 'kind' in c.event && c.event.kind === 'user-message');
      const stampedId = contPublish?.opts?.extras?.headers?.['event-id'];
      expect(stampedId).toBeDefined();
      expect(cont.inputEventId).toBe(stampedId);
    });

    it('continuation publishes carry HEADER_RUN_CONTINUE=true while fresh sends do not', async () => {
      const fresh = await fix.session.view.sendInput({ kind: 'user-message', text: 'hi' });
      const enc = fix.codec.lastEncoder();
      const freshHeaders = enc?.publishCalls.at(-1)?.opts?.extras?.headers;
      expect(freshHeaders?.['run-continue']).toBeUndefined();

      await fix.session.view.sendInput([{ kind: 'user-message', text: 'more' }], { runId: fresh.runId });
      const contHeaders = enc?.publishCalls.at(-1)?.opts?.extras?.headers;
      expect(contHeaders?.['run-continue']).toBe('true');
    });

    it('rejects an empty send with no runId and no forkOf', async () => {
      await expect(fix.session.view.sendInput([])).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });
  });

  // -------------------------------------------------------------------------
  // send — failure paths
  // -------------------------------------------------------------------------

  describe('send failure paths', () => {
    it('rejects send if user-message publish fails (publish-leg failure)', async () => {
      const ch = createMockChannel();
      const codec = createMockCodec();
      // Force the next encoder's publish to throw
      const failingPublishCodec: MockCodec = {
        ...codec,
        createEncoder: vi.fn((w: ChannelWriter, o?: EncoderOptions) => {
          const enc = codec.createEncoder(w, o) as MockEncoder;
          enc.failPublishWith = new Ably.ErrorInfo('publish boom', 40000, 500);
          return enc;
        }),
      };
      const s = createClientSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: failingPublishCodec,
        clientId: 'client-1',
      });
      await s.connect();

      const errors: Ably.ErrorInfo[] = [];
      s.on('error', (e) => errors.push(e));

      await expect(s.view.sendInput({ kind: 'user-message', text: 'hi' })).rejects.toBeErrorInfoWithCode(
        ErrorCode.SessionSendFailed,
      );
      expect(errors.length).toBeGreaterThanOrEqual(1);
      await s.close();
    });

    it('translates a 401/403 publish to InsufficientCapability', async () => {
      const ch = createMockChannel();
      const codec = createMockCodec();
      const failingPublishCodec: MockCodec = {
        ...codec,
        createEncoder: vi.fn((w: ChannelWriter, o?: EncoderOptions) => {
          const enc = codec.createEncoder(w, o) as MockEncoder;
          enc.failPublishWith = new Ably.ErrorInfo('forbidden', 40160, 403);
          return enc;
        }),
      };
      const s = createClientSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: failingPublishCodec,
        clientId: 'client-1',
      });
      await s.connect();
      s.on('error', () => {
        /* consume */
      });

      await expect(s.view.sendInput({ kind: 'user-message', text: 'hi' })).rejects.toBeErrorInfoWithCode(
        ErrorCode.InsufficientCapability,
      );
      await s.close();
    });

    it('removes the optimistic tree node on publish-leg failure', async () => {
      const ch = createMockChannel();
      const codec = createMockCodec();
      const failingPublishCodec: MockCodec = {
        ...codec,
        createEncoder: vi.fn((w: ChannelWriter, o?: EncoderOptions) => {
          const enc = codec.createEncoder(w, o) as MockEncoder;
          enc.failPublishWith = new Ably.ErrorInfo('publish boom', 40000, 500);
          return enc;
        }),
      };
      const s = createClientSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: failingPublishCodec,
        clientId: 'client-1',
      });
      await s.connect();
      s.on('error', () => {
        /* consume */
      });

      await expect(s.view.sendInput({ kind: 'user-message', text: 'hi' })).rejects.toBeDefined();
      // Optimistic node removed since publish failed before any ack
      expect(s.tree.runs()).toHaveLength(0);
      await s.close();
    });
  });

  // -------------------------------------------------------------------------
  // run-start deadline
  // -------------------------------------------------------------------------

  describe('started', () => {
    it('send() resolves on publish without waiting for run-start', async () => {
      const ch = createMockChannel();
      const s = createClientSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: createMockCodec(),
        clientId: 'client-1',
      });
      await s.connect();
      // No run-start is ever simulated — send() must still resolve once the
      // input is published.
      const run = await s.view.sendInput({ kind: 'user-message', text: 'hi' });
      expect(typeof run.runId).toBe('string');
      await s.close();
    });

    it('run.started resolves when a matching run-start is delivered', async () => {
      const ch = createMockChannel();
      const codec = createMockCodec();
      const s = createClientSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec,
        clientId: 'client-1',
      });
      await s.connect();

      const run = await s.view.sendInput({ kind: 'user-message', text: 'hi' });
      await ackPendingSend(ch, codec);
      await expect(run.started).resolves.toBeUndefined();
      await s.close();
    });

    it('fresh send: run.started resolves by the triggering input codec-message-id, not the wire run-id / invocation-id', async () => {
      // The decoupling guarantee: a fresh send correlates run-start by the
      // codec-message-id it owned at send time. Here the run-start carries a
      // run-id and invocation-id that DIVERGE from what the client minted
      // (simulating an agent-minted runId), but the correct
      // input-codec-message-id — `started` must still resolve.
      const run = await fix.session.view.sendInput({ kind: 'user-message', text: 'hi' });
      const triggerCodecMessageId = run.optimisticCodecMessageIds.at(-1);
      expect(triggerCodecMessageId).toBeDefined();

      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'agent-minted-run-id',
          [HEADER_RUN_CLIENT_ID]: 'client-1',
          [HEADER_INVOCATION_ID]: 'unrelated-invocation-id',
          [HEADER_INPUT_CODEC_MESSAGE_ID]: triggerCodecMessageId ?? '',
        }),
      );

      await expect(run.started).resolves.toBeUndefined();
    });

    it('continuation: run.started resolves by the triggering input codec-message-id, like a fresh send', async () => {
      const initial = await fix.session.view.sendInput({ kind: 'user-message', text: 'hi' });
      const cont = await fix.session.view.sendInput([{ kind: 'user-message', text: 'more' }], {
        runId: initial.runId,
      });
      // A continuation is itself an input event with its own codec-message-id,
      // which the agent echoes back on the continuation run-start. Resolution
      // is by that id — identical to a fresh send, not the reused runId. The
      // run-start here carries a DIVERGENT runId to prove the runId is not the
      // match key for an input-bearing continuation.
      const triggerCodecMessageId = cont.optimisticCodecMessageIds.at(-1);
      expect(triggerCodecMessageId).toBeDefined();

      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'some-other-run-id',
          [HEADER_RUN_CLIENT_ID]: 'client-1',
          [HEADER_RUN_CONTINUE]: 'true',
          [HEADER_INPUT_CODEC_MESSAGE_ID]: triggerCodecMessageId ?? '',
        }),
      );

      await expect(cont.started).resolves.toBeUndefined();
    });

    it('empty-input continuation: run.started resolves on the continuation run-start by the reused run-id', async () => {
      // An empty-input continuation publishes no input event, so there is no
      // codec-message-id to key on — it resolves purely by the reused runId.
      const initial = await fix.session.view.sendInput({ kind: 'user-message', text: 'hi' });
      const cont = await fix.session.view.sendInput([], { runId: initial.runId });

      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: initial.runId,
          [HEADER_RUN_CLIENT_ID]: 'client-1',
          [HEADER_RUN_CONTINUE]: 'true',
        }),
      );

      await expect(cont.started).resolves.toBeUndefined();
    });

    it('does not resolve run.started for a run-start matching neither the trigger codec-message-id nor the runId', async () => {
      const run = await fix.session.view.sendInput({ kind: 'user-message', text: 'hi' });

      // A run-start belonging to an unrelated send — neither its
      // input-codec-message-id nor its runId matches this send's tracker — must
      // leave `started` pending (guards against over-resolution on the shared
      // tracker keyspace).
      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'unrelated-run-id',
          [HEADER_RUN_CLIENT_ID]: 'client-1',
          [HEADER_INPUT_CODEC_MESSAGE_ID]: 'unrelated-codec-message-id',
        }),
      );

      // simulateMessage is synchronous, so the run-start has already been
      // processed. Race `started` against an already-resolved sentinel: if
      // `started` is still pending, the sentinel wins.
      const pendingSentinel = Symbol('pending');
      const outcome = await Promise.race([
        run.started.then(
          () => 'resolved' as const,
          () => 'rejected' as const,
        ),
        Promise.resolve(pendingSentinel),
      ]);
      expect(outcome).toBe(pendingSentinel);
    });
  });

  // -------------------------------------------------------------------------
  // toInvocation — the run's developer-sendable pointer
  // -------------------------------------------------------------------------

  describe('toInvocation', () => {
    it('carries the run identity and the channel name as sessionName', async () => {
      const run = await fix.session.view.sendInput({ kind: 'user-message', text: 'hi' });
      const invocation = run.toInvocation();
      expect(invocation.runId).toBe(run.runId);
      expect(invocation.invocationId).toBe(run.invocationId);
      expect(invocation.inputEventId).toBe(run.inputEventId);
      // The fixture's session is bound to the 'test-channel' channel.
      expect(invocation.sessionName).toBe('test-channel');
    });

    it('serialises to the InvocationData wire shape the agent reads', async () => {
      const run = await fix.session.view.sendInput({ kind: 'user-message', text: 'hi' });
      expect(run.toInvocation().toJSON()).toEqual({
        runId: run.runId,
        invocationId: run.invocationId,
        inputEventId: run.inputEventId,
        sessionName: 'test-channel',
      });
    });
  });

  // -------------------------------------------------------------------------
  // Message routing — observer projection + own-run output events
  // -------------------------------------------------------------------------

  describe('message routing', () => {
    it('emits ably-message for any inbound message', () => {
      const events: Ably.InboundMessage[] = [];
      fix.session.tree.on('ably-message', (m) => events.push(m));

      simulateMessage(fix.channel, ablyMsg('some-event', { [HEADER_RUN_ID]: 'run-x' }));
      expect(events).toHaveLength(1);
    });

    it('emits run lifecycle events for run-start / run-end', () => {
      const lifecycle: RunLifecycleEvent[] = [];
      fix.session.tree.on('run', (e) => lifecycle.push(e));

      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-A',
          [HEADER_RUN_CLIENT_ID]: 'someone-else',
        }),
      );
      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_END, {
          [HEADER_RUN_ID]: 'run-A',
          [HEADER_RUN_CLIENT_ID]: 'someone-else',
          [HEADER_RUN_REASON]: 'complete',
        }),
      );

      expect(lifecycle).toHaveLength(2);
      expect(lifecycle[0]?.type).toBe(EVENT_RUN_START);
      expect(lifecycle[1]?.type).toBe(EVENT_RUN_END);
    });

    it('surfaces isContinuation on the run-start event when run-continue is set', () => {
      const lifecycle: RunLifecycleEvent[] = [];
      fix.session.tree.on('run', (e) => lifecycle.push(e));

      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-cont',
          [HEADER_RUN_CLIENT_ID]: 'agent',
          'run-continue': 'true',
        }),
      );
      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-fresh',
          [HEADER_RUN_CLIENT_ID]: 'agent',
        }),
      );

      const [cont, fresh] = lifecycle;
      expect(cont?.type).toBe(EVENT_RUN_START);
      if (cont?.type !== EVENT_RUN_START) throw new Error('expected run-start');
      expect(cont.isContinuation).toBe(true);
      if (fresh?.type !== EVENT_RUN_START) throw new Error('expected run-start');
      expect(fresh.isContinuation).toBeUndefined();
    });

    it('surfaces regenerates on the run-start event when msg-regenerate is set', () => {
      const lifecycle: RunLifecycleEvent[] = [];
      fix.session.tree.on('run', (e) => lifecycle.push(e));

      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-regen',
          [HEADER_RUN_CLIENT_ID]: 'agent',
          parent: 'orig-user',
          'msg-regenerate': 'orig-asst',
        }),
      );
      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-fresh',
          [HEADER_RUN_CLIENT_ID]: 'agent',
        }),
      );

      const [regen, fresh] = lifecycle;
      if (regen?.type !== EVENT_RUN_START) throw new Error('expected run-start');
      expect(regen.regenerates).toBe('orig-asst');
      expect(regen.parent).toBe('orig-user');
      expect(regen.forkOf).toBeUndefined();
      if (fresh?.type !== EVENT_RUN_START) throw new Error('expected run-start');
      expect(fresh.regenerates).toBeUndefined();
    });

    it('converges optimistic insert and echo into a single tree node when UIMessage.id differs from wire HEADER_CODEC_MESSAGE_ID', async () => {
      // Regression: under Vercel's codec the projection's UIMessage.id is the
      // domain id (codec-messageId, e.g. useChat's local id) while the wire
      // `codec-message-id` is the optimistic tree codecMessageId. The session must fold
      // the echo into the same Run the optimistic insert created (routed by
      // run-id) so the projection's message is updated in place — not
      // a second Run with a duplicate message in `view.getMessages()`.
      const ch = createMockChannel();
      const decoder = createMockDecoder();
      // Custom codec: classifier returns a message with a FIXED id; fold pushes
      // the message into the projection keyed by that fixed id (NOT meta.messageId).
      // Mirrors how the Vercel codec produces UIMessages with codec-messageId
      // as the id field rather than the wire's codec-message-id.
      const customCodec = createMockCodec(decoder);
      // CAST: the mock fold's parameters mirror the Codec.fold signature.
      customCodec.fold = vi.fn((state: TestProjection, event: TestInput | TestOutput, meta: ReducerMeta) => {
        state.foldedEvents.push({ event, meta });
        if ('kind' in event && event.kind === 'user-message') {
          // Use a fixed domain id derived from the text — independent of wireMsgId.
          // Mirrors the Vercel codec where UIMessage.id is the domain id, distinct
          // from the wire's codec-message-id.
          const text = event.text ?? event.message?.content ?? '';
          const domainId = `domain-${text}`;
          let msg = state.messages.find((m) => m.id === domainId);
          if (!msg) {
            msg = { id: domainId, content: text };
            state.messages.push(msg);
          }
          return state;
        }
        // For outputs, fall back to the keyed-by-meta.messageId shape of the default mock.
        if ('type' in event && event.type === 'text' && typeof event.text === 'string') {
          const id = meta.messageId ?? 'unknown';
          let msg = state.messages.find((m) => m.id === id);
          if (!msg) {
            msg = { id, content: '' };
            state.messages.push(msg);
          }
          msg.content += event.text;
        }
        return state;
      });
      const s = createClientSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: customCodec,
        clientId: 'client-1',
      });
      await s.connect();

      // Optimistic insert. The session mints a random tree codecMessageId; the
      // projection's UIMessage id is `domain-hi` (from our custom fold).
      await s.view.sendInput({ kind: 'user-message', text: 'hi' });
      const lastPublish = customCodec.lastEncoder()?.publishCalls.at(-1);
      const optimisticMsgId = lastPublish?.opts?.extras?.headers?.[HEADER_CODEC_MESSAGE_ID];
      const runId = lastPublish?.opts?.extras?.headers?.[HEADER_RUN_ID];
      expect(optimisticMsgId).toBeDefined();
      if (!optimisticMsgId) throw new Error('expected optimistic codecMessageId on publish');

      // Echo the wire message with the same tree codecMessageId so the optimistic
      // node converges. Queue the same user-message input for the decoder.
      decoder.inputQueue.push({ kind: 'user-message', text: 'hi' });
      simulateMessage(
        ch,
        ablyMsg(
          'text',
          {
            [HEADER_RUN_ID]: runId ?? '',
            [HEADER_RUN_CLIENT_ID]: 'client-1',
            [HEADER_ROLE]: 'user',
            [HEADER_CODEC_MESSAGE_ID]: optimisticMsgId,
          },
          undefined,
          'message.create',
        ),
      );

      // The tree must contain exactly one Run — the optimistic insert,
      // converged with the echo. The Run's projection holds a single
      // domain message keyed by the codec's domain-id convention.
      expect(s.tree.runs()).toHaveLength(1);
      const owningRun = s.tree.getRunByCodecMessageId(optimisticMsgId);
      expect(owningRun).toBeDefined();
      // customCodec.fold uses `domain-${text}` as the id (not the wire codecMessageId);
      // the projection has one entry under `domain-hi` for both the optimistic
      // fold and the echo fold (same id → upserted in place by the mock).
      if (!owningRun) throw new Error('expected owning run');
      const messages = customCodec.getMessages(owningRun.projection);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.id).toBe('domain-hi');
      expect(messages[0]?.content).toBe('hi');
      await s.close();
    });

    it('folds codec events into an observer projection (run from another client)', () => {
      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-A',
          [HEADER_RUN_CLIENT_ID]: 'someone-else',
        }),
      );

      // Queue a text event for the next decode call
      fix.decoder.queue.push({ type: 'text', text: 'hi' });
      simulateMessage(
        fix.channel,
        ablyMsg(
          'text',
          {
            [HEADER_RUN_ID]: 'run-A',
            [HEADER_RUN_CLIENT_ID]: 'someone-else',
            [HEADER_CODEC_MESSAGE_ID]: 'm-1',
          },
          undefined,
          'message.create',
        ),
      );

      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock check
      expect(fix.codec.fold).toHaveBeenCalled();
      const owningRun = fix.session.tree.getRunByCodecMessageId('m-1');
      expect(owningRun).toBeDefined();
      if (!owningRun) throw new Error('expected owning run');
      const messages = fix.codec.getMessages(owningRun.projection);
      const node = messages.find((m) => m.id === 'm-1');
      expect(node?.content).toBe('hi');
    });

    it('routes own-run output events to the Tree output event', async () => {
      const ch = createMockChannel();
      const decoder = createMockDecoder();
      const codec = createMockCodec(decoder);
      const s = createClientSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec,
        clientId: 'client-1',
      });
      await s.connect();

      const sendPromise = s.view.sendInput({ kind: 'user-message', text: 'hi' });
      const { runId, invocationId } = await ackPendingSend(ch, codec);
      await sendPromise;

      const outputs: TestOutput[] = [];
      s.tree.on('output', (e) => {
        if (e.runId === runId) outputs.push(...e.events);
      });

      // Decoded output events surface on the Tree's `output` event keyed by
      // runId (decoder is shared with the session — same instance returned
      // by codec.createDecoder()).
      decoder.queue.push({ type: 'text', text: 'pong' });
      simulateMessage(
        ch,
        ablyMsg('text', {
          [HEADER_RUN_ID]: runId,
          [HEADER_INVOCATION_ID]: invocationId,
          [HEADER_CODEC_MESSAGE_ID]: 'a-1',
        }),
      );
      decoder.queue.push({ type: 'finish' });
      simulateMessage(
        ch,
        ablyMsg('text', {
          [HEADER_RUN_ID]: runId,
          [HEADER_INVOCATION_ID]: invocationId,
          [HEADER_CODEC_MESSAGE_ID]: 'a-1',
        }),
      );

      expect(outputs.map((e) => e.type)).toEqual(['text', 'finish']);
      await s.close();
    });

    it('ignores chunks with no decoded events but still updates observer headers', () => {
      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-Z',
          [HEADER_RUN_CLIENT_ID]: 'other',
        }),
      );
      // decoder returns nothing — the message still drives observer init
      simulateMessage(
        fix.channel,
        ablyMsg('noop', {
          [HEADER_RUN_ID]: 'run-Z',
          [HEADER_RUN_CLIENT_ID]: 'other',
          [HEADER_CODEC_MESSAGE_ID]: 'm-z',
        }),
      );
      // fold should not have been called (no events)
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock check
      expect(fix.codec.fold).not.toHaveBeenCalled();
    });

    it('applies a run-end regardless of its invocation-id (no stale-invocation gate)', async () => {
      const ch = createMockChannel();
      const codec = createMockCodec();
      const s = createClientSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec,
        clientId: 'client-1',
      });
      await s.connect();

      const sendPromise = s.view.sendInput({ kind: 'user-message', text: 'hi' });
      const { runId } = await ackPendingSend(ch, codec);
      await sendPromise;

      // A run-end carrying an invocation-id that does NOT match the active
      // send still terminates the run — there is no gate that drops it.
      simulateMessage(
        ch,
        ablyMsg(EVENT_RUN_END, {
          [HEADER_RUN_ID]: runId,
          [HEADER_RUN_CLIENT_ID]: 'client-1',
          [HEADER_INVOCATION_ID]: 'some-other-inv',
          [HEADER_RUN_REASON]: 'complete',
        }),
      );

      // The run reaches a terminal state.
      expect(s.tree.getRunNode(runId)?.status).toBe('complete');
      await s.close();
    });

    it('continuation run reaches status=complete after a terminal output event mid-continuation', async () => {
      // Suspend → continue → terminal-output-event → run-end sequence. A
      // terminal output event (e.g. the Vercel codec's `finish`) does not
      // itself terminate the core Run — only the wire run-end does. The
      // continuation's run-end must still mark the Run complete; otherwise
      // the Run stays at status=active and the UI sticks on "streaming".
      const initial = await fix.session.view.sendInput({ kind: 'user-message', text: 'hi' });

      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_END, {
          [HEADER_RUN_ID]: initial.runId,
          [HEADER_RUN_CLIENT_ID]: 'client-1',
          [HEADER_INVOCATION_ID]: initial.invocationId,
          [HEADER_RUN_REASON]: 'suspended',
        }),
      );

      const continuation = await fix.session.view.sendInput([{ kind: 'user-message', text: 'continue' }], {
        runId: initial.runId,
      });

      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: initial.runId,
          [HEADER_RUN_CLIENT_ID]: 'client-1',
          [HEADER_INVOCATION_ID]: continuation.invocationId,
          'run-continue': 'true',
        }),
      );

      // A terminal output event arrives mid-continuation.
      fix.decoder.queue.push({ type: 'finish' });
      simulateMessage(
        fix.channel,
        ablyMsg('finish', {
          [HEADER_RUN_ID]: initial.runId,
          [HEADER_RUN_CLIENT_ID]: 'client-1',
          [HEADER_INVOCATION_ID]: continuation.invocationId,
          'run-continue': 'true',
        }),
      );

      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_END, {
          [HEADER_RUN_ID]: initial.runId,
          [HEADER_RUN_CLIENT_ID]: 'client-1',
          [HEADER_INVOCATION_ID]: continuation.invocationId,
          [HEADER_RUN_REASON]: 'complete',
        }),
      );

      // applyRunLifecycle marks the Run complete.
      expect(fix.session.tree.getRunNode(initial.runId)?.status).toBe('complete');
    });

    it('continuation run reaches status=complete live after suspended → continuation → complete sequence', async () => {
      // User-reported regression: after a tool-resolution / approval
      // continuation completes, the Run stays at status=active in the
      // live client even though channel-history replay rebuilds it as
      // status=complete. Repro the full sequence: first send →
      // run-end suspended → continuation send → run-end complete.
      // R1.status must end at the continuation's reason, otherwise the
      // UI stays stuck on "streaming".
      const initial = await fix.session.view.sendInput({ kind: 'user-message', text: 'hi' });

      // First invocation suspends (e.g. tool call awaiting client output).
      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_END, {
          [HEADER_RUN_ID]: initial.runId,
          [HEADER_RUN_CLIENT_ID]: 'client-1',
          [HEADER_INVOCATION_ID]: initial.invocationId,
          [HEADER_RUN_REASON]: 'suspended',
        }),
      );
      expect(fix.session.tree.getRunNode(initial.runId)?.status).toBe('suspended');

      // Continuation send under the same runId with a fresh invocation.
      const continuation = await fix.session.view.sendInput([{ kind: 'user-message', text: 'continue' }], {
        runId: initial.runId,
      });
      expect(continuation.invocationId).not.toBe(initial.invocationId);

      // Continuation's run-start (from agent) re-activates the run.
      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: initial.runId,
          [HEADER_RUN_CLIENT_ID]: 'client-1',
          [HEADER_INVOCATION_ID]: continuation.invocationId,
          'run-continue': 'true',
        }),
      );
      expect(fix.session.tree.getRunNode(initial.runId)?.status).toBe('active');

      // Continuation run-end (complete).
      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_END, {
          [HEADER_RUN_ID]: initial.runId,
          [HEADER_RUN_CLIENT_ID]: 'client-1',
          [HEADER_INVOCATION_ID]: continuation.invocationId,
          [HEADER_RUN_REASON]: 'complete',
        }),
      );

      // The continuation's run-end must apply — otherwise the Run stays
      // at status=active and any UI gating on Run status sticks on
      // "streaming" / shows "Stop" forever.
      expect(fix.session.tree.getRunNode(initial.runId)?.status).toBe('complete');
    });

    it('processes continuation run-end on an observer session', () => {
      // Observer-side continuation: the observer didn't send, so it has no
      // local record of the run beyond what it sees on the wire. The
      // continuation's terminal `run-end` must still be applied so the Run
      // reaches a terminal state rather than sticking at `active`.
      const inv1 = 'inv-original';
      const inv2 = 'inv-continuation';

      // Original run-start (inv1).
      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-obs',
          [HEADER_RUN_CLIENT_ID]: 'other-client',
          [HEADER_INVOCATION_ID]: inv1,
        }),
      );

      // Original suspends.
      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_END, {
          [HEADER_RUN_ID]: 'run-obs',
          [HEADER_RUN_CLIENT_ID]: 'other-client',
          [HEADER_INVOCATION_ID]: inv1,
          [HEADER_RUN_REASON]: 'suspended',
        }),
      );
      expect(fix.session.tree.getRunNode('run-obs')?.status).toBe('suspended');

      // Continuation run-start (inv2) — agent resumes after tool-output.
      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-obs',
          [HEADER_RUN_CLIENT_ID]: 'other-client',
          [HEADER_INVOCATION_ID]: inv2,
          'run-continue': 'true',
        }),
      );
      expect(fix.session.tree.getRunNode('run-obs')?.status).toBe('active');

      // Continuation completes.
      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_END, {
          [HEADER_RUN_ID]: 'run-obs',
          [HEADER_RUN_CLIENT_ID]: 'other-client',
          [HEADER_INVOCATION_ID]: inv2,
          [HEADER_RUN_REASON]: 'complete',
        }),
      );

      // The continuation's run-end is applied and the Run reaches a
      // terminal state.
      expect(fix.session.tree.getRunNode('run-obs')?.status).toBe('complete');
    });

    it('processes a continuation run-end carrying a fresh invocation', async () => {
      // A continuation reuses the runId under a fresh invocation. The
      // continuation's run-end is applied and the run cleans up.
      const initial = await fix.session.view.sendInput({ kind: 'user-message', text: 'hi' });
      const continuation = await fix.session.view.sendInput([{ kind: 'user-message', text: 'more' }], {
        runId: initial.runId,
      });
      expect(continuation.invocationId).not.toBe(initial.invocationId);

      const runEnds: RunLifecycleEvent[] = [];
      fix.session.tree.on('run', (e) => {
        if (e.type === EVENT_RUN_END) runEnds.push(e);
      });

      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_END, {
          [HEADER_RUN_ID]: initial.runId,
          [HEADER_RUN_CLIENT_ID]: 'client-1',
          [HEADER_INVOCATION_ID]: continuation.invocationId,
          [HEADER_RUN_REASON]: 'complete',
        }),
      );

      expect(runEnds).toHaveLength(1);
      expect(runEnds[0]?.runId).toBe(initial.runId);
    });
  });

  // -------------------------------------------------------------------------
  // Same-run message routing — successive wire messages routed by HEADER_CODEC_MESSAGE_ID
  // -------------------------------------------------------------------------

  describe('same-run message routing', () => {
    it('routes a follow-up message into the same run projection via meta.messageId', () => {
      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-A',
          [HEADER_RUN_CLIENT_ID]: 'other',
        }),
      );

      // Initial assistant text on msg m-1 — fold sees meta.messageId === 'm-1'
      fix.decoder.queue.push({ type: 'text', text: 'first' });
      simulateMessage(
        fix.channel,
        ablyMsg('text', {
          [HEADER_RUN_ID]: 'run-A',
          [HEADER_RUN_CLIENT_ID]: 'other',
          [HEADER_CODEC_MESSAGE_ID]: 'm-1',
        }),
      );

      // Follow-up message targeting m-1 from the SAME run — encoder stamps
      // HEADER_CODEC_MESSAGE_ID = 'm-1', so the reducer folds with meta.messageId === 'm-1'.
      fix.decoder.queue.push({ type: 'text', text: '-extended' });
      simulateMessage(
        fix.channel,
        ablyMsg('text', {
          [HEADER_RUN_ID]: 'run-A',
          [HEADER_RUN_CLIENT_ID]: 'other',
          [HEADER_CODEC_MESSAGE_ID]: 'm-1',
        }),
      );

      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.mocked accessor
      const calls = vi.mocked(fix.codec.fold).mock.calls;
      expect(calls).toHaveLength(2);
      // CAST: tuple shape comes from vi.mocked
      const firstCall = calls[0] as unknown as [TestProjection, TestEvent, ReducerMeta];
      const secondCall = calls[1] as unknown as [TestProjection, TestEvent, ReducerMeta];
      // Both events routed under HEADER_CODEC_MESSAGE_ID = 'm-1'
      expect(firstCall[2].messageId).toBe('m-1');
      expect(secondCall[2].messageId).toBe('m-1');
      // Both folded into the SAME projection (observer for run-A)
      expect(firstCall[0]).toBe(secondCall[0]);
    });

    it('folds events into the projection of the run named on the wire (per-run isolation)', () => {
      // Run-start for run-A (observer projection bound to run-A)
      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-A',
          [HEADER_RUN_CLIENT_ID]: 'other',
        }),
      );
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.mocked accessor
      const projectionsBefore = vi.mocked(fix.codec.init).mock.calls.length;
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.mocked accessor
      const foldsBefore = vi.mocked(fix.codec.fold).mock.calls.length;

      // A wire message carrying HEADER_RUN_ID: 'run-B' arrives. The session
      // routes by HEADER_RUN_ID — it folds into run-B's (new) projection,
      // never into run-A's.
      fix.decoder.queue.push({ type: 'text', text: 'cross-run' });
      simulateMessage(
        fix.channel,
        ablyMsg('text', {
          [HEADER_RUN_ID]: 'run-B',
          [HEADER_RUN_CLIENT_ID]: 'other',
          [HEADER_CODEC_MESSAGE_ID]: 'm-1',
        }),
      );

      // A fresh projection was created for run-B (one extra init call).
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.mocked accessor
      expect(vi.mocked(fix.codec.init).mock.calls.length).toBeGreaterThan(projectionsBefore);
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.mocked accessor
      const foldCalls = vi.mocked(fix.codec.fold).mock.calls;
      expect(foldCalls.length).toBeGreaterThan(foldsBefore);
      // The new fold targeted run-B's projection (not run-A's).
      // CAST: tuple shape comes from vi.mocked.
      const lastFold = foldCalls.at(-1) as unknown as [TestProjection, TestEvent, ReducerMeta];
      expect(lastFold[2].messageId).toBe('m-1');
    });
  });

  // -------------------------------------------------------------------------
  // cancel
  // -------------------------------------------------------------------------

  describe('cancel', () => {
    it('publishes a cancel message carrying run-id', async () => {
      await fix.session.cancel('run-1');
      const cancelMsg = fix.channel.publishCalls.find((m) => m.name === 'ai-cancel');
      expect(cancelMsg).toBeDefined();
      const headers = (cancelMsg?.extras as { ai?: { transport?: Record<string, string> } } | undefined)?.ai?.transport;
      expect(headers?.[HEADER_RUN_ID]).toBe('run-1');
    });

    it('cancel is a no-op after close', async () => {
      await fix.session.close();
      await expect(fix.session.cancel('run-x')).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // close
  // -------------------------------------------------------------------------

  describe('close', () => {
    it('is idempotent', async () => {
      await fix.session.close();
      await expect(fix.session.close()).resolves.toBeUndefined();
    });

    it('unsubscribes from the channel', async () => {
      await fix.session.close();
      expect(fix.channel.unsubscribe).toHaveBeenCalled();
    });

    it('closes the shared encoder', async () => {
      // Trigger creation of the shared encoder by sending
      await fix.session.view.sendInput({ kind: 'user-message', text: 'hi' });
      const enc = fix.codec.lastEncoder();
      expect(enc).toBeDefined();
      await fix.session.close();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock check
      expect(enc?.close).toHaveBeenCalled();
    });

    it('does not publish any cancel messages on close()', async () => {
      await fix.session.close();
      const cancelMsgs = fix.channel.publishCalls.filter((m) => m.name === 'ai-cancel');
      expect(cancelMsgs).toHaveLength(0);
    });

    it('rejects in-flight run.started promises with SessionClosed', async () => {
      const ch = createMockChannel();
      const codec = createMockCodec();
      const s = createClientSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec,
        clientId: 'client-1',
      });
      await s.connect();
      s.on('error', () => {
        /* consume */
      });

      // send() resolves on publish; run.started stays pending until run-start
      // (which never arrives here) or close.
      const run = await s.view.sendInput({ kind: 'user-message', text: 'hi' });
      const rejection = expect(run.started).rejects.toBeErrorInfoWithCode(ErrorCode.SessionClosed);
      await s.close();
      await rejection;
    });
  });

  // -------------------------------------------------------------------------
  // error handler isolation
  // -------------------------------------------------------------------------

  describe('error handler isolation', () => {
    it('one throwing handler does not prevent the others from firing', () => {
      const calls: string[] = [];
      fix.session.on('error', () => {
        calls.push('a');
        throw new Error('boom');
      });
      fix.session.on('error', () => {
        calls.push('b');
      });

      // Simulate a mid-run agent error: run-start followed by run-end with
      // reason `error`. The error-end fires the session error event, which
      // is what the handler-isolation assertion observes.
      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-error',
          [HEADER_RUN_CLIENT_ID]: 'other',
        }),
      );
      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_END, {
          [HEADER_RUN_ID]: 'run-error',
          [HEADER_RUN_CLIENT_ID]: 'other',
          [HEADER_RUN_REASON]: 'error',
          [HEADER_ERROR_CODE]: String(ErrorCode.SessionSubscriptionError),
          [HEADER_ERROR_MESSAGE]: 'oops',
        }),
      );
      expect(calls).toEqual(['a', 'b']);
    });
  });

  // -------------------------------------------------------------------------
  // channel continuity
  // -------------------------------------------------------------------------

  describe('channel continuity', () => {
    it.each([['failed' as const], ['suspended' as const], ['detached' as const]])(
      'emits ChannelContinuityLost when channel transitions to %s',
      (state) => {
        // Mark initial attach observed
        simulateStateChange(fix.channel, {
          current: 'attached',
          previous: 'attaching',
          resumed: false,
        });

        const errors: Ably.ErrorInfo[] = [];
        fix.session.on('error', (e) => errors.push(e));
        simulateStateChange(fix.channel, {
          current: state,
          previous: 'attached',
          resumed: false,
        });
        // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison -- compare against enum value
        expect(errors.some((e) => e.code === ErrorCode.ChannelContinuityLost)).toBe(true);
      },
    );

    it('emits ChannelContinuityLost on re-attach with resumed: false', () => {
      simulateStateChange(fix.channel, {
        current: 'attached',
        previous: 'attaching',
        resumed: false,
      });

      const errors: Ably.ErrorInfo[] = [];
      fix.session.on('error', (e) => errors.push(e));
      simulateStateChange(fix.channel, {
        current: 'attached',
        previous: 'attaching',
        resumed: false,
      });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison -- compare against enum value
      expect(errors.some((e) => e.code === ErrorCode.ChannelContinuityLost)).toBe(true);
    });

    it('does not emit on the initial attach when channel started detached', async () => {
      // Use a channel that starts in 'initialized' state so the session
      // treats the first attached transition as the initial attach.
      const ch = createMockChannel();
      ch.state = 'initialized';
      const s = createClientSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: createMockCodec(),
        clientId: 'client-1',
      });
      await s.connect();
      const errors: Ably.ErrorInfo[] = [];
      s.on('error', (e) => errors.push(e));
      simulateStateChange(ch, {
        current: 'attached',
        previous: 'attaching',
        resumed: false,
      });
      expect(errors).toHaveLength(0);
      await s.close();
    });
  });

  // -------------------------------------------------------------------------
  // regenerate / edit
  // -------------------------------------------------------------------------

  describe('regenerate', () => {
    it('throws when the target node is unknown', async () => {
      await expect(fix.session.view.regenerate('missing-msg')).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // regenerate events (wire-only publish path)
  // -------------------------------------------------------------------------

  describe('regenerate events', () => {
    it('publishes a regenerate input without upserting the tree or folding the projection', async () => {
      // Seed a user message in the tree first.
      await fix.session.view.sendInput({ kind: 'user-message', text: 'hi' });
      const runsBefore = fix.session.tree.runs();
      expect(runsBefore).toHaveLength(1);
      const seedRunId = runsBefore[0]?.runId;
      const userMsgId = fix.session.view.getMessages()[0]?.id;
      expect(userMsgId).toBeDefined();
      if (!userMsgId) throw new Error('expected user message id');

      // Send a regenerate input — wire-only, carries parent/target on headers.
      await fix.session.view.sendInput({
        kind: 'regenerate',
        parent: userMsgId,
        target: 'asst-1',
      });

      // No new Run materialised: the regenerate publishes wire-only and
      // skips both tree-upsert and projection fold. The original Run is
      // unchanged.
      const runsAfter = fix.session.tree.runs();
      expect(runsAfter).toHaveLength(1);
      expect(runsAfter[0]?.runId).toBe(seedRunId);

      // The regenerate input was published on the channel with correct headers.
      const enc = fix.codec.lastEncoder();
      const regeneratePublish = enc?.publishCalls.find(
        (c) => c.direction === 'input' && 'kind' in c.event && c.event.kind === 'regenerate',
      );
      expect(regeneratePublish).toBeDefined();
      const headers = regeneratePublish?.opts?.extras?.headers;
      expect(headers?.[HEADER_ROLE]).toBe('user');
      expect(headers?.[HEADER_PARENT]).toBe(userMsgId);
      // Regenerate stamps `msg-regenerate` (not `fork-of`):
      // the new Run is a continuation of the prior Run, not a Run-level fork.
      expect(headers?.['msg-regenerate']).toBe('asst-1');
      expect(headers?.[HEADER_FORK_OF]).toBeUndefined();
      expect(headers?.[HEADER_EVENT_ID]).toBeDefined();
      expect(headers?.[HEADER_CODEC_MESSAGE_ID]).toBeDefined();
    });

    it('mints a fresh event-id for the regenerate input and surfaces it on the ActiveRun', async () => {
      const run = await fix.session.view.sendInput({
        kind: 'regenerate',
        parent: 'u1',
        target: 'asst-1',
      });

      expect(typeof run.inputEventId).toBe('string');

      const enc = fix.codec.lastEncoder();
      const regeneratePublish = enc?.publishCalls.find(
        (c) => c.direction === 'input' && 'kind' in c.event && c.event.kind === 'regenerate',
      );
      const inputEventId = regeneratePublish?.opts?.extras?.headers?.[HEADER_EVENT_ID];
      expect(run.inputEventId).toBe(inputEventId);
    });
  });

  describe('edit', () => {
    it('throws when the target node is unknown', async () => {
      await expect(fix.session.view.edit('missing-msg', { kind: 'user-message', text: 'replaced' })).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // run-end cleanup
  // -------------------------------------------------------------------------

  describe('run-end cleanup', () => {
    it('clears observer projection on run-end', () => {
      // Drive an observer projection then send run-end
      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-E',
          [HEADER_RUN_CLIENT_ID]: 'other',
        }),
      );

      fix.decoder.queue.push({ type: 'text', text: 'hi' });
      simulateMessage(
        fix.channel,
        ablyMsg('text', {
          [HEADER_RUN_ID]: 'run-E',
          [HEADER_RUN_CLIENT_ID]: 'other',
          [HEADER_CODEC_MESSAGE_ID]: 'm-e',
        }),
      );

      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_END, {
          [HEADER_RUN_ID]: 'run-E',
          [HEADER_RUN_CLIENT_ID]: 'other',
          [HEADER_RUN_REASON]: 'complete',
        }),
      );

      // After run-end, a new event for the same run won't re-fold (observer cleared)
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.mocked accessor
      const foldCallsBefore = vi.mocked(fix.codec.fold).mock.calls.length;
      fix.decoder.queue.push({ type: 'text', text: 'late' });
      simulateMessage(
        fix.channel,
        ablyMsg('text', {
          [HEADER_RUN_ID]: 'run-E',
          [HEADER_RUN_CLIENT_ID]: 'other',
          [HEADER_CODEC_MESSAGE_ID]: 'm-e2',
        }),
      );
      // A new observer projection was created (one extra init); fold ran.
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.mocked accessor
      expect(vi.mocked(fix.codec.fold).mock.calls.length).toBeGreaterThan(foldCallsBefore);
    });
  });
});
