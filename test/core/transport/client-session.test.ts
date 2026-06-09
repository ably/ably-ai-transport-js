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
  EVENT_RUN_RESUME,
  EVENT_RUN_START,
  EVENT_RUN_SUSPEND,
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
 * well-known {@link UserMessage} shape; `regenerate` carries a `target` so
 * the session reads it as the `msg-regenerate` anchor. Edits are not a
 * distinct input — they are a `user-message` published with the `forkOf`
 * send option.
 */
type TestInput =
  | ({ kind: 'user-message'; text?: string; message?: TestMessage } & CodecInputEvent)
  | ({ kind: 'regenerate'; target: string; parent: string } & CodecInputEvent);

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
  detach: ReturnType<typeof vi.fn>;
  history: ReturnType<typeof vi.fn>;
  state: Ably.ChannelState;
  listener: ((msg: Ably.InboundMessage) => void) | undefined;
  stateListeners: Set<Ably.channelEventCallback>;
  /** Sentinel presence object — asserted by identity via `session.presence`. */
  presence: Ably.RealtimePresence;
}

const createMockChannel = (): MockChannel & Ably.RealtimeChannel => {
  const stateListeners = new Set<Ably.channelEventCallback>();
  const mock: MockChannel = {
    listener: undefined,
    stateListeners,
    state: 'attached',
    publishCalls: [],
    // CAST: only identity is asserted in tests; presence methods are unused here.
    presence: { get: vi.fn(), enter: vi.fn(), leave: vi.fn() } as unknown as Ably.RealtimePresence,
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
    detach: vi.fn(() => Promise.resolve()),
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
    cancelStreams: vi.fn(() => Promise.resolve()),
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
    getMessages: vi.fn((p: TestProjection) => p.messages.map((m) => ({ codecMessageId: m.id, message: m }))),
    createUserMessage: vi.fn((m: TestMessage) => ({ kind: 'user-message' as const, message: m })),
    createRegenerate: vi.fn(
      (target: string, parent: string) => ({ kind: 'regenerate' as const, target, parent }) as const,
    ),
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
  // Wait for an encoder.publish() call and ack the LATEST one so sequential
  // sends (fresh send → continuation) each ack their own trigger. The latest
  // publish's codec-message-id is the trigger whose key the run's `runId`
  // promise resolves on.
  let publishedHeaders: Record<string, string> | undefined;
  for (let i = 0; i < 100; i++) {
    const enc = codec.lastEncoder();
    if (enc && enc.publishCalls.length > 0) {
      const opts = enc.publishCalls.at(-1)?.opts;
      publishedHeaders = opts?.extras?.headers;
      if (publishedHeaders) break;
    }
    await Promise.resolve();
  }
  if (!publishedHeaders) throw new Error('no user-message publish observed');

  const codecMessageId = publishedHeaders[HEADER_CODEC_MESSAGE_ID] ?? '';
  // A continuation's published input carries a run-id on the wire; a fresh send
  // does not. Mirror the agent's decision: run-id present => re-enter the run.
  const isContinuation = publishedHeaders[HEADER_RUN_ID] !== undefined;
  // Fresh sends carry NO run-id on the wire — the agent mints it on run-start.
  // A continuation reuses the run-id the client passed via options.runId, which
  // it stamps on the continuation input wire. Mirror that here.
  const runId = publishedHeaders[HEADER_RUN_ID] ?? `run-${codecMessageId}`;
  // The agent mints the invocation-id per request — the input carries none.
  // Mint a distinct one here (keyed by the triggering codec-message-id) so
  // sequential acks under the same runId produce different invocation-ids,
  // mirroring the agent.
  const invocationId = `inv-${codecMessageId}`;
  // Mirror the agent: a continuation (the input carried a wire run-id) re-enters
  // the run via ai-run-resume; a fresh send opens it via ai-run-start. Both
  // thread the triggering input's codec-message-id back as
  // `input-codec-message-id`, the handle the client's `started` resolves on.
  simulateMessage(
    channel,
    ablyMsg(isContinuation ? EVENT_RUN_RESUME : EVENT_RUN_START, {
      [HEADER_RUN_ID]: runId,
      [HEADER_RUN_CLIENT_ID]: 'client-1',
      [HEADER_INVOCATION_ID]: invocationId,
      [HEADER_INPUT_CODEC_MESSAGE_ID]: codecMessageId,
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
    client: createMockClient(channel, overrides?.clientId ?? 'client-1'),
    channelName: 'test-channel',
    codec,
  });
  await session.connect();
  return { channel, decoder, codec, session };
};

/**
 * Read the transport headers off the first `ai-cancel` message a mock channel
 * recorded, or undefined if none was published.
 * @param channel - The mock channel that captured publishes.
 * @returns The cancel message's transport headers, or undefined.
 */
const cancelHeadersOf = (channel: MockChannel): Record<string, string> | undefined => {
  const cancelMsg = channel.publishCalls.find((m) => m.name === 'ai-cancel');
  return (cancelMsg?.extras as { ai?: { transport?: Record<string, string> } } | undefined)?.ai?.transport;
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
  // presence pass-through
  // -------------------------------------------------------------------------

  describe('presence', () => {
    it("returns the underlying channel's presence object", () => {
      expect(fix.session.presence).toBe(fix.channel.presence);
    });

    it('is available before connect() is called', () => {
      const ch = createMockChannel();
      const s = createClientSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: createMockCodec(),
      });
      expect(s.presence).toBe(ch.presence);
    });
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
      await expect(s.view.send({ kind: 'user-message', text: 'hi' })).rejects.toBeErrorInfoWithCode(
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
      // CAST: assign through MockChannel's loose mock type — RealtimeChannel.subscribe's
      // overloads reject vi.fn's inferred signature under ably >= 2.22.
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.reject directly
      (ch as MockChannel).subscribe = vi.fn(() => Promise.reject(new Ably.ErrorInfo('subscribe failed', 40000, 400)));
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
      expect(messages.map((m) => m.message.content)).toEqual(['first', 'second']);
      // Seeds are run-less user INPUT nodes in the two-node model — they carry
      // no run-id (the agent mints reply run-ids), so they surface as input
      // nodes, not as reply runs in view.runs() (which is reply-run-shaped).
      // The session assigns each seed a codec-message-id, which the mock codec
      // stamps as the rendered message id.
      expect(s.view.runs()).toHaveLength(0);
      const id1 = messages[0]?.codecMessageId;
      const id2 = messages[1]?.codecMessageId;
      expect(id1).toBeDefined();
      expect(id2).toBeDefined();
      const seed1 = id1 === undefined ? undefined : s.tree.getNodeByCodecMessageId(id1);
      const seed2 = id2 === undefined ? undefined : s.tree.getNodeByCodecMessageId(id2);
      expect(seed1?.kind).toBe('input');
      expect(seed2?.kind).toBe('input');
      // Subsequent seeds chain off the prior one via the structural parent.
      expect(seed2?.parentCodecMessageId).toBe(id1);
      await s.close();
    });
  });

  // -------------------------------------------------------------------------
  // send — happy path
  // -------------------------------------------------------------------------

  describe('send', () => {
    it('returns an ActiveRun with a synchronous inputCodecMessageId, runId promise and cancel', async () => {
      const run = await fix.session.view.send({ kind: 'user-message', text: 'hi' });
      // The agent mints the run-id, so it is a promise; the synchronous routing
      // key (the triggering input's codec-message-id) is known immediately.
      expect(typeof run.inputCodecMessageId).toBe('string');
      expect(run.runId).toBeInstanceOf(Promise);
      expect(typeof run.cancel).toBe('function');
    });

    it('inserts an optimistic user message into the tree', async () => {
      await fix.session.view.send({ kind: 'user-message', text: 'hello' });
      const messages = fix.session.view.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]?.message.content).toBe('hello');
    });

    it('publishes the user-message TInput on the channel via encoder.publishInput with transport headers', async () => {
      const before = fix.codec.lastEncoder()?.publishCalls.length ?? 0;
      await fix.session.view.send({ kind: 'user-message', text: 'hello' });

      const enc = fix.codec.lastEncoder();
      expect(enc).toBeDefined();
      expect((enc?.publishCalls.length ?? 0) - before).toBe(1);

      const call = enc?.publishCalls.at(-1);
      expect(call?.direction).toBe('input');
      expect(call?.event && 'kind' in call.event ? call.event.kind : undefined).toBe('user-message');
      const opts = call?.opts;
      expect(opts?.messageId).toBeDefined();
      // A fresh send carries NO run-id on the wire — the agent mints it on
      // run-start (the client no longer mints one).
      expect(opts?.extras?.headers?.[HEADER_RUN_ID]).toBeUndefined();
      // `ai-input` events do not carry `invocation-id` — the agent mints it
      // per HTTP request, not the client at send time.
      expect(opts?.extras?.headers?.[HEADER_INVOCATION_ID]).toBeUndefined();
      expect(opts?.extras?.headers?.[HEADER_ROLE]).toBe('user');
      expect(opts?.extras?.headers?.['event-id']).toBeDefined();
      // `ai-input` events do not carry `input-client-id` — the wire
      // publisher's Ably `clientId` already conveys that on the input event
      // itself. The agent re-stamps it on its own subsequent publishes.
      expect(opts?.extras?.headers?.['input-client-id']).toBeUndefined();
    });

    it('stamps run-client-id on published input from the Ably client auth.clientId', async () => {
      // The session takes its identity from the Ably client's `auth.clientId`,
      // read at publish time (guaranteed populated because send() awaits
      // connect(), which only resolves after CONNECTED).
      const channel = createMockChannel();
      const codec = createMockCodec(createMockDecoder());
      const session = createClientSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(channel, 'client-9'),
        channelName: 'test-channel',
        codec,
      });
      await session.connect();

      await session.view.send({ kind: 'user-message', text: 'hi' });

      const call = codec.lastEncoder()?.publishCalls.at(-1);
      expect(call?.opts?.extras?.headers?.[HEADER_RUN_CLIENT_ID]).toBe('client-9');
      await session.close();
    });

    it('omits run-client-id when the connection has no concrete identity', async () => {
      // An anonymous connection (no clientId) or a wildcard `*` token has no
      // single identity to attribute the run to, so no run-client-id is stamped.
      for (const clientId of [undefined, '*']) {
        const channel = createMockChannel();
        const codec = createMockCodec(createMockDecoder());
        const session = createClientSession<TestInput, TestOutput, TestProjection, TestMessage>({
          client: createMockClient(channel, clientId),
          channelName: 'test-channel',
          codec,
        });
        await session.connect();

        await session.view.send({ kind: 'user-message', text: 'hi' });

        const call = codec.lastEncoder()?.publishCalls.at(-1);
        expect(call?.opts?.extras?.headers?.[HEADER_RUN_CLIENT_ID]).toBeUndefined();
        await session.close();
      }
    });

    it('pins the wire codec-message-id from TInput.codecMessageId instead of minting a fresh id', async () => {
      // Each TInput carries its routing fields directly via the
      // {@link CodecInputEvent} base. When `codecMessageId` is set, the
      // session stamps that value on the wire `codec-message-id`
      // header instead of minting a UUID. For a fresh user-message this
      // pins the message's own id (the TMessage.id == wire id convention);
      // for a continuation input it targets the assistant being amended.
      await fix.session.view.send([
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
      // (the path a `view.send(codec.createUserMessage(...))` with a
      // caller-supplied id takes) must still fold into the local projection
      // synchronously. Treating the
      // presence of `codecMessageId` as "wire-only" suppressed the optimistic
      // fold, so the user bubble only appeared once the publish echoed back
      // off the channel — a round-trip race that flaked integration tests.
      await fix.session.view.send({
        kind: 'user-message',
        text: 'hello',
        codecMessageId: 'pinned-id',
      });

      // No channel echo simulated — the message must be present purely from
      // the optimistic fold. The fresh send's optimistic insert is a run-less
      // user INPUT node keyed by its codec-message-id; there is no reply run
      // until the agent's run-start, so view.runs() (reply-run-shaped) is empty.
      expect(fix.session.view.runs()).toHaveLength(0);
      const inputNode = fix.session.tree.getNodeByCodecMessageId('pinned-id');
      expect(inputNode?.kind).toBe('input');

      const messages = fix.session.view.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]?.message.id).toBe('pinned-id');
      expect(messages[0]?.message.content).toBe('hello');
    });

    it('mints a distinct event-id per user-message; ActiveRun.inputEventId is the last (primary trigger)', async () => {
      const run = await fix.session.view.send([
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

      // The seed's codec-message-id is the rendered message id (the mock codec
      // stamps the session-assigned codec-message-id onto TMessage.id).
      const seedCodecMessageId = seeded.view.getMessages()[0]?.codecMessageId;
      expect(seedCodecMessageId).toBeDefined();
      const run = await seeded.view.send({ kind: 'user-message', text: 'next' });

      // The seed and the fresh send are both run-less user INPUT nodes; the new
      // send's optimistic input node must be parented at the seed's
      // codec-message-id (auto-computed from the last visible message).
      expect(run.optimisticCodecMessageIds).toHaveLength(1);
      const newCodecMessageId = run.optimisticCodecMessageIds[0];
      const newNode =
        newCodecMessageId === undefined ? undefined : seeded.tree.getNodeByCodecMessageId(newCodecMessageId);
      expect(newNode?.kind).toBe('input');
      expect(newNode?.parentCodecMessageId).toBe(seedCodecMessageId);
      await seeded.close();
    });

    it('chains multi-message sends in a thread', async () => {
      await fix.session.view.send([
        { kind: 'user-message', text: 'first' },
        { kind: 'user-message', text: 'second' },
      ]);
      // Both messages land in the same Run's projection (one Run per send).
      const messages = fix.session.view.getMessages();
      expect(messages).toHaveLength(2);
      expect(messages[0]?.message.content).toBe('first');
      expect(messages[1]?.message.content).toBe('second');

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
      await fix.session.view.send({ kind: 'user-message', text: 'hi' }, { forkOf: 'msg-original' });
      const enc = fix.codec.lastEncoder();
      const headers = enc?.publishCalls.at(-1)?.opts?.extras?.headers;
      expect(headers?.['fork-of']).toBe('msg-original');
    });

    it('throws when session is closed', async () => {
      await fix.session.close();
      // View error wrapping: the view rejects with its "view is closed" error.
      await expect(fix.session.view.send({ kind: 'user-message', text: 'hi' })).rejects.toThrow();
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
        await expect(fix.session.view.send({ kind: 'user-message', text: 'hi' })).rejects.toBeErrorInfoWithCode(
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
      const run = await fix.session.view.send({ kind: 'user-message', text: 'hi' });
      // The agent mints the run-id, so it is a promise; the send-resolved-on-
      // publish guarantee is observable via the synchronous routing key.
      expect(typeof run.inputCodecMessageId).toBe('string');
    });
  });

  // -------------------------------------------------------------------------
  // send — continuation (options.runId reuses the suspended run)
  // -------------------------------------------------------------------------

  describe('send — continuation', () => {
    it('reuses the runId for a continuation', async () => {
      await fix.session.view.send({ kind: 'user-message', text: 'hi' });
      // The agent mints the run-id on run-start; learn it before continuing.
      const { runId } = await ackPendingSend(fix.channel, fix.codec);

      const cont = await fix.session.view.send([{ kind: 'user-message', text: 'more' }], { runId });
      // The continuation resume echoes the reused run-id back.
      await ackPendingSend(fix.channel, fix.codec);

      await expect(cont.runId).resolves.toBe(runId);
    });

    it('publishes the continuation user-message with HEADER_RUN_ID', async () => {
      await fix.session.view.send({ kind: 'user-message', text: 'hi' });
      const { runId } = await ackPendingSend(fix.channel, fix.codec);
      const enc = fix.codec.lastEncoder();
      // Drop the initial publish from the call count
      const baseCalls = enc?.publishCalls.length ?? 0;

      await fix.session.view.send([{ kind: 'user-message', text: 'more' }], { runId });

      const newCalls = (enc?.publishCalls.length ?? 0) - baseCalls;
      expect(newCalls).toBe(1);
      const call = enc?.publishCalls.at(-1);
      expect(call?.direction).toBe('input');
      expect(call?.event && 'kind' in call.event ? call.event.kind : undefined).toBe('user-message');
      const headers = call?.opts?.extras?.headers;
      expect(headers?.[HEADER_RUN_ID]).toBe(runId);
      // The continuation input carries no invocation-id — the agent mints one
      // per HTTP request when it wakes for the continuation.
      expect(headers?.[HEADER_INVOCATION_ID]).toBeUndefined();
      // Continuation user-messages publish as role:'user'.
      expect(headers?.[HEADER_ROLE]).toBe('user');
      // No amend header — the old amend header is gone from the wire.
      expect(headers?.amend).toBeUndefined();
    });

    it('surfaces the continuation trigger event id and run identity on the ActiveRun', async () => {
      await fix.session.view.send({ kind: 'user-message', text: 'hi' });
      const { runId } = await ackPendingSend(fix.channel, fix.codec);

      const cont = await fix.session.view.send([{ kind: 'user-message', text: 'more' }], { runId });
      await ackPendingSend(fix.channel, fix.codec);

      expect(typeof cont.inputEventId).toBe('string');
      await expect(cont.runId).resolves.toBe(runId);
    });

    it('stamps the continuation event-id on the publish and surfaces it on the ActiveRun', async () => {
      await fix.session.view.send({ kind: 'user-message', text: 'hi' });
      const { runId } = await ackPendingSend(fix.channel, fix.codec);
      const before = fix.codec.lastEncoder()?.publishCalls.length ?? 0;

      const cont = await fix.session.view.send([{ kind: 'user-message', text: 'more' }], { runId });

      const enc = fix.codec.lastEncoder();
      const contPublish = enc?.publishCalls
        .slice(before)
        .find((c) => c.direction === 'input' && 'kind' in c.event && c.event.kind === 'user-message');
      const stampedId = contPublish?.opts?.extras?.headers?.['event-id'];
      expect(stampedId).toBeDefined();
      expect(cont.inputEventId).toBe(stampedId);
    });

    it('continuation publishes carry HEADER_RUN_ID while fresh sends do not', async () => {
      await fix.session.view.send({ kind: 'user-message', text: 'hi' });
      const enc = fix.codec.lastEncoder();
      const freshHeaders = enc?.publishCalls.at(-1)?.opts?.extras?.headers;
      // Fresh sends carry no run-id on the wire — the agent mints it.
      expect(freshHeaders?.[HEADER_RUN_ID]).toBeUndefined();
      const { runId } = await ackPendingSend(fix.channel, fix.codec);

      await fix.session.view.send([{ kind: 'user-message', text: 'more' }], { runId });
      const contHeaders = enc?.publishCalls.at(-1)?.opts?.extras?.headers;
      // The continuation stamps the reused run-id on the wire — this is what
      // signals the agent to re-enter the run via ai-run-resume.
      expect(contHeaders?.[HEADER_RUN_ID]).toBe(runId);
    });

    it('rejects an empty send (no inputs to publish)', async () => {
      await expect(fix.session.view.send([])).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
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
      });
      await s.connect();

      const errors: Ably.ErrorInfo[] = [];
      s.on('error', (e) => errors.push(e));

      await expect(s.view.send({ kind: 'user-message', text: 'hi' })).rejects.toBeErrorInfoWithCode(
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
      });
      await s.connect();
      s.on('error', () => {
        /* consume */
      });

      await expect(s.view.send({ kind: 'user-message', text: 'hi' })).rejects.toBeErrorInfoWithCode(
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
      });
      await s.connect();
      s.on('error', () => {
        /* consume */
      });

      await expect(s.view.send({ kind: 'user-message', text: 'hi' })).rejects.toBeDefined();
      // Optimistic node removed since publish failed before any ack
      expect(s.view.runs()).toHaveLength(0);
      await s.close();
    });
  });

  // -------------------------------------------------------------------------
  // run-start deadline
  // -------------------------------------------------------------------------

  describe('runId resolution', () => {
    it('send() resolves on publish without waiting for run-start', async () => {
      const ch = createMockChannel();
      const s = createClientSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: createMockCodec(),
      });
      await s.connect();
      // No run-start is ever simulated — send() must still resolve once the
      // input is published. The run-id is a promise (agent-minted); the
      // synchronous routing key proves the handle is usable immediately.
      const run = await s.view.send({ kind: 'user-message', text: 'hi' });
      expect(typeof run.inputCodecMessageId).toBe('string');
      await s.close();
    });

    it('run.runId resolves to the agent-minted id when a matching run-start is delivered', async () => {
      const ch = createMockChannel();
      const codec = createMockCodec();
      const s = createClientSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec,
      });
      await s.connect();

      const run = await s.view.send({ kind: 'user-message', text: 'hi' });
      const { runId } = await ackPendingSend(ch, codec);
      await expect(run.runId).resolves.toBe(runId);
      await s.close();
    });

    it('fresh send: run.runId resolves by the triggering input codec-message-id, with the agent-minted run-id', async () => {
      // The decoupling guarantee: a fresh send correlates run-start by the
      // codec-message-id it owned at send time. The agent mints the run-id; the
      // client learns it via the run-start's input-codec-message-id match, even
      // though the client never minted a run-id of its own.
      const run = await fix.session.view.send({ kind: 'user-message', text: 'hi' });
      const triggerCodecMessageId = run.optimisticCodecMessageIds.at(-1);
      expect(triggerCodecMessageId).toBeDefined();

      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'agent-minted-run-id',
          [HEADER_RUN_CLIENT_ID]: 'client-1',
          [HEADER_INVOCATION_ID]: 'agent-minted-invocation-id',
          [HEADER_INPUT_CODEC_MESSAGE_ID]: triggerCodecMessageId ?? '',
        }),
      );

      await expect(run.runId).resolves.toBe('agent-minted-run-id');
    });

    it('continuation: run.runId resolves on a run-resume by the triggering input codec-message-id', async () => {
      // Once the agent emits ai-run-resume for a continuation, the
      // continuation's run-id resolves on the resume — keyed by the same
      // triggering input codec-message-id as a run-start would be.
      await fix.session.view.send({ kind: 'user-message', text: 'hi' });
      const { runId } = await ackPendingSend(fix.channel, fix.codec);
      const cont = await fix.session.view.send([{ kind: 'user-message', text: 'more' }], { runId });
      const triggerCodecMessageId = cont.optimisticCodecMessageIds.at(-1);
      expect(triggerCodecMessageId).toBeDefined();

      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_RESUME, {
          [HEADER_RUN_ID]: runId,
          [HEADER_RUN_CLIENT_ID]: 'client-1',
          [HEADER_INPUT_CODEC_MESSAGE_ID]: triggerCodecMessageId ?? '',
        }),
      );

      await expect(cont.runId).resolves.toBe(runId);
    });

    it('rejects an empty-input continuation — only new input continues a run', async () => {
      // A continuation reuses an existing run-id but must still carry a new
      // input event (a tool-result or approval). An empty input array is
      // rejected even when a run-id is supplied.
      await fix.session.view.send({ kind: 'user-message', text: 'hi' });
      const { runId } = await ackPendingSend(fix.channel, fix.codec);
      await expect(fix.session.view.send([], { runId })).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });

    it('does not resolve run.runId for a run-start matching neither the trigger codec-message-id nor the runId', async () => {
      const run = await fix.session.view.send({ kind: 'user-message', text: 'hi' });

      // A run-start belonging to an unrelated send — neither its
      // input-codec-message-id nor its runId matches this send's tracker — must
      // leave the run-id promise pending (guards against over-resolution on the
      // shared tracker keyspace).
      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'unrelated-run-id',
          [HEADER_RUN_CLIENT_ID]: 'client-1',
          [HEADER_INPUT_CODEC_MESSAGE_ID]: 'unrelated-codec-message-id',
        }),
      );

      // simulateMessage is synchronous, so the run-start has already been
      // processed. Race the run-id promise against an already-resolved
      // sentinel: if it is still pending, the sentinel wins.
      const pendingSentinel = Symbol('pending');
      const outcome = await Promise.race([
        run.runId.then(
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
      const run = await fix.session.view.send({ kind: 'user-message', text: 'hi' });
      const invocation = run.toInvocation();
      // The pointer carries no run-id (run identity lives on the channel) —
      // only the input-event-id and the session name.
      expect(invocation.inputEventId).toBe(run.inputEventId);
      // The fixture's session is bound to the 'test-channel' channel.
      expect(invocation.sessionName).toBe('test-channel');
    });

    it('serialises to the InvocationData wire shape the agent reads', async () => {
      const run = await fix.session.view.send({ kind: 'user-message', text: 'hi' });
      // Fresh send: no run-id in the wire pointer (the agent mints it).
      expect(run.toInvocation().toJSON()).toEqual({
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
      expect(lifecycle[0]?.type).toBe('start');
      expect(lifecycle[1]?.type).toBe('end');
    });

    it('emits a suspend lifecycle event and keeps the run live on run-suspend', () => {
      const lifecycle: RunLifecycleEvent[] = [];
      fix.session.tree.on('run', (e) => lifecycle.push(e));

      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-S',
          [HEADER_RUN_CLIENT_ID]: 'agent',
        }),
      );
      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_SUSPEND, {
          [HEADER_RUN_ID]: 'run-S',
          [HEADER_RUN_CLIENT_ID]: 'agent',
          [HEADER_INVOCATION_ID]: 'inv-1',
        }),
      );

      expect(lifecycle).toHaveLength(2);
      expect(lifecycle[1]?.type).toBe('suspend');
      // The run stays in the tree, marked suspended — a continuation that
      // reuses the runId resumes it.
      expect(fix.session.tree.getRunNode('run-S')?.status).toBe('suspended');
    });

    it('re-activates a suspended run on run-resume', () => {
      const lifecycle: RunLifecycleEvent[] = [];
      fix.session.tree.on('run', (e) => lifecycle.push(e));

      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_START, { [HEADER_RUN_ID]: 'run-R', [HEADER_RUN_CLIENT_ID]: 'agent' }),
      );
      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_SUSPEND, {
          [HEADER_RUN_ID]: 'run-R',
          [HEADER_RUN_CLIENT_ID]: 'agent',
          [HEADER_INVOCATION_ID]: 'inv-1',
        }),
      );
      expect(fix.session.tree.getRunNode('run-R')?.status).toBe('suspended');

      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_RESUME, {
          [HEADER_RUN_ID]: 'run-R',
          [HEADER_RUN_CLIENT_ID]: 'agent',
          [HEADER_INVOCATION_ID]: 'inv-2',
        }),
      );

      expect(lifecycle.at(-1)?.type).toBe('resume');
      expect(fix.session.tree.getRunNode('run-R')?.status).toBe('active');
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
      if (regen?.type !== 'start') throw new Error('expected run-start');
      expect(regen.regenerates).toBe('orig-asst');
      expect(regen.parent).toBe('orig-user');
      expect(regen.forkOf).toBeUndefined();
      if (fresh?.type !== 'start') throw new Error('expected run-start');
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
      });
      await s.connect();

      // Optimistic insert. The session mints a random tree codecMessageId; the
      // projection's UIMessage id is `domain-hi` (from our custom fold).
      await s.view.send({ kind: 'user-message', text: 'hi' });
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
      expect(s.view.runs()).toHaveLength(1);
      const owningRun = s.tree.getNodeByCodecMessageId(optimisticMsgId);
      expect(owningRun).toBeDefined();
      // customCodec.fold uses `domain-${text}` as the id (not the wire codecMessageId);
      // the projection has one entry under `domain-hi` for both the optimistic
      // fold and the echo fold (same id → upserted in place by the mock).
      if (!owningRun) throw new Error('expected owning run');
      const messages = customCodec.getMessages(owningRun.projection);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.message.id).toBe('domain-hi');
      expect(messages[0]?.message.content).toBe('hi');
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
      const owningRun = fix.session.tree.getNodeByCodecMessageId('m-1');
      expect(owningRun).toBeDefined();
      if (!owningRun) throw new Error('expected owning run');
      const messages = fix.codec.getMessages(owningRun.projection);
      const node = messages.find((m) => m.codecMessageId === 'm-1')?.message;
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
      });
      await s.connect();

      const sendPromise = s.view.send({ kind: 'user-message', text: 'hi' });
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
      });
      await s.connect();

      const sendPromise = s.view.send({ kind: 'user-message', text: 'hi' });
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
      await fix.session.view.send({ kind: 'user-message', text: 'hi' });
      // The agent mints the run-id on run-start; learn it (and create the run
      // node) before suspending it.
      const { runId } = await ackPendingSend(fix.channel, fix.codec);

      // Agent mints distinct invocation-ids per HTTP request.
      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_SUSPEND, {
          [HEADER_RUN_ID]: runId,
          [HEADER_RUN_CLIENT_ID]: 'client-1',
          [HEADER_INVOCATION_ID]: 'inv-1',
        }),
      );

      await fix.session.view.send([{ kind: 'user-message', text: 'continue' }], { runId });

      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_RESUME, {
          [HEADER_RUN_ID]: runId,
          [HEADER_RUN_CLIENT_ID]: 'client-1',
          [HEADER_INVOCATION_ID]: 'inv-2',
        }),
      );

      // A terminal output event arrives mid-continuation.
      fix.decoder.queue.push({ type: 'finish' });
      simulateMessage(
        fix.channel,
        ablyMsg('finish', {
          [HEADER_RUN_ID]: runId,
          [HEADER_RUN_CLIENT_ID]: 'client-1',
          [HEADER_INVOCATION_ID]: 'inv-2',
        }),
      );

      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_END, {
          [HEADER_RUN_ID]: runId,
          [HEADER_RUN_CLIENT_ID]: 'client-1',
          [HEADER_INVOCATION_ID]: 'inv-2',
          [HEADER_RUN_REASON]: 'complete',
        }),
      );

      // applyRunLifecycle marks the Run complete.
      expect(fix.session.tree.getRunNode(runId)?.status).toBe('complete');
    });

    it('continuation run reaches status=complete live after suspended → continuation → complete sequence', async () => {
      // User-reported regression: after a tool-resolution / approval
      // continuation completes, the Run stays at status=active in the
      // live client even though channel-history replay rebuilds it as
      // status=complete. Repro the full sequence: first send →
      // run-suspend → continuation send → run-end complete.
      // R1.status must end at the continuation's reason, otherwise the
      // UI stays stuck on "streaming".
      await fix.session.view.send({ kind: 'user-message', text: 'hi' });
      const { runId } = await ackPendingSend(fix.channel, fix.codec);

      // First invocation suspends (e.g. tool call awaiting client output).
      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_SUSPEND, {
          [HEADER_RUN_ID]: runId,
          [HEADER_RUN_CLIENT_ID]: 'client-1',
          [HEADER_INVOCATION_ID]: 'inv-1',
        }),
      );
      expect(fix.session.tree.getRunNode(runId)?.status).toBe('suspended');

      // Continuation send under the same runId; the agent mints a fresh
      // invocation-id when it wakes for the continuation.
      await fix.session.view.send([{ kind: 'user-message', text: 'continue' }], { runId });

      // Continuation's run-resume (from agent) re-activates the run.
      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_RESUME, {
          [HEADER_RUN_ID]: runId,
          [HEADER_RUN_CLIENT_ID]: 'client-1',
          [HEADER_INVOCATION_ID]: 'inv-2',
        }),
      );
      expect(fix.session.tree.getRunNode(runId)?.status).toBe('active');

      // Continuation run-end (complete).
      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_END, {
          [HEADER_RUN_ID]: runId,
          [HEADER_RUN_CLIENT_ID]: 'client-1',
          [HEADER_INVOCATION_ID]: 'inv-2',
          [HEADER_RUN_REASON]: 'complete',
        }),
      );

      // The continuation's run-end must apply — otherwise the Run stays
      // at status=active and any UI gating on Run status sticks on
      // "streaming" / shows "Stop" forever.
      expect(fix.session.tree.getRunNode(runId)?.status).toBe('complete');
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
        ablyMsg(EVENT_RUN_SUSPEND, {
          [HEADER_RUN_ID]: 'run-obs',
          [HEADER_RUN_CLIENT_ID]: 'other-client',
          [HEADER_INVOCATION_ID]: inv1,
        }),
      );
      expect(fix.session.tree.getRunNode('run-obs')?.status).toBe('suspended');

      // Continuation run-resume (inv2) — agent resumes after tool-output.
      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_RESUME, {
          [HEADER_RUN_ID]: 'run-obs',
          [HEADER_RUN_CLIENT_ID]: 'other-client',
          [HEADER_INVOCATION_ID]: inv2,
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
      await fix.session.view.send({ kind: 'user-message', text: 'hi' });
      const { runId } = await ackPendingSend(fix.channel, fix.codec);
      await fix.session.view.send([{ kind: 'user-message', text: 'more' }], { runId });

      const runEnds: RunLifecycleEvent[] = [];
      fix.session.tree.on('run', (e) => {
        if (e.type === 'end') runEnds.push(e);
      });

      // The continuation's run-end carries the agent-minted invocation-id.
      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_END, {
          [HEADER_RUN_ID]: runId,
          [HEADER_RUN_CLIENT_ID]: 'client-1',
          [HEADER_INVOCATION_ID]: 'inv-continuation',
          [HEADER_RUN_REASON]: 'complete',
        }),
      );

      expect(runEnds).toHaveLength(1);
      expect(runEnds[0]?.runId).toBe(runId);
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
      const headers = cancelHeadersOf(fix.channel);
      expect(headers?.[HEADER_RUN_ID]).toBe('run-1');
    });

    it('stamps an event-id on the cancel so rewind can redeliver it to a late agent', async () => {
      await fix.session.cancel('run-1');
      const headers = cancelHeadersOf(fix.channel);
      expect(headers?.[HEADER_EVENT_ID]).toBeDefined();
    });

    it('run.cancel() on a fresh send publishes synchronously by the input codec-message-id (no run-id yet)', async () => {
      // A fresh send has no run-id until the agent mints it on run-start, so
      // run.cancel() keys the cancel by the triggering input's
      // codec-message-id (= run.inputCodecMessageId) without awaiting run.runId.
      const run = await fix.session.view.send({ kind: 'user-message', text: 'hi' });
      await run.cancel();
      const headers = cancelHeadersOf(fix.channel);
      expect(headers?.[HEADER_INPUT_CODEC_MESSAGE_ID]).toBe(run.inputCodecMessageId);
      // No run-id was ever minted client-side for a fresh send.
      expect(headers?.[HEADER_RUN_ID]).toBeUndefined();
      expect(headers?.[HEADER_EVENT_ID]).toBeDefined();
    });

    it('run.cancel() on a continuation carries both the run-id and the input codec-message-id', async () => {
      const run = await fix.session.view.send({ kind: 'user-message', text: 'cont' }, { runId: 'run-cont' });
      await run.cancel();
      const headers = cancelHeadersOf(fix.channel);
      expect(headers?.[HEADER_RUN_ID]).toBe('run-cont');
      expect(headers?.[HEADER_INPUT_CODEC_MESSAGE_ID]).toBe(run.inputCodecMessageId);
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
      expect(fix.channel.detach).toHaveBeenCalledTimes(1);
    });

    it('unsubscribes from the channel', async () => {
      await fix.session.close();
      expect(fix.channel.unsubscribe).toHaveBeenCalled();
    });

    it('detaches the channel it attached', async () => {
      await fix.session.close();
      expect(fix.channel.detach).toHaveBeenCalledTimes(1);
    });

    it('does not close the injected client', async () => {
      const ch = createMockChannel();
      const client = createMockClient(ch);
      // Attach a spy so the assertion proves the SDK never calls client.close():
      // the client is injected and the caller owns its lifecycle.
      // CAST: the mock client is a plain object; add a close spy for the assertion.
      const close = vi.fn();
      (client as unknown as { close: () => void }).close = close;
      const s = createClientSession<TestInput, TestOutput, TestProjection, TestMessage>({
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
      const s = createClientSession<TestInput, TestOutput, TestProjection, TestMessage>({
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
      const s = createClientSession<TestInput, TestOutput, TestProjection, TestMessage>({
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

    it('closes the shared encoder', async () => {
      // Trigger creation of the shared encoder by sending
      await fix.session.view.send({ kind: 'user-message', text: 'hi' });
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

    it('rejects in-flight run.runId promises with SessionClosed', async () => {
      const ch = createMockChannel();
      const codec = createMockCodec();
      const s = createClientSession<TestInput, TestOutput, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec,
      });
      await s.connect();
      s.on('error', () => {
        /* consume */
      });

      // send() resolves on publish; run.runId stays pending until run-start
      // (which never arrives here) or close.
      const run = await s.view.send({ kind: 'user-message', text: 'hi' });
      const rejection = expect(run.runId).rejects.toBeErrorInfoWithCode(ErrorCode.SessionClosed);
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
      // Seed a user message in the tree first. A fresh user-message send is a
      // run-less INPUT node — no reply run exists yet (the agent mints it).
      await fix.session.view.send({ kind: 'user-message', text: 'hi' });
      expect(fix.session.view.runs()).toHaveLength(0);
      const userMsgId = fix.session.view.getMessages()[0]?.codecMessageId;
      expect(userMsgId).toBeDefined();
      if (!userMsgId) throw new Error('expected user message id');
      const inputNodeBefore = fix.session.tree.getNodeByCodecMessageId(userMsgId);
      expect(inputNodeBefore?.kind).toBe('input');

      // Send a regenerate input — wire-only, carries parent/target on headers.
      await fix.session.view.send({
        kind: 'regenerate',
        parent: userMsgId,
        target: 'asst-1',
      });

      // No new node materialised: the regenerate publishes wire-only and
      // skips both tree-upsert and projection fold. The original input node is
      // unchanged and still no reply run exists.
      expect(fix.session.view.runs()).toHaveLength(0);
      expect(fix.session.tree.getNodeByCodecMessageId(userMsgId)?.kind).toBe('input');

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
      const run = await fix.session.view.send({
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
