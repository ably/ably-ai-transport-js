/**
 * ClientSession unit tests.
 *
 * Rewritten against the event-sourced `Codec<TEvent, TProjection, TMessage>`
 * contract — mock encoder uses single-method `publish`, mock decoder returns
 * `TEvent[]`, and projection state is folded via `init`/`fold`/`getMessages`.
 *
 * Retired surfaces (`stageEvents`, `stageMessage`, `view.update`,
 * `createAccumulator`, cross-run amend, codec amend classification)
 * are gone — the suite covers connect, send, regenerate, edit, cancel,
 * waitForRun, run lifecycle, observer routing, optimistic relay,
 * channel state, continuation tool-resolutions, and close.
 */

import * as Ably from 'ably';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EVENT_ERROR,
  EVENT_RUN_END,
  EVENT_RUN_START,
  HEADER_CANCEL_ALL,
  HEADER_CANCEL_CLIENT_ID,
  HEADER_CANCEL_INVOCATION_ID,
  HEADER_CANCEL_OWN,
  HEADER_CANCEL_RUN_ID,
  HEADER_FORK_OF,
  HEADER_INVOCATION_ID,
  HEADER_MSG_ID,
  HEADER_PARENT,
  HEADER_PROMPT_ID,
  HEADER_ROLE,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_ID,
  HEADER_RUN_REASON,
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
import { createClientSession } from '../../../src/core/transport/client-session.js';
import type { ClientSession, RunLifecycleEvent } from '../../../src/core/transport/types.js';
import { ErrorCode } from '../../../src/errors.js';
import { createMockClient } from '../../helper/mock-client.js';

// ---------------------------------------------------------------------------
// Test event / projection / message shapes
// ---------------------------------------------------------------------------

interface TestEvent {
  type: string;
  text?: string;
  /** Tool call id, present on tool-resolution-shaped TestEvents. */
  toolCallId?: string;
  /** `x-ably-parent` for regenerate-shaped TestEvents. */
  parent?: string;
  /** `x-ably-fork-of` for regenerate-shaped TestEvents. */
  forkOf?: string;
}

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
// Mock fetch
// ---------------------------------------------------------------------------

interface MockFetch {
  fn: ReturnType<typeof vi.fn>;
  calls: { url: string; init: RequestInit }[];
  /** Wait until n fetch calls have been recorded. */
  waitForCalls(n: number): Promise<void>;
  /** Get the parsed JSON body of the nth call (0-based). */
  body(index: number): Record<string, unknown>;
}

const createMockFetch = (status = 200): MockFetch => {
  const calls: { url: string; init: RequestInit }[] = [];
  let callResolvers: (() => void)[] = [];

  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const fn = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    calls.push({ url: urlStr, init: init ?? {} });
    for (const resolver of callResolvers) resolver();
    callResolvers = [];
    return Promise.resolve(new Response(undefined, { status, statusText: status === 200 ? 'OK' : 'Bad Request' }));
  });

  return {
    fn: fn as unknown as ReturnType<typeof vi.fn>,
    calls,
    waitForCalls: async (n: number) => {
      while (calls.length < n) {
        await new Promise<void>((resolve) => {
          callResolvers.push(resolve);
        });
      }
    },
    body: (index: number) => {
      const call = calls[index];
      if (!call) throw new Error(`no fetch call at index ${String(index)}`);
      return JSON.parse(call.init.body as string) as Record<string, unknown>;
    },
  };
};

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
    extras: { headers },
    serial: serial ?? nextSerial(),
  }) as unknown as Ably.InboundMessage;

// ---------------------------------------------------------------------------
// Mock codec (new event-sourced contract)
// ---------------------------------------------------------------------------

interface MockEncoder extends Encoder<TestEvent> {
  publishCalls: { event: TestEvent; opts: WriteOptions | undefined }[];
  /** Set to a non-null Error to make subsequent publish() reject. */
  failPublishWith: Error | undefined;
}

interface MockDecoder extends Decoder<TestEvent> {
  /** Queue of events to return on the next decode() call. */
  queue: TestEvent[];
}

interface MockCodec extends Codec<TestEvent, TestProjection, TestMessage> {
  encoders: MockEncoder[];
  /** Most recent encoder created via `createEncoder`. */
  lastEncoder(): MockEncoder | undefined;
}

const createMockEncoder = (): MockEncoder => {
  const calls: { event: TestEvent; opts: WriteOptions | undefined }[] = [];
  const enc: MockEncoder = {
    publishCalls: calls,
    failPublishWith: undefined,
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

const createMockDecoder = (): MockDecoder => {
  const queue: TestEvent[] = [];
  return {
    queue,
    decode: vi.fn(() => {
      const out = [...queue];
      queue.length = 0;
      return out;
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
      // The mock fold treats `text` events with a `text` payload as message
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
    }),
    getMessages: vi.fn((p: TestProjection) => p.messages),
    userMessageEvent: vi.fn((m: TestMessage): TestEvent => ({ type: 'user-message', text: m.content })),
    createRegenerateEvent: vi.fn((): TestEvent => ({ type: 'user-message' })),
    classifyEvent: vi.fn((event: TestEvent) => {
      if (event.type === 'user-message') {
        return { kind: 'user-message' as const, message: { id: '', content: event.text ?? '' } };
      }
      // `tool-resolution` is a synthetic test event that mirrors how the
      // Vercel codec classifies continuation tool resolutions: as a
      // `user-message` whose TMessage is duck-typed as a tool resolution
      // (role:'user' + dynamic-tool part in a resolution state) so the
      // session's `_isToolResolutionMessage` heuristic matches.
      if (event.type === 'tool-resolution') {
        // CAST: TestMessage is a flat shape, but the session's
        // `_isToolResolutionMessage` duck-types the TMessage as a UIMessage
        // for tool resolutions. The cast lets us synthesise that shape.
        const toolMessage = {
          id: '',
          content: '',
          role: 'user' as const,
          parts: [
            {
              type: 'dynamic-tool',
              toolCallId: event.toolCallId ?? '',
              toolName: '',
              state: 'output-available',
              input: undefined,
            },
          ],
        } as unknown as TestMessage;
        return { kind: 'user-message' as const, message: toolMessage };
      }
      if (event.type === 'regenerate-event') {
        return {
          kind: 'regenerate' as const,
          parent: event.parent ?? '',
          forkOf: event.forkOf ?? '',
        };
      }
      return { kind: 'other' as const };
    }),
    // eslint-disable-next-line unicorn/no-useless-undefined -- vi.fn requires an explicit return matching the codec contract
    resolveToolTarget: vi.fn(() => undefined),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- writer/options unused by stub
    createEncoder: vi.fn((_writer: ChannelWriter, _opts?: EncoderOptions) => {
      const enc = createMockEncoder();
      encoders.push(enc);
      return enc;
    }),
    createDecoder: vi.fn(() => decoder ?? createMockDecoder()),
    isTerminal: vi.fn((e: TestEvent) => e.type === 'finish'),
  };
  return codec;
};

// ---------------------------------------------------------------------------
// Run-start helper — simulates the agent acknowledging an invocation
// ---------------------------------------------------------------------------

/**
 * Wait for at least one user-message publish, then simulate the matching
 * agent run-start so a pending send() can resolve. Returns the simulated
 * runId / invocationId / msgId triple.
 *
 * Use when the test creates a session with `runStartDeadlineMs > 0` (the
 * default). Tests that don't care about the wait can construct the session
 * with `runStartDeadlineMs: 0`.
 * @param channel - Mock channel.
 * @param codec - Mock codec.
 * @returns The published msgId/runId/invocationId.
 */
const ackPendingSend = async (
  channel: MockChannel,
  codec: MockCodec,
): Promise<{ runId: string; invocationId: string; msgId: string }> => {
  // Wait for an encoder.publish() call (the user-message)
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
  const msgId = publishedHeaders[HEADER_MSG_ID] ?? '';
  simulateMessage(
    channel,
    ablyMsg(EVENT_RUN_START, {
      [HEADER_RUN_ID]: runId,
      [HEADER_RUN_CLIENT_ID]: 'client-1',
      [HEADER_INVOCATION_ID]: invocationId,
    }),
  );
  return { runId, invocationId, msgId };
};

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

const drain = async <T>(stream: ReadableStream<T>): Promise<T[]> => {
  const reader = stream.getReader();
  const results: T[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    results.push(value);
  }
  return results;
};

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((resolve) => {
      queueMicrotask(resolve);
    });
  }
};

interface SessionFixture {
  channel: MockChannel & Ably.RealtimeChannel;
  decoder: MockDecoder;
  codec: MockCodec;
  fetch: MockFetch;
  session: ClientSession<TestEvent, TestProjection, TestMessage>;
}

const createFixture = async (overrides?: {
  api?: string;
  clientId?: string;
  runStartDeadlineMs?: number;
  fetchStatus?: number;
}): Promise<SessionFixture> => {
  const channel = createMockChannel();
  const decoder = createMockDecoder();
  const codec = createMockCodec(decoder);
  const fetchMock = createMockFetch(overrides?.fetchStatus ?? 200);
  const session = createClientSession<TestEvent, TestProjection, TestMessage>({
    client: createMockClient(channel),
    channelName: 'test-channel',
    codec,
    clientId: overrides?.clientId ?? 'client-1',
    api: overrides?.api ?? '/api/chat',
    fetch: fetchMock.fn as unknown as typeof globalThis.fetch,
    runStartDeadlineMs: overrides?.runStartDeadlineMs ?? 0,
  });
  await session.connect();
  return { channel, decoder, codec, fetch: fetchMock, session };
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
      const s = createClientSession<TestEvent, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: createMockCodec(),
        api: '/api/chat',
        fetch: createMockFetch().fn as unknown as typeof globalThis.fetch,
        runStartDeadlineMs: 0,
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
      const s = createClientSession<TestEvent, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: createMockCodec(),
        api: '/api/chat',
        fetch: createMockFetch().fn as unknown as typeof globalThis.fetch,
        runStartDeadlineMs: 0,
      });
      await expect(s.view.sendEvent({ type: 'user-message', text: 'hi' })).rejects.toBeErrorInfoWithCode(
        ErrorCode.InvalidArgument,
      );
      await s.close();
    });

    it('cancel() throws InvalidArgument before connect()', async () => {
      const ch = createMockChannel();
      const s = createClientSession<TestEvent, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: createMockCodec(),
        api: '/api/chat',
        fetch: createMockFetch().fn as unknown as typeof globalThis.fetch,
        runStartDeadlineMs: 0,
      });
      await expect(s.cancel()).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
      await s.close();
    });

    it('waitForRun() throws InvalidArgument before connect()', async () => {
      const ch = createMockChannel();
      const s = createClientSession<TestEvent, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: createMockCodec(),
        api: '/api/chat',
        fetch: createMockFetch().fn as unknown as typeof globalThis.fetch,
        runStartDeadlineMs: 0,
      });
      await expect(s.waitForRun()).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
      await s.close();
    });

    it('rejects connect when subscribe fails', async () => {
      const ch = createMockChannel();
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.reject directly
      ch.subscribe = vi.fn(() => Promise.reject(new Ably.ErrorInfo('subscribe failed', 40000, 400)));
      const s = createClientSession<TestEvent, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: createMockCodec(),
        api: '/api/chat',
        fetch: createMockFetch().fn as unknown as typeof globalThis.fetch,
        runStartDeadlineMs: 0,
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
      const s = createClientSession<TestEvent, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: createMockCodec(),
        api: '/api/chat',
        messages: [
          { id: 'seed-1', content: 'first' },
          { id: 'seed-2', content: 'second' },
        ],
        fetch: createMockFetch().fn as unknown as typeof globalThis.fetch,
        runStartDeadlineMs: 0,
      });
      await s.connect();

      const nodes = s.view.flattenNodes();
      expect(nodes.map((n) => n.message.content)).toEqual(['first', 'second']);
      // Subsequent nodes chain off the prior one.
      expect(nodes[1]?.headers[HEADER_PARENT]).toBe(nodes[0]?.msgId);
      await s.close();
    });
  });

  // -------------------------------------------------------------------------
  // send — happy path
  // -------------------------------------------------------------------------

  describe('send', () => {
    it('returns an ActiveRun with stream, runId, invocationId, cancel', async () => {
      const run = await fix.session.view.sendEvent({ type: 'user-message', text: 'hi' });
      expect(run.stream).toBeInstanceOf(ReadableStream);
      expect(typeof run.runId).toBe('string');
      expect(typeof run.invocationId).toBe('string');
      expect(typeof run.cancel).toBe('function');
    });

    it('inserts an optimistic user message into the tree', async () => {
      await fix.session.view.sendEvent({ type: 'user-message', text: 'hello' });
      const messages = fix.session.view.flattenNodes().map((n) => n.message);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.content).toBe('hello');
    });

    it('publishes the user-message TEvent on the channel via encoder.publish with transport headers', async () => {
      const before = fix.codec.lastEncoder()?.publishCalls.length ?? 0;
      await fix.session.view.sendEvent({ type: 'user-message', text: 'hello' });

      const enc = fix.codec.lastEncoder();
      expect(enc).toBeDefined();
      // The caller passed a user-message TEvent; the session classifies it
      // via `classifyEvent` and forwards it to the encoder unchanged.
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock check
      expect(fix.codec.classifyEvent).toHaveBeenCalled();
      expect((enc?.publishCalls.length ?? 0) - before).toBe(1);

      const call = enc?.publishCalls.at(-1);
      expect(call?.event.type).toBe('user-message');
      const opts = call?.opts;
      expect(opts?.messageId).toBeDefined();
      expect(opts?.extras?.headers?.[HEADER_RUN_ID]).toBeDefined();
      expect(opts?.extras?.headers?.[HEADER_INVOCATION_ID]).toBeDefined();
      expect(opts?.extras?.headers?.[HEADER_ROLE]).toBe('user');
      expect(opts?.extras?.headers?.['x-ably-prompt-id']).toBeDefined();
    });

    it('accepts the richer `{event, domainMessageId}` shape and uses domainMessageId as the wire HEADER_MSG_ID', async () => {
      // When the caller passes `Array<{event, domainMessageId?}>`, each
      // entry's `domainMessageId` overrides the msg-id the SDK would
      // otherwise mint. Used by chat-transport to publish continuation
      // tool resolutions onto the prior assistant's tree key — the
      // reducer's direct-fold path then matches by msg-id and no
      // cross-message redirect runs.
      await fix.session.view.sendEvent([
        { event: { type: 'user-message', text: 'first' }, domainMessageId: 'target-a' },
        { event: { type: 'user-message', text: 'second' } },
      ]);

      const enc = fix.codec.lastEncoder();
      const userPublishes = enc?.publishCalls.filter((c) => c.event.type === 'user-message') ?? [];
      expect(userPublishes).toHaveLength(2);

      // First entry used the supplied domainMessageId; second fell back to a fresh UUID.
      expect(userPublishes[0]?.opts?.extras?.headers?.[HEADER_MSG_ID]).toBe('target-a');
      const secondMsgId = userPublishes[1]?.opts?.extras?.headers?.[HEADER_MSG_ID];
      expect(secondMsgId).toBeDefined();
      expect(secondMsgId).not.toBe('target-a');
    });

    it('mints a distinct prompt-id per user-message and lists them in postBody.promptIds in order', async () => {
      await fix.session.view.sendEvent([
        { type: 'user-message', text: 'first' },
        { type: 'user-message', text: 'second' },
      ]);

      const enc = fix.codec.lastEncoder();
      const userPublishes = enc?.publishCalls.filter((c) => c.event.type === 'user-message') ?? [];
      expect(userPublishes).toHaveLength(2);
      const stampedIds = userPublishes.map((c) => c.opts?.extras?.headers?.['x-ably-prompt-id']);
      expect(stampedIds[0]).toBeDefined();
      expect(stampedIds[1]).toBeDefined();
      expect(stampedIds[0]).not.toBe(stampedIds[1]);

      await fix.fetch.waitForCalls(1);
      const body = fix.fetch.body(0);
      expect(body.promptIds).toEqual(stampedIds);
    });

    it('fires HTTP POST with runId, invocationId, history, promptIds', async () => {
      const run = await fix.session.view.sendEvent({ type: 'user-message', text: 'hi' });
      await fix.fetch.waitForCalls(1);

      expect(fix.fetch.calls[0]?.url).toBe('/api/chat');
      const body = fix.fetch.body(0);
      expect(body.runId).toBe(run.runId);
      expect(body.invocationId).toBe(run.invocationId);
      // Per-message metadata (clientId/parent/forkOf/isContinuation) is no
      // longer in the POST body — those fields live on channel headers and
      // are resolved by the agent's prompt-lookup result.
      expect(body.clientId).toBeUndefined();
      expect(Array.isArray(body.promptIds)).toBe(true);
      expect((body.promptIds as string[]).length).toBe(1);
      expect(Array.isArray(body.history)).toBe(true);
      // history excludes the brand-new optimistic message
      expect((body.history as unknown[]).length).toBe(0);
    });

    it('auto-computes parent from the last visible message', async () => {
      const ch = createMockChannel();
      const seeded = createClientSession<TestEvent, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: createMockCodec(),
        api: '/api/chat',
        messages: [{ id: 'seed', content: 'first' }],
        fetch: createMockFetch().fn as unknown as typeof globalThis.fetch,
        runStartDeadlineMs: 0,
      });
      await seeded.connect();

      const seedMsgId = seeded.view.flattenNodes()[0]?.msgId;
      const run = await seeded.view.sendEvent({ type: 'user-message', text: 'next' });

      // Find the new node — should reference the seed as its parent.
      const nodes = seeded.view.flattenNodes();
      const newNode = nodes.find((n) => n.msgId !== seedMsgId);
      expect(newNode?.headers[HEADER_PARENT]).toBe(seedMsgId);
      expect(run.optimisticMsgIds).toHaveLength(1);
      await seeded.close();
    });

    it('chains multi-message sends in a thread', async () => {
      await fix.session.view.sendEvent([
        { type: 'user-message', text: 'first' },
        { type: 'user-message', text: 'second' },
      ]);
      const nodes = fix.session.view.flattenNodes();
      expect(nodes).toHaveLength(2);
      expect(nodes[1]?.headers[HEADER_PARENT]).toBe(nodes[0]?.msgId);
    });

    it('merges sendOptions.body and sendOptions.headers into POST', async () => {
      await fix.session.view.sendEvent(
        { type: 'user-message', text: 'hi' },
        { body: { tag: 'v1' }, headers: { 'X-Custom': 'token' } },
      );
      await fix.fetch.waitForCalls(1);
      const body = fix.fetch.body(0);
      expect(body.tag).toBe('v1');
      const headers = fix.fetch.calls[0]?.init.headers as Record<string, string>;
      expect(headers['X-Custom']).toBe('token');
    });

    it('stamps forkOf on the publish headers when set', async () => {
      // forkOf moved off the POST body and onto the channel headers — the
      // agent resolves it from the first prompt-lookup user-message header.
      await fix.session.view.sendEvent({ type: 'user-message', text: 'hi' }, { forkOf: 'msg-original' });
      await fix.fetch.waitForCalls(1);
      expect(fix.fetch.body(0).forkOf).toBeUndefined();
      const enc = fix.codec.lastEncoder();
      const headers = enc?.publishCalls.at(-1)?.opts?.extras?.headers;
      expect(headers?.['x-ably-fork-of']).toBe('msg-original');
    });

    it('stream is available before POST completes (fire-and-forget)', async () => {
      const blockingFetch = vi.fn(
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- never-resolves stub
        () =>
          new Promise<Response>(() => {
            /* never resolves */
          }),
      );
      const ch = createMockChannel();
      const s = createClientSession<TestEvent, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: createMockCodec(),
        api: '/api/chat',
        fetch: blockingFetch as unknown as typeof globalThis.fetch,
        runStartDeadlineMs: 0,
      });
      await s.connect();
      const run = await s.view.sendEvent({ type: 'user-message', text: 'hi' });
      expect(run.stream).toBeInstanceOf(ReadableStream);
      await s.close();
    });

    it('throws when session is closed', async () => {
      await fix.session.close();
      // View error wrapping: the view rejects with its "view is closed" error.
      await expect(fix.session.view.sendEvent({ type: 'user-message', text: 'hi' })).rejects.toThrow();
    });

    for (const state of ['failed', 'suspended', 'detached', 'initialized'] as const) {
      it(`rejects when channel state is ${state}`, async () => {
        // Mark initial attach as observed so further state changes don't get filtered.
        simulateStateChange(fix.channel, {
          current: 'attached',
          previous: 'attaching',
          resumed: false,
        } as Ably.ChannelStateChange);
        fix.channel.state = state;
        await expect(fix.session.view.sendEvent({ type: 'user-message', text: 'hi' })).rejects.toBeErrorInfoWithCode(
          ErrorCode.ChannelNotReady,
        );
      });
    }

    it('allows send when channel is ATTACHING', async () => {
      simulateStateChange(fix.channel, {
        current: 'attached',
        previous: 'attaching',
        resumed: false,
      } as Ably.ChannelStateChange);
      fix.channel.state = 'attaching';
      const run = await fix.session.view.sendEvent({ type: 'user-message', text: 'hi' });
      expect(run.stream).toBeInstanceOf(ReadableStream);
    });
  });

  // -------------------------------------------------------------------------
  // send — continuation (options.runId reuses the suspended run)
  // -------------------------------------------------------------------------

  describe('send — continuation', () => {
    it('reuses the runId, mints a fresh invocationId, and returns the existing stream', async () => {
      const initial = await fix.session.view.sendEvent({ type: 'user-message', text: 'hi' });

      const cont = await fix.session.view.sendEvent([{ type: 'tool-resolution', toolCallId: 'tc-1' }], {
        runId: initial.runId,
      });

      expect(cont.runId).toBe(initial.runId);
      expect(cont.invocationId).not.toBe(initial.invocationId);
      // Same readable across the suspend/resume gap — useChat keeps reading.
      expect(cont.stream).toBe(initial.stream);
    });

    it('publishes the tool-resolution as a continuation user-message with HEADER_RUN_ID and HEADER_RUN_CONTINUE', async () => {
      const initial = await fix.session.view.sendEvent({ type: 'user-message', text: 'hi' });
      const enc = fix.codec.lastEncoder();
      // Drop the initial publish from the call count
      const baseCalls = enc?.publishCalls.length ?? 0;

      await fix.session.view.sendEvent([{ type: 'tool-resolution', toolCallId: 'tc-1' }], { runId: initial.runId });

      const newCalls = (enc?.publishCalls.length ?? 0) - baseCalls;
      expect(newCalls).toBe(1);
      const call = enc?.publishCalls.at(-1);
      expect(call?.event.type).toBe('tool-resolution');
      const headers = call?.opts?.extras?.headers;
      expect(headers?.[HEADER_RUN_ID]).toBe(initial.runId);
      // A fresh invocation-id is minted for the continuation.
      expect(headers?.[HEADER_INVOCATION_ID]).toBeDefined();
      expect(headers?.[HEADER_INVOCATION_ID]).not.toBe(initial.invocationId);
      // Continuation publishes carry HEADER_RUN_CONTINUE='true' on the wire.
      expect(headers?.['x-ably-run-continue']).toBe('true');
      // Tool resolutions publish as role:'user' (the wire shape mirrors a
      // user-message; the reducer redirects by toolCallId).
      expect(headers?.[HEADER_ROLE]).toBe('user');
      // No x-ably-amend header — the old amend header is gone from the wire.
      expect(headers?.['x-ably-amend']).toBeUndefined();
    });

    it('optimistically folds into observer projection (no tree node) and posts one promptId per tool event', async () => {
      const initial = await fix.session.view.sendEvent({ type: 'user-message', text: 'hi' });
      const beforeNodes = fix.session.view.flattenNodes().length;

      const cont = await fix.session.view.sendEvent([{ type: 'tool-resolution', toolCallId: 'tc-1' }], {
        runId: initial.runId,
      });

      // The reducer treats tool-resolution wire messages as user-messages
      // that get redirected by toolCallId. No standalone tree node lands
      // for the continuation publish itself (consumedMsgIds path).
      const afterNodes = fix.session.view.flattenNodes().length;
      expect(afterNodes).toBe(beforeNodes);

      await fix.fetch.waitForCalls(2);
      const body = fix.fetch.body(1);
      // Every client-published event in an invocation carries a promptId
      // — the agent waits for all of them on the channel before starting
      // LLM work. Tool resolutions use the same mechanism as user-messages.
      expect(Array.isArray(body.promptIds)).toBe(true);
      expect((body.promptIds as string[]).length).toBe(1);
      expect(body.runId).toBe(cont.runId);
      expect(body.invocationId).toBe(cont.invocationId);
    });

    it('stamps the matching x-ably-prompt-id on each continuation publish', async () => {
      const initial = await fix.session.view.sendEvent({ type: 'user-message', text: 'hi' });
      const before = fix.codec.lastEncoder()?.publishCalls.length ?? 0;

      await fix.session.view.sendEvent([{ type: 'tool-resolution', toolCallId: 'tc-1' }], { runId: initial.runId });

      const enc = fix.codec.lastEncoder();
      const contPublish = enc?.publishCalls.slice(before).find((c) => c.event.type === 'tool-resolution');
      const stampedId = contPublish?.opts?.extras?.headers?.['x-ably-prompt-id'];
      expect(stampedId).toBeDefined();

      await fix.fetch.waitForCalls(2);
      const body = fix.fetch.body(1);
      expect(body.promptIds).toEqual([stampedId]);
    });

    it('continuation publishes carry HEADER_RUN_CONTINUE=true while fresh sends do not', async () => {
      const fresh = await fix.session.view.sendEvent({ type: 'user-message', text: 'hi' });
      const enc = fix.codec.lastEncoder();
      const freshHeaders = enc?.publishCalls.at(-1)?.opts?.extras?.headers;
      expect(freshHeaders?.['x-ably-run-continue']).toBeUndefined();

      await fix.session.view.sendEvent([{ type: 'tool-resolution', toolCallId: 'tc-1' }], { runId: fresh.runId });
      const contHeaders = enc?.publishCalls.at(-1)?.opts?.extras?.headers;
      expect(contHeaders?.['x-ably-run-continue']).toBe('true');
    });

    it('rejects an empty send with no runId and no forkOf', async () => {
      await expect(fix.session.view.sendEvent([])).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
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
      const fetchMock = createMockFetch();
      const s = createClientSession<TestEvent, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: failingPublishCodec,
        clientId: 'client-1',
        api: '/api/chat',
        fetch: fetchMock.fn as unknown as typeof globalThis.fetch,
        runStartDeadlineMs: 0,
      });
      await s.connect();

      const errors: Ably.ErrorInfo[] = [];
      s.on('error', (e) => errors.push(e));

      await expect(s.view.sendEvent({ type: 'user-message', text: 'hi' })).rejects.toBeErrorInfoWithCode(
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
      const s = createClientSession<TestEvent, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: failingPublishCodec,
        clientId: 'client-1',
        api: '/api/chat',
        fetch: createMockFetch().fn as unknown as typeof globalThis.fetch,
        runStartDeadlineMs: 0,
      });
      await s.connect();
      s.on('error', () => {
        /* consume */
      });

      await expect(s.view.sendEvent({ type: 'user-message', text: 'hi' })).rejects.toBeErrorInfoWithCode(
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
      const s = createClientSession<TestEvent, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: failingPublishCodec,
        clientId: 'client-1',
        api: '/api/chat',
        fetch: createMockFetch().fn as unknown as typeof globalThis.fetch,
        runStartDeadlineMs: 0,
      });
      await s.connect();
      s.on('error', () => {
        /* consume */
      });

      await expect(s.view.sendEvent({ type: 'user-message', text: 'hi' })).rejects.toBeDefined();
      // Optimistic node removed since publish failed before any ack
      expect(s.view.flattenNodes()).toHaveLength(0);
      await s.close();
    });

    it('fires error event when POST returns non-OK', async () => {
      const ch = createMockChannel();
      const fetch = createMockFetch(500);
      const s = createClientSession<TestEvent, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: createMockCodec(),
        clientId: 'client-1',
        api: '/api/chat',
        fetch: fetch.fn as unknown as typeof globalThis.fetch,
        runStartDeadlineMs: 0,
      });
      await s.connect();
      const errors: Ably.ErrorInfo[] = [];
      s.on('error', (e) => errors.push(e));
      await s.view.sendEvent({ type: 'user-message', text: 'hi' });
      await fetch.waitForCalls(1);
      await flushMicrotasks();
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe(ErrorCode.SessionSendFailed);
      await s.close();
    });

    it('errors the stream when POST throws a network error', async () => {
      const ch = createMockChannel();
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
      const fetchFn = vi.fn(() => Promise.reject(new Error('network down')));
      const s = createClientSession<TestEvent, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: createMockCodec(),
        clientId: 'client-1',
        api: '/api/chat',
        fetch: fetchFn as unknown as typeof globalThis.fetch,
        runStartDeadlineMs: 0,
      });
      await s.connect();
      s.on('error', () => {
        /* consume */
      });
      const run = await s.view.sendEvent({ type: 'user-message', text: 'hi' });
      await flushMicrotasks();
      const reader = run.stream.getReader();
      await expect(reader.read()).rejects.toBeErrorInfoWithCode(ErrorCode.SessionSendFailed);
      await s.close();
    });
  });

  // -------------------------------------------------------------------------
  // run-start deadline
  // -------------------------------------------------------------------------

  describe('runStartDeadlineMs', () => {
    it('rejects with RunStartDeadlineExceeded when no run-start arrives in time', async () => {
      const ch = createMockChannel();
      const fetchMock = createMockFetch();
      const s = createClientSession<TestEvent, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: createMockCodec(),
        clientId: 'client-1',
        api: '/api/chat',
        fetch: fetchMock.fn as unknown as typeof globalThis.fetch,
        runStartDeadlineMs: 20,
      });
      await s.connect();
      s.on('error', () => {
        /* consume */
      });
      await expect(s.view.sendEvent({ type: 'user-message', text: 'hi' })).rejects.toBeErrorInfoWithCode(
        ErrorCode.RunStartDeadlineExceeded,
      );
      await s.close();
    });

    it('resolves when a matching run-start is delivered before the deadline', async () => {
      const ch = createMockChannel();
      const codec = createMockCodec();
      const s = createClientSession<TestEvent, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec,
        clientId: 'client-1',
        api: '/api/chat',
        fetch: createMockFetch().fn as unknown as typeof globalThis.fetch,
        runStartDeadlineMs: 5000,
      });
      await s.connect();

      const sendPromise = s.view.sendEvent({ type: 'user-message', text: 'hi' });
      await ackPendingSend(ch, codec);
      const run = await sendPromise;
      expect(run.stream).toBeInstanceOf(ReadableStream);
      await s.close();
    });
  });

  // -------------------------------------------------------------------------
  // Message routing — observer projection + own-run stream
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

    it('surfaces isContinuation on the run-start event when x-ably-run-continue is set', () => {
      const lifecycle: RunLifecycleEvent[] = [];
      fix.session.tree.on('run', (e) => lifecycle.push(e));

      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-cont',
          [HEADER_RUN_CLIENT_ID]: 'agent',
          'x-ably-run-continue': 'true',
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

    it('converges optimistic insert and echo into a single tree node when UIMessage.id differs from wire HEADER_MSG_ID', async () => {
      // Regression: under Vercel's codec the projection's UIMessage.id is the
      // domain id (x-domain-messageId, e.g. useChat's local id) while the wire
      // `x-ably-msg-id` is the optimistic tree msgId. `_accumulateAndEmit` must
      // upsert at the wire msgId so the echo converges with the optimistic
      // insert — not at the projection message's id, which would create a
      // second tree node and dup the message in `view.flattenNodes()`.
      const ch = createMockChannel();
      const decoder = createMockDecoder();
      // Custom codec: classifier returns a message with a FIXED id; fold pushes
      // the message into the projection keyed by that fixed id (NOT meta.messageId).
      // Mirrors how the Vercel codec produces UIMessages with x-domain-messageId
      // as the id field rather than the wire's x-ably-msg-id.
      const customCodec = createMockCodec(decoder);
      // CAST: the mock fold's parameters mirror the Codec.fold signature.
      customCodec.fold = vi.fn((state: TestProjection, event: TestEvent, meta: ReducerMeta) => {
        state.foldedEvents.push({ event, meta });
        // Use a fixed domain id derived from the text — independent of wireMsgId.
        // Mirrors the Vercel codec where UIMessage.id is the domain id, distinct
        // from the wire's x-ably-msg-id.
        if (event.type === 'user-message' && typeof event.text === 'string') {
          const domainId = `domain-${event.text}`;
          let msg = state.messages.find((m) => m.id === domainId);
          if (!msg) {
            msg = { id: domainId, content: event.text };
            state.messages.push(msg);
          }
          return state;
        }
        // For non-user-message events, fall back to the keyed-by-meta.messageId
        // shape of the default mock.
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
      });
      const s = createClientSession<TestEvent, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: customCodec,
        api: '/api/chat',
        clientId: 'client-1',
        fetch: createMockFetch().fn as unknown as typeof globalThis.fetch,
        runStartDeadlineMs: 0,
      });
      await s.connect();

      // Optimistic insert. The session mints a random tree msgId; the
      // projection's UIMessage id is `domain-hi` (from our custom fold).
      await s.view.sendEvent({ type: 'user-message', text: 'hi' });
      const lastPublish = customCodec.lastEncoder()?.publishCalls.at(-1);
      const optimisticMsgId = lastPublish?.opts?.extras?.headers?.[HEADER_MSG_ID];
      const runId = lastPublish?.opts?.extras?.headers?.[HEADER_RUN_ID];
      expect(optimisticMsgId).toBeDefined();
      if (!optimisticMsgId) throw new Error('expected optimistic msgId on publish');

      // Echo the wire message with the same tree msgId so the optimistic
      // node converges. Queue the same user-message event for the decoder.
      decoder.queue.push({ type: 'user-message', text: 'hi' });
      simulateMessage(
        ch,
        ablyMsg(
          'text',
          {
            [HEADER_RUN_ID]: runId ?? '',
            [HEADER_RUN_CLIENT_ID]: 'client-1',
            [HEADER_ROLE]: 'user',
            [HEADER_MSG_ID]: optimisticMsgId,
          },
          undefined,
          'message.create',
        ),
      );

      // The tree must contain exactly one node — the optimistic insert,
      // updated by the echo. NOT a separate node at `domain-hi`.
      expect(s.view.flattenNodes()).toHaveLength(1);
      expect(s.tree.getNode(optimisticMsgId)?.message.content).toBe('hi');
      expect(s.tree.getNode('domain-hi')).toBeUndefined();
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
            [HEADER_MSG_ID]: 'm-1',
          },
          undefined,
          'message.create',
        ),
      );

      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock check
      expect(fix.codec.fold).toHaveBeenCalled();
      const node = fix.session.tree.getNode('m-1');
      expect(node?.message.content).toBe('hi');
    });

    it('routes own-run events to the ActiveRun stream', async () => {
      const ch = createMockChannel();
      const decoder = createMockDecoder();
      const codec = createMockCodec(decoder);
      const s = createClientSession<TestEvent, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec,
        clientId: 'client-1',
        api: '/api/chat',
        fetch: createMockFetch().fn as unknown as typeof globalThis.fetch,
        runStartDeadlineMs: 5000,
      });
      await s.connect();

      const sendPromise = s.view.sendEvent({ type: 'user-message', text: 'hi' });
      const { runId, invocationId } = await ackPendingSend(ch, codec);
      const run = await sendPromise;

      // Push a text event into the run's stream (decoder is shared with the
      // session — same instance returned by codec.createDecoder()).
      decoder.queue.push({ type: 'text', text: 'pong' });
      simulateMessage(
        ch,
        ablyMsg('text', {
          [HEADER_RUN_ID]: runId,
          [HEADER_INVOCATION_ID]: invocationId,
          [HEADER_MSG_ID]: 'a-1',
        }),
      );
      // Push finish to terminate the stream
      decoder.queue.push({ type: 'finish' });
      simulateMessage(
        ch,
        ablyMsg('text', {
          [HEADER_RUN_ID]: runId,
          [HEADER_INVOCATION_ID]: invocationId,
          [HEADER_MSG_ID]: 'a-1',
        }),
      );
      // Close stream via run-end
      simulateMessage(
        ch,
        ablyMsg(EVENT_RUN_END, {
          [HEADER_RUN_ID]: runId,
          [HEADER_RUN_CLIENT_ID]: 'client-1',
          [HEADER_INVOCATION_ID]: invocationId,
          [HEADER_RUN_REASON]: 'complete',
        }),
      );

      const events = await drain(run.stream);
      expect(events.map((e) => e.type)).toEqual(['text', 'finish']);
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
          [HEADER_MSG_ID]: 'm-z',
        }),
      );
      // fold should not have been called (no events)
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock check
      expect(fix.codec.fold).not.toHaveBeenCalled();
    });

    it('surfaces agent error events on session error and rejects pending send', async () => {
      const ch = createMockChannel();
      const codec = createMockCodec();
      const s = createClientSession<TestEvent, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec,
        clientId: 'client-1',
        api: '/api/chat',
        fetch: createMockFetch().fn as unknown as typeof globalThis.fetch,
        runStartDeadlineMs: 5000,
      });
      await s.connect();
      const errors: Ably.ErrorInfo[] = [];
      s.on('error', (e) => errors.push(e));

      const sendPromise = s.view.sendEvent({ type: 'user-message', text: 'hi' });
      // Wait for a publish to land so we know the invocation has been registered
      while (codec.lastEncoder()?.publishCalls.length === 0) {
        await Promise.resolve();
      }
      const opts = codec.lastEncoder()?.publishCalls[0]?.opts;
      const invocationId = opts?.extras?.headers?.[HEADER_INVOCATION_ID] ?? '';
      const runId = opts?.extras?.headers?.[HEADER_RUN_ID] ?? '';

      simulateMessage(
        ch,
        ablyMsg(
          EVENT_ERROR,
          { [HEADER_RUN_ID]: runId, [HEADER_INVOCATION_ID]: invocationId },
          { code: ErrorCode.PromptNotFound, statusCode: 504, message: 'lookup failed' },
        ),
      );

      await expect(sendPromise).rejects.toBeErrorInfoWithCode(ErrorCode.PromptNotFound);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison -- compare against enum value
      expect(errors.some((e) => e.code === ErrorCode.PromptNotFound)).toBe(true);
      await s.close();
    });

    it('drops losing-invocation run-end (ignored when active invocation mismatches)', async () => {
      const ch = createMockChannel();
      const codec = createMockCodec();
      const s = createClientSession<TestEvent, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec,
        clientId: 'client-1',
        api: '/api/chat',
        fetch: createMockFetch().fn as unknown as typeof globalThis.fetch,
        runStartDeadlineMs: 5000,
      });
      await s.connect();

      const sendPromise = s.view.sendEvent({ type: 'user-message', text: 'hi' });
      const { runId, invocationId } = await ackPendingSend(ch, codec);
      const run = await sendPromise;

      // Simulate a losing-invocation run-end — different invocationId
      simulateMessage(
        ch,
        ablyMsg(EVENT_RUN_END, {
          [HEADER_RUN_ID]: runId,
          [HEADER_RUN_CLIENT_ID]: 'client-1',
          [HEADER_INVOCATION_ID]: 'losing-inv',
          [HEADER_RUN_REASON]: 'complete',
        }),
      );

      // Stream is still open. Now deliver the canonical run-end with the
      // active invocation — stream should close.
      simulateMessage(
        ch,
        ablyMsg(EVENT_RUN_END, {
          [HEADER_RUN_ID]: runId,
          [HEADER_RUN_CLIENT_ID]: 'client-1',
          [HEADER_INVOCATION_ID]: invocationId,
          [HEADER_RUN_REASON]: 'complete',
        }),
      );

      const events = await drain(run.stream);
      expect(events).toEqual([]);
      await s.close();
    });

    it('processes continuation run-end (router-active invocation is fresh)', async () => {
      // Continuation rebinds the router stream to a new invocation while the
      // Tree's winner stays on the original user-message's invocation. The
      // gating must prefer the router for own runs so the continuation's
      // run-end is accepted and the run cleans up.
      const initial = await fix.session.view.sendEvent({ type: 'user-message', text: 'hi' });
      const continuation = await fix.session.view.sendEvent([{ type: 'tool-resolution', toolCallId: 'tc-1' }], {
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
  // Same-run message routing — successive wire messages routed by HEADER_MSG_ID
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
          [HEADER_MSG_ID]: 'm-1',
        }),
      );

      // Follow-up message targeting m-1 from the SAME run — encoder stamps
      // HEADER_MSG_ID = 'm-1', so the reducer folds with meta.messageId === 'm-1'.
      fix.decoder.queue.push({ type: 'text', text: '-extended' });
      simulateMessage(
        fix.channel,
        ablyMsg('text', {
          [HEADER_RUN_ID]: 'run-A',
          [HEADER_RUN_CLIENT_ID]: 'other',
          [HEADER_MSG_ID]: 'm-1',
        }),
      );

      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.mocked accessor
      const calls = vi.mocked(fix.codec.fold).mock.calls;
      expect(calls).toHaveLength(2);
      // CAST: tuple shape comes from vi.mocked
      const firstCall = calls[0] as unknown as [TestProjection, TestEvent, ReducerMeta];
      const secondCall = calls[1] as unknown as [TestProjection, TestEvent, ReducerMeta];
      // Both events routed under HEADER_MSG_ID = 'm-1'
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
          [HEADER_MSG_ID]: 'm-1',
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
    it('publishes a cancel message with own=true by default', async () => {
      await fix.session.cancel();
      const cancelMsg = fix.channel.publishCalls.find((m) => m.name === 'ai-cancel');
      expect(cancelMsg).toBeDefined();
      const headers = (cancelMsg?.extras as { headers: Record<string, string> } | undefined)?.headers;
      expect(headers?.[HEADER_CANCEL_OWN]).toBe('true');
    });

    it.each([
      ['runId', { runId: 'run-1' }, HEADER_CANCEL_RUN_ID, 'run-1'],
      ['invocationId', { invocationId: 'inv-1' }, HEADER_CANCEL_INVOCATION_ID, 'inv-1'],
      ['clientId', { clientId: 'someone' }, HEADER_CANCEL_CLIENT_ID, 'someone'],
      ['all', { all: true }, HEADER_CANCEL_ALL, 'true'],
    ])('publishes cancel with %s filter', async (_, filter, header, expected) => {
      await fix.session.cancel(filter);
      const cancelMsg = fix.channel.publishCalls.find((m) => m.name === 'ai-cancel');
      expect(cancelMsg).toBeDefined();
      const headers = (cancelMsg?.extras as { headers: Record<string, string> } | undefined)?.headers;
      expect(headers?.[header]).toBe(expected);
    });

    it('closes any active own run streams', async () => {
      const ch = createMockChannel();
      const codec = createMockCodec();
      const s = createClientSession<TestEvent, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec,
        clientId: 'client-1',
        api: '/api/chat',
        fetch: createMockFetch().fn as unknown as typeof globalThis.fetch,
        runStartDeadlineMs: 5000,
      });
      await s.connect();

      const sendPromise = s.view.sendEvent({ type: 'user-message', text: 'hi' });
      await ackPendingSend(ch, codec);
      const run = await sendPromise;

      await s.cancel({ runId: run.runId });
      const events = await drain(run.stream);
      expect(events).toEqual([]);
      await s.close();
    });

    it('cancel is a no-op after close', async () => {
      await fix.session.close();
      await expect(fix.session.cancel()).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // waitForRun
  // -------------------------------------------------------------------------

  describe('waitForRun', () => {
    it('resolves immediately when no matching runs are active', async () => {
      await expect(fix.session.waitForRun({ runId: 'run-nothing' })).resolves.toBeUndefined();
    });

    it('resolves when the matching run ends', async () => {
      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-W',
          [HEADER_RUN_CLIENT_ID]: 'other',
        }),
      );

      const p = fix.session.waitForRun({ runId: 'run-W' });
      // Now end the run
      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_END, {
          [HEADER_RUN_ID]: 'run-W',
          [HEADER_RUN_CLIENT_ID]: 'other',
          [HEADER_RUN_REASON]: 'complete',
        }),
      );
      await expect(p).resolves.toBeUndefined();
    });

    it('resolves on session close even with active runs', async () => {
      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-Q',
          [HEADER_RUN_CLIENT_ID]: 'other',
        }),
      );
      const p = fix.session.waitForRun({ all: true });
      await fix.session.close();
      await expect(p).resolves.toBeUndefined();
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
      await fix.session.view.sendEvent({ type: 'user-message', text: 'hi' });
      const enc = fix.codec.lastEncoder();
      expect(enc).toBeDefined();
      await fix.session.close();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock check
      expect(enc?.close).toHaveBeenCalled();
    });

    it('publishes a cancel when close({ cancel }) is provided', async () => {
      await fix.session.close({ cancel: { all: true } });
      const cancelMsg = fix.channel.publishCalls.find((m) => m.name === 'ai-cancel');
      expect(cancelMsg).toBeDefined();
    });

    it('rejects pending run-starts with SessionClosed', async () => {
      const ch = createMockChannel();
      const codec = createMockCodec();
      const s = createClientSession<TestEvent, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec,
        clientId: 'client-1',
        api: '/api/chat',
        fetch: createMockFetch().fn as unknown as typeof globalThis.fetch,
        runStartDeadlineMs: 5000,
      });
      await s.connect();
      s.on('error', () => {
        /* consume */
      });

      const sendPromise = s.view.sendEvent({ type: 'user-message', text: 'hi' });
      // Don't ack — close while pending
      await flushMicrotasks();
      await s.close();
      await expect(sendPromise).rejects.toBeErrorInfoWithCode(ErrorCode.SessionClosed);
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

      // Simulate a channel-level error event
      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_ERROR, {}, { code: ErrorCode.SessionSubscriptionError, statusCode: 500, message: 'oops' }),
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
        } as Ably.ChannelStateChange);

        const errors: Ably.ErrorInfo[] = [];
        fix.session.on('error', (e) => errors.push(e));
        simulateStateChange(fix.channel, {
          current: state,
          previous: 'attached',
          resumed: false,
        } as Ably.ChannelStateChange);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison -- compare against enum value
        expect(errors.some((e) => e.code === ErrorCode.ChannelContinuityLost)).toBe(true);
      },
    );

    it('emits ChannelContinuityLost on re-attach with resumed: false', () => {
      simulateStateChange(fix.channel, {
        current: 'attached',
        previous: 'attaching',
        resumed: false,
      } as Ably.ChannelStateChange);

      const errors: Ably.ErrorInfo[] = [];
      fix.session.on('error', (e) => errors.push(e));
      simulateStateChange(fix.channel, {
        current: 'attached',
        previous: 'attaching',
        resumed: false,
      } as Ably.ChannelStateChange);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison -- compare against enum value
      expect(errors.some((e) => e.code === ErrorCode.ChannelContinuityLost)).toBe(true);
    });

    it('does not emit on the initial attach when channel started detached', async () => {
      // Use a channel that starts in 'initialized' state so the session
      // treats the first attached transition as the initial attach.
      const ch = createMockChannel();
      ch.state = 'initialized';
      const s = createClientSession<TestEvent, TestProjection, TestMessage>({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec: createMockCodec(),
        clientId: 'client-1',
        api: '/api/chat',
        fetch: createMockFetch().fn as unknown as typeof globalThis.fetch,
        runStartDeadlineMs: 0,
      });
      await s.connect();
      const errors: Ably.ErrorInfo[] = [];
      s.on('error', (e) => errors.push(e));
      simulateStateChange(ch, {
        current: 'attached',
        previous: 'attaching',
        resumed: false,
      } as Ably.ChannelStateChange);
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
    it('publishes a regenerate event without upserting the tree or folding the projection', async () => {
      // Seed a user message and assistant in the tree first.
      await fix.session.view.sendEvent({ type: 'user-message', text: 'hi' });
      const nodesBefore = fix.session.view.flattenNodes();
      expect(nodesBefore).toHaveLength(1);
      const userMsgId = nodesBefore[0]?.msgId;
      expect(userMsgId).toBeDefined();

      // Send a regenerate event — wire-only, carries parent/forkOf on headers.
      await fix.session.view.sendEvent({
        type: 'regenerate-event',
        parent: userMsgId,
        forkOf: 'asst-1',
      });

      // Tree is unchanged — no new node materialised for the regenerate event.
      const nodesAfter = fix.session.view.flattenNodes();
      expect(nodesAfter).toHaveLength(1);
      expect(nodesAfter[0]?.msgId).toBe(userMsgId);

      // The regenerate event was published on the channel with correct headers.
      const enc = fix.codec.lastEncoder();
      const regeneratePublish = enc?.publishCalls.find((c) => c.event.type === 'regenerate-event');
      expect(regeneratePublish).toBeDefined();
      const headers = regeneratePublish?.opts?.extras?.headers;
      expect(headers?.[HEADER_ROLE]).toBe('user');
      expect(headers?.[HEADER_PARENT]).toBe(userMsgId);
      expect(headers?.[HEADER_FORK_OF]).toBe('asst-1');
      expect(headers?.[HEADER_PROMPT_ID]).toBeDefined();
      expect(headers?.[HEADER_MSG_ID]).toBeDefined();
    });

    it('mints a fresh prompt-id for the regenerate event and lists it in postBody.promptIds', async () => {
      await fix.session.view.sendEvent({
        type: 'regenerate-event',
        parent: 'u1',
        forkOf: 'asst-1',
      });

      await fix.fetch.waitForCalls(1);
      const body = fix.fetch.body(0);
      expect(Array.isArray(body.promptIds)).toBe(true);
      expect((body.promptIds as string[]).length).toBe(1);

      const enc = fix.codec.lastEncoder();
      const regeneratePublish = enc?.publishCalls.find((c) => c.event.type === 'regenerate-event');
      const promptId = regeneratePublish?.opts?.extras?.headers?.[HEADER_PROMPT_ID];
      expect((body.promptIds as string[])[0]).toBe(promptId);
    });
  });

  describe('edit', () => {
    it('throws when the target node is unknown', async () => {
      await expect(fix.session.view.edit('missing-msg', { type: 'user-message', text: 'replaced' })).rejects.toThrow();
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
          [HEADER_MSG_ID]: 'm-e',
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
          [HEADER_MSG_ID]: 'm-e2',
        }),
      );
      // A new observer projection was created (one extra init); fold ran.
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.mocked accessor
      expect(vi.mocked(fix.codec.fold).mock.calls.length).toBeGreaterThan(foldCallsBefore);
    });
  });
});
