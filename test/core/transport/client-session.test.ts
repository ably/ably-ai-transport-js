/**
 * ClientSession unit tests.
 *
 * Mock encoder uses single-method `publish`; mock decoder returns `TEvent[]`;
 * projection state is folded via `init` / `fold` / `getMessages`.
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
    fn: fn,
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
    cancel: vi.fn(() => Promise.resolve()),
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
      // User-message events fold into the projection by meta.messageId so
      // getMessages() yields them for the tree to surface.
      if (event.type === 'user-message') {
        const id = meta.messageId ?? 'unknown';
        const next: TestMessage = { id, content: event.text ?? '' };
        const idx = state.messages.findIndex((m) => m.id === id);
        if (idx === -1) state.messages.push(next);
        else state.messages[idx] = next;
      }
      return state;
    }),
    getMessages: vi.fn((p: TestProjection) => p.messages),
    userMessageEvent: vi.fn((m: TestMessage): TestEvent => ({ type: 'user-message', text: m.content })),
    createRegenerateEvent: vi.fn((): TestEvent => ({ type: 'user-message' })),
    classifyEvent: vi.fn((event: TestEvent) => {
      if (event.type === 'user-message') {
        return { kind: 'user-message' as const };
      }
      if (event.type === 'regenerate-event') {
        return {
          kind: 'regenerate' as const,
          parent: event.parent ?? '',
          regenerates: event.forkOf ?? '',
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
 * runId / invocationId / codecMessageId triple.
 *
 * Use when the test creates a session with `runStartDeadlineMs > 0` (the
 * default). Tests that don't care about the wait can construct the session
 * with `runStartDeadlineMs: 0`.
 * @param channel - Mock channel.
 * @param codec - Mock codec.
 * @returns The published codecMessageId/runId/invocationId.
 */
const ackPendingSend = async (
  channel: MockChannel,
  codec: MockCodec,
): Promise<{ runId: string; invocationId: string; codecMessageId: string }> => {
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
  const codecMessageId = publishedHeaders[HEADER_CODEC_MESSAGE_ID] ?? '';
  simulateMessage(
    channel,
    ablyMsg(EVENT_RUN_START, {
      [HEADER_RUN_ID]: runId,
      [HEADER_RUN_CLIENT_ID]: 'client-1',
      [HEADER_INVOCATION_ID]: invocationId,
    }),
  );
  return { runId, invocationId, codecMessageId };
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
      await expect(s.cancel('run-x')).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
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

      const messages = s.view.getMessages();
      expect(messages.map((m) => m.content)).toEqual(['first', 'second']);
      // Subsequent seed Runs chain off the prior one via parentRunId.
      const nodes = s.view.flattenNodes();
      expect(nodes).toHaveLength(2);
      expect(nodes[1]?.parentRunId).toBe(nodes[0]?.runId);
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
      const messages = fix.session.view.getMessages();
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
      expect(opts?.extras?.headers?.['x-ably-event-id']).toBeDefined();
      // `ai-input` events do not carry `x-ably-input-client-id` — the wire
      // publisher's Ably `clientId` already conveys that on the input event
      // itself. The agent re-stamps it on its own subsequent publishes.
      expect(opts?.extras?.headers?.['x-ably-input-client-id']).toBeUndefined();
    });

    it('accepts the richer `{event, codecMessageId}` shape and uses codecMessageId as the wire HEADER_CODEC_MESSAGE_ID', async () => {
      // When the caller passes `Array<{event, codecMessageId?}>`, each
      // entry's `codecMessageId` overrides the codec-message-id the SDK would
      // otherwise mint. Used by chat-transport to publish continuation
      // tool resolutions onto the prior assistant's tree key — the
      // reducer's direct-fold path then matches by codec-message-id and no
      // cross-message redirect runs.
      await fix.session.view.sendEvent([
        { event: { type: 'user-message', text: 'first' }, codecMessageId: 'target-a' },
        { event: { type: 'user-message', text: 'second' } },
      ]);

      const enc = fix.codec.lastEncoder();
      const userPublishes = enc?.publishCalls.filter((c) => c.event.type === 'user-message') ?? [];
      expect(userPublishes).toHaveLength(2);

      // First entry used the supplied codecMessageId; second fell back to a fresh UUID.
      expect(userPublishes[0]?.opts?.extras?.headers?.[HEADER_CODEC_MESSAGE_ID]).toBe('target-a');
      const secondMsgId = userPublishes[1]?.opts?.extras?.headers?.[HEADER_CODEC_MESSAGE_ID];
      expect(secondMsgId).toBeDefined();
      expect(secondMsgId).not.toBe('target-a');
    });

    it('mints a distinct event-id per user-message; postBody.eventId is the last (primary trigger)', async () => {
      await fix.session.view.sendEvent([
        { type: 'user-message', text: 'first' },
        { type: 'user-message', text: 'second' },
      ]);

      const enc = fix.codec.lastEncoder();
      const userPublishes = enc?.publishCalls.filter((c) => c.event.type === 'user-message') ?? [];
      expect(userPublishes).toHaveLength(2);
      const stampedIds = userPublishes.map((c) => c.opts?.extras?.headers?.['x-ably-event-id']);
      expect(stampedIds[0]).toBeDefined();
      expect(stampedIds[1]).toBeDefined();
      expect(stampedIds[0]).not.toBe(stampedIds[1]);

      await fix.fetch.waitForCalls(1);
      const body = fix.fetch.body(0);
      // POST carries only the primary (last) trigger event's id.
      expect(body.eventId).toBe(stampedIds[1]);
    });

    it('fires HTTP POST with runId, invocationId, sessionName, eventId', async () => {
      const run = await fix.session.view.sendEvent({ type: 'user-message', text: 'hi' });
      await fix.fetch.waitForCalls(1);

      expect(fix.fetch.calls[0]?.url).toBe('/api/chat');
      const body = fix.fetch.body(0);
      expect(body.runId).toBe(run.runId);
      expect(body.invocationId).toBe(run.invocationId);
      // Per-message metadata (clientId/parent/forkOf/isContinuation) is not
      // in the POST body — those fields live on channel headers and are
      // resolved by the agent's prompt-lookup result. The agent reads the
      // input event's publisher `clientId` directly off the wire.
      expect(body.clientId).toBeUndefined();
      expect(typeof body.eventId).toBe('string');
      expect(body.history).toBeUndefined();
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

      const seedRunId = seeded.view.flattenNodes()[0]?.runId;
      const run = await seeded.view.sendEvent({ type: 'user-message', text: 'next' });

      // Find the new Run — it should be parented to the seed Run.
      const nodes = seeded.view.flattenNodes();
      expect(nodes.length).toBeGreaterThan(1);
      const newNode = nodes.find((n) => n.parentRunId === seedRunId);
      expect(newNode).toBeDefined();
      expect(run.optimisticCodecMessageIds).toHaveLength(1);
      await seeded.close();
    });

    it('chains multi-message sends in a thread', async () => {
      await fix.session.view.sendEvent([
        { type: 'user-message', text: 'first' },
        { type: 'user-message', text: 'second' },
      ]);
      // Both messages land in the same Run's projection (one Run per send).
      const messages = fix.session.view.getMessages();
      expect(messages).toHaveLength(2);
      expect(messages[0]?.content).toBe('first');
      expect(messages[1]?.content).toBe('second');

      // The encoder publishes each event with chained parents: second's parent header == first's codec-message-id.
      const enc = fix.codec.lastEncoder();
      const userPublishes = enc?.publishCalls.filter((c) => c.event.type === 'user-message') ?? [];
      expect(userPublishes).toHaveLength(2);
      const firstMsgId = userPublishes[0]?.opts?.extras?.headers?.[HEADER_CODEC_MESSAGE_ID];
      const secondParent = userPublishes[1]?.opts?.extras?.headers?.[HEADER_PARENT];
      expect(secondParent).toBe(firstMsgId);
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
        fetch: blockingFetch,
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
        });
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
      });
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

      const cont = await fix.session.view.sendEvent([{ type: 'user-message', text: 'more' }], {
        runId: initial.runId,
      });

      expect(cont.runId).toBe(initial.runId);
      expect(cont.invocationId).not.toBe(initial.invocationId);
      // Same readable across the suspend/resume gap — useChat keeps reading.
      expect(cont.stream).toBe(initial.stream);
    });

    it('publishes the continuation user-message with HEADER_RUN_ID and HEADER_RUN_CONTINUE', async () => {
      const initial = await fix.session.view.sendEvent({ type: 'user-message', text: 'hi' });
      const enc = fix.codec.lastEncoder();
      // Drop the initial publish from the call count
      const baseCalls = enc?.publishCalls.length ?? 0;

      await fix.session.view.sendEvent([{ type: 'user-message', text: 'more' }], { runId: initial.runId });

      const newCalls = (enc?.publishCalls.length ?? 0) - baseCalls;
      expect(newCalls).toBe(1);
      const call = enc?.publishCalls.at(-1);
      expect(call?.event.type).toBe('user-message');
      const headers = call?.opts?.extras?.headers;
      expect(headers?.[HEADER_RUN_ID]).toBe(initial.runId);
      // A fresh invocation-id is minted for the continuation.
      expect(headers?.[HEADER_INVOCATION_ID]).toBeDefined();
      expect(headers?.[HEADER_INVOCATION_ID]).not.toBe(initial.invocationId);
      // Continuation publishes carry HEADER_RUN_CONTINUE='true' on the wire.
      expect(headers?.['x-ably-run-continue']).toBe('true');
      // Continuation user-messages publish as role:'user'.
      expect(headers?.[HEADER_ROLE]).toBe('user');
      // No x-ably-amend header — the old amend header is gone from the wire.
      expect(headers?.['x-ably-amend']).toBeUndefined();
    });

    it('posts one eventId for the continuation trigger event', async () => {
      const initial = await fix.session.view.sendEvent({ type: 'user-message', text: 'hi' });

      const cont = await fix.session.view.sendEvent([{ type: 'user-message', text: 'more' }], {
        runId: initial.runId,
      });

      await fix.fetch.waitForCalls(2);
      const body = fix.fetch.body(1);
      expect(typeof body.eventId).toBe('string');
      expect(body.runId).toBe(cont.runId);
      expect(body.invocationId).toBe(cont.invocationId);
    });

    it('stamps the matching x-ably-event-id on each continuation publish', async () => {
      const initial = await fix.session.view.sendEvent({ type: 'user-message', text: 'hi' });
      const before = fix.codec.lastEncoder()?.publishCalls.length ?? 0;

      await fix.session.view.sendEvent([{ type: 'user-message', text: 'more' }], { runId: initial.runId });

      const enc = fix.codec.lastEncoder();
      const contPublish = enc?.publishCalls.slice(before).find((c) => c.event.type === 'user-message');
      const stampedId = contPublish?.opts?.extras?.headers?.['x-ably-event-id'];
      expect(stampedId).toBeDefined();

      await fix.fetch.waitForCalls(2);
      const body = fix.fetch.body(1);
      expect(body.eventId).toBe(stampedId);
    });

    it('continuation publishes carry HEADER_RUN_CONTINUE=true while fresh sends do not', async () => {
      const fresh = await fix.session.view.sendEvent({ type: 'user-message', text: 'hi' });
      const enc = fix.codec.lastEncoder();
      const freshHeaders = enc?.publishCalls.at(-1)?.opts?.extras?.headers;
      expect(freshHeaders?.['x-ably-run-continue']).toBeUndefined();

      await fix.session.view.sendEvent([{ type: 'user-message', text: 'more' }], { runId: fresh.runId });
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
        fetch: fetchFn,
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

    it('surfaces regenerates on the run-start event when x-ably-msg-regenerate is set', () => {
      const lifecycle: RunLifecycleEvent[] = [];
      fix.session.tree.on('run', (e) => lifecycle.push(e));

      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-regen',
          [HEADER_RUN_CLIENT_ID]: 'agent',
          'x-ably-parent': 'orig-user',
          'x-ably-msg-regenerate': 'orig-asst',
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
      // domain id (x-domain-messageId, e.g. useChat's local id) while the wire
      // `x-ably-codec-message-id` is the optimistic tree codecMessageId. The session must fold
      // the echo into the same Run the optimistic insert created (routed by
      // x-ably-run-id) so the projection's message is updated in place — not
      // a second Run with a duplicate message in `view.getMessages()`.
      const ch = createMockChannel();
      const decoder = createMockDecoder();
      // Custom codec: classifier returns a message with a FIXED id; fold pushes
      // the message into the projection keyed by that fixed id (NOT meta.messageId).
      // Mirrors how the Vercel codec produces UIMessages with x-domain-messageId
      // as the id field rather than the wire's x-ably-codec-message-id.
      const customCodec = createMockCodec(decoder);
      // CAST: the mock fold's parameters mirror the Codec.fold signature.
      customCodec.fold = vi.fn((state: TestProjection, event: TestEvent, meta: ReducerMeta) => {
        state.foldedEvents.push({ event, meta });
        // Use a fixed domain id derived from the text — independent of wireMsgId.
        // Mirrors the Vercel codec where UIMessage.id is the domain id, distinct
        // from the wire's x-ably-codec-message-id.
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

      // Optimistic insert. The session mints a random tree codecMessageId; the
      // projection's UIMessage id is `domain-hi` (from our custom fold).
      await s.view.sendEvent({ type: 'user-message', text: 'hi' });
      const lastPublish = customCodec.lastEncoder()?.publishCalls.at(-1);
      const optimisticMsgId = lastPublish?.opts?.extras?.headers?.[HEADER_CODEC_MESSAGE_ID];
      const runId = lastPublish?.opts?.extras?.headers?.[HEADER_RUN_ID];
      expect(optimisticMsgId).toBeDefined();
      if (!optimisticMsgId) throw new Error('expected optimistic codecMessageId on publish');

      // Echo the wire message with the same tree codecMessageId so the optimistic
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
            [HEADER_CODEC_MESSAGE_ID]: optimisticMsgId,
          },
          undefined,
          'message.create',
        ),
      );

      // The tree must contain exactly one Run — the optimistic insert,
      // converged with the echo. The Run's projection holds a single
      // domain message keyed by the codec's domain-id convention.
      expect(s.view.flattenNodes()).toHaveLength(1);
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
          [HEADER_CODEC_MESSAGE_ID]: 'a-1',
        }),
      );
      // Push finish to terminate the stream
      decoder.queue.push({ type: 'finish' });
      simulateMessage(
        ch,
        ablyMsg('text', {
          [HEADER_RUN_ID]: runId,
          [HEADER_INVOCATION_ID]: invocationId,
          [HEADER_CODEC_MESSAGE_ID]: 'a-1',
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
          [HEADER_CODEC_MESSAGE_ID]: 'm-z',
        }),
      );
      // fold should not have been called (no events)
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock check
      expect(fix.codec.fold).not.toHaveBeenCalled();
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

    it('continuation run reaches status=complete live after a terminal event closes the router stream mid-continuation', async () => {
      // End-to-end repro of the user-reported "stuck streaming" bug.
      // After the continuation streams its content, the codec emits a
      // terminal event (the Vercel codec marks `finish`/`error`/`abort`
      // terminal) and `route()` calls `closeStream(runId)` — wiping the
      // router entry. When the continuation's run-end then arrives the
      // gate found `routerActive === undefined` and fell back to the
      // tree's winning-invocation map, which stays pinned to the
      // original invocation because continuation wires skip the winner
      // update. The run-end was dropped as a losing-invocation echo and
      // the Run stayed at status=active forever — every bubble in the
      // chat showed "streaming". A page refresh recovered because
      // history replay bypasses the gate entirely.
      const initial = await fix.session.view.sendEvent({ type: 'user-message', text: 'hi' });

      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_END, {
          [HEADER_RUN_ID]: initial.runId,
          [HEADER_RUN_CLIENT_ID]: 'client-1',
          [HEADER_INVOCATION_ID]: initial.invocationId,
          [HEADER_RUN_REASON]: 'suspended',
        }),
      );

      const continuation = await fix.session.view.sendEvent([{ type: 'user-message', text: 'continue' }], {
        runId: initial.runId,
      });

      simulateMessage(
        fix.channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: initial.runId,
          [HEADER_RUN_CLIENT_ID]: 'client-1',
          [HEADER_INVOCATION_ID]: continuation.invocationId,
          'x-ably-run-continue': 'true',
        }),
      );

      // Simulate a terminal event arriving in the continuation stream —
      // route() will closeStream(runId) which deletes the router entry.
      fix.decoder.queue.push({ type: 'finish' });
      simulateMessage(
        fix.channel,
        ablyMsg('finish', {
          [HEADER_RUN_ID]: initial.runId,
          [HEADER_RUN_CLIENT_ID]: 'client-1',
          [HEADER_INVOCATION_ID]: continuation.invocationId,
          'x-ably-run-continue': 'true',
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

      // With the fix, the gate consults `_ownRunIds` first (which still
      // has the continuation's invocation-id), the gate passes, and
      // applyRunLifecycle marks the Run complete.
      expect(fix.session.tree.getRunNode(initial.runId)?.status).toBe('complete');
    });

    it('continuation run reaches status=complete live after suspended → continuation → complete sequence', async () => {
      // User-reported regression: after a tool-resolution / approval
      // continuation completes, the Run stays at status=active in the
      // live client even though channel-history replay rebuilds it as
      // status=complete. Repro the full sequence: first send →
      // run-end suspended → continuation send (rebinds router) →
      // run-end complete. R1.status must end at the continuation's
      // reason, otherwise the UI stays stuck on "streaming".
      const initial = await fix.session.view.sendEvent({ type: 'user-message', text: 'hi' });

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

      // Continuation send under the same runId — rebinds router to inv2.
      const continuation = await fix.session.view.sendEvent([{ type: 'user-message', text: 'continue' }], {
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
          'x-ably-run-continue': 'true',
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

    it('processes continuation run-end on an observer session (latestContinuation gate)', () => {
      // Observer-side reproduction of the multi-tab "stuck streaming" bug.
      // Observer clients have no `_ownRunIds` entry (they didn't send) and
      // no router stream bound to the run (only originators bind one).
      // The Tree's `getWinningInvocation` pins to the ORIGINAL prompt's
      // invocation because continuation wires deliberately don't advance
      // it. Without a dedicated continuation tracker, the continuation's
      // terminal `run-end` mismatches `treeWinner` and is dropped, leaving
      // the Run permanently `active` on the observer.
      //
      // The fix tracks the latest continuation invocation on the Tree and
      // consults it in the run-end gate ahead of `treeWinner`.
      const inv1 = 'inv-original';
      const inv2 = 'inv-continuation';
      const userMsgSerial = 'serial-user-msg';

      // Original prompt arrives — pins treeWinner to inv1.
      // Queue a decoder event so applyMessage doesn't bail out at the
      // "events.length === 0 && Run missing" guard before reaching
      // `_maybeUpdateWinningInvocation`.
      fix.decoder.queue.push({ type: 'user-message', text: 'hi' });
      simulateMessage(
        fix.channel,
        ablyMsg(
          'user-message',
          {
            [HEADER_RUN_ID]: 'run-obs',
            [HEADER_RUN_CLIENT_ID]: 'other-client',
            [HEADER_INVOCATION_ID]: inv1,
            'x-ably-role': 'user',
          },
          undefined,
          undefined,
          userMsgSerial,
        ),
      );

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
          'x-ably-run-continue': 'true',
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

      // Without the fix the continuation's run-end is dropped and status
      // stays at 'active'. With the fix the gate accepts it via
      // latestContinuation and the Run reaches a terminal state.
      expect(fix.session.tree.getRunNode('run-obs')?.status).toBe('complete');
    });

    it('processes continuation run-end (router-active invocation is fresh)', async () => {
      // Continuation rebinds the router stream to a new invocation while the
      // Tree's winner stays on the original user-message's invocation. The
      // gating must prefer the router for own runs so the continuation's
      // run-end is accepted and the run cleans up.
      const initial = await fix.session.view.sendEvent({ type: 'user-message', text: 'hi' });
      const continuation = await fix.session.view.sendEvent([{ type: 'user-message', text: 'more' }], {
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
    it('publishes a cancel message carrying x-ably-run-id', async () => {
      await fix.session.cancel('run-1');
      const cancelMsg = fix.channel.publishCalls.find((m) => m.name === 'ai-cancel');
      expect(cancelMsg).toBeDefined();
      const headers = (cancelMsg?.extras as { headers: Record<string, string> } | undefined)?.headers;
      expect(headers?.[HEADER_RUN_ID]).toBe('run-1');
    });

    it('closes the targeted run stream', async () => {
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

      await s.cancel(run.runId);
      const events = await drain(run.stream);
      expect(events).toEqual([]);
      await s.close();
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
      await fix.session.view.sendEvent({ type: 'user-message', text: 'hi' });
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
    it('publishes a regenerate event without upserting the tree or folding the projection', async () => {
      // Seed a user message in the tree first.
      await fix.session.view.sendEvent({ type: 'user-message', text: 'hi' });
      const runsBefore = fix.session.view.flattenNodes();
      expect(runsBefore).toHaveLength(1);
      const seedRunId = runsBefore[0]?.runId;
      const userMsgId = fix.session.view.getMessages()[0]?.id;
      expect(userMsgId).toBeDefined();

      // Send a regenerate event — wire-only, carries parent/forkOf on headers.
      await fix.session.view.sendEvent({
        type: 'regenerate-event',
        parent: userMsgId,
        forkOf: 'asst-1',
      });

      // No new Run materialised: the regenerate publishes wire-only and
      // skips both tree-upsert and projection fold. The original Run is
      // unchanged.
      const runsAfter = fix.session.view.flattenNodes();
      expect(runsAfter).toHaveLength(1);
      expect(runsAfter[0]?.runId).toBe(seedRunId);

      // The regenerate event was published on the channel with correct headers.
      const enc = fix.codec.lastEncoder();
      const regeneratePublish = enc?.publishCalls.find((c) => c.event.type === 'regenerate-event');
      expect(regeneratePublish).toBeDefined();
      const headers = regeneratePublish?.opts?.extras?.headers;
      expect(headers?.[HEADER_ROLE]).toBe('user');
      expect(headers?.[HEADER_PARENT]).toBe(userMsgId);
      // Regenerate stamps `x-ably-msg-regenerate` (not `x-ably-fork-of`):
      // the new Run is a continuation of the prior Run, not a Run-level fork.
      expect(headers?.['x-ably-msg-regenerate']).toBe('asst-1');
      expect(headers?.[HEADER_FORK_OF]).toBeUndefined();
      expect(headers?.[HEADER_EVENT_ID]).toBeDefined();
      expect(headers?.[HEADER_CODEC_MESSAGE_ID]).toBeDefined();
    });

    it('mints a fresh event-id for the regenerate event and forwards it in postBody.eventId', async () => {
      await fix.session.view.sendEvent({
        type: 'regenerate-event',
        parent: 'u1',
        forkOf: 'asst-1',
      });

      await fix.fetch.waitForCalls(1);
      const body = fix.fetch.body(0);
      expect(typeof body.eventId).toBe('string');

      const enc = fix.codec.lastEncoder();
      const regeneratePublish = enc?.publishCalls.find((c) => c.event.type === 'regenerate-event');
      const eventId = regeneratePublish?.opts?.extras?.headers?.[HEADER_EVENT_ID];
      expect(body.eventId).toBe(eventId);
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
