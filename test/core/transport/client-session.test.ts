import * as Ably from 'ably';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EVENT_RUN_END,
  EVENT_RUN_START,
  HEADER_AMEND,
  HEADER_FORK_OF,
  HEADER_MSG_ID,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_ID,
  HEADER_RUN_REASON,
  HEADER_STATUS,
} from '../../../src/constants.js';
import type { Codec, DecoderOutput, MessageAccumulator, StreamDecoder } from '../../../src/core/codec/types.js';
import { createClientSession } from '../../../src/core/transport/client-session.js';
import type { ClientSession, RunLifecycleEvent } from '../../../src/core/transport/types.js';
import { ErrorCode } from '../../../src/errors.js';
import { createMockClient } from '../../helper/mock-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestEvent {
  type: string;
  text?: string;
}

interface TestMessage {
  id: string;
  content: string;
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
// Mock channel (subscribe(callback) style — no name-based subscribe)
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
  listener: ((msg: Ably.InboundMessage) => void) | undefined;
  stateListeners: Set<Ably.channelEventCallback>;
}

interface MockHistoryPage {
  items: Ably.InboundMessage[];
  hasNext: () => boolean;
  next: () => Promise<MockHistoryPage>;
}

const createMockChannel = (): MockChannel & Ably.RealtimeChannel => {
  const stateListeners = new Set<Ably.channelEventCallback>();
  const mock: MockChannel = {
    listener: undefined,
    stateListeners,
    // Default to 'attached' so send() doesn't reject — it requires the
    // channel to be ATTACHED or ATTACHING.
    state: 'attached',
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    publish: vi.fn(() => Promise.resolve()),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    subscribe: vi.fn((callback: (msg: Ably.InboundMessage) => void) => {
      mock.listener = callback;
      return Promise.resolve();
    }),
    unsubscribe: vi.fn(),
    on: vi.fn((callback: Ably.channelEventCallback) => {
      stateListeners.add(callback);
    }),
    off: vi.fn((callback: Ably.channelEventCallback) => {
      stateListeners.delete(callback);
    }),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    attach: vi.fn(() => Promise.resolve()),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    history: vi.fn(() => {
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
      const emptyPage: MockHistoryPage = { items: [], hasNext: () => false, next: () => Promise.resolve(emptyPage) };
      return Promise.resolve(emptyPage);
    }),
  };
  // CAST: Tests only use publish/subscribe/unsubscribe/on/off/attach/history — other members are unused.
  return mock as unknown as MockChannel & Ably.RealtimeChannel;
};

/**
 * Simulate an Ably message arriving on the channel.
 * @param ch - The mock channel with a listener.
 * @param msg - The inbound message to deliver.
 */
const simulateMessage = (ch: MockChannel, msg: Ably.InboundMessage): void => {
  if (ch.listener) ch.listener(msg);
};

/**
 * Simulate a channel state change event.
 * @param ch - The mock channel with state listeners.
 * @param stateChange - The state change to emit.
 */
const simulateStateChange = (ch: MockChannel, stateChange: Ably.ChannelStateChange): void => {
  for (const listener of ch.stateListeners) {
    listener(stateChange);
  }
};

/**
 * Simulate the initial attach so the transport doesn't treat
 * subsequent state changes as the first attach.
 * @param ch - The mock channel to simulate initial attach on.
 */
const simulateInitialAttach = (ch: MockChannel): void => {
  simulateStateChange(ch, {
    current: 'attached',
    previous: 'attaching',
    resumed: false,
  } as Ably.ChannelStateChange);
};

/**
 * Build a minimal Ably InboundMessage with extras.headers.
 * @param name - Message name.
 * @param headers - Message headers.
 * @param data - Optional message data.
 * @param action - Ably message action. Defaults to 'message.create'.
 * @returns A partial InboundMessage suitable for testing.
 */
const ablyMsg = (
  name: string,
  headers: Record<string, string>,
  data?: unknown,
  action = 'message.create',
): Ably.InboundMessage =>
  ({
    name,
    data,
    action,
    extras: { headers },
    serial: `serial-${String(Date.now())}-${String(Math.random())}`,
  }) as unknown as Ably.InboundMessage;

// ---------------------------------------------------------------------------
// Mock codec
// ---------------------------------------------------------------------------

const createMockDecoder = (): StreamDecoder<TestEvent, TestMessage> & {
  outputs: DecoderOutput<TestEvent, TestMessage>[];
} => {
  const outputs: DecoderOutput<TestEvent, TestMessage>[] = [];
  return {
    outputs,
    decode: vi.fn(() => {
      const result = [...outputs];
      outputs.length = 0;
      return result;
    }),
  };
};

const createMockAccumulator = (): MessageAccumulator<TestEvent, TestMessage> => ({
  processOutputs: vi.fn(),
  updateMessage: vi.fn(),
  initMessage: vi.fn(),
  completeMessage: vi.fn(),
  messages: [],
  completedMessages: [],
  hasActiveStream: false,
});

const createMockCodec = (decoderInstance: ReturnType<typeof createMockDecoder>): Codec<TestEvent, TestMessage> => ({
  createEncoder: vi.fn(),
  createDecoder: vi.fn(() => decoderInstance),
  createAccumulator: vi.fn(() => createMockAccumulator()),
  isTerminal: vi.fn((event: TestEvent) => event.type === 'finish'),
});

// ---------------------------------------------------------------------------
// Drain helper
// ---------------------------------------------------------------------------

/**
 * Drain a ReadableStream into an array.
 * @param stream - The stream to drain.
 * @returns All enqueued values.
 */
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

// ---------------------------------------------------------------------------
// Flush helper
// ---------------------------------------------------------------------------

/** Flush microtasks (but NOT macrotasks) so fire-and-forget promises resolve. */
const flushMicrotasks = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
};

/**
 * Create a seeded session with messages already in the tree, where each
 * message carries a proper x-ably-msg-id header matching its id. This
 * enables _getHistoryBefore to find the correct truncation point.
 * @param codec - The codec to use.
 * @param mockFetch - The mock fetch to use.
 * @param messages - Seed messages.
 * @returns A new client session with seeded messages.
 */
const createSeededSession = async (
  codec: Codec<TestEvent, TestMessage>,
  mockFetch: MockFetch,
  messages: TestMessage[],
): Promise<ClientSession<TestEvent, TestMessage>> => {
  const ch = createMockChannel();
  const session = createClientSession({
    client: createMockClient(ch),
    channelName: 'test-channel',
    codec,
    clientId: 'client-1',
    api: '/test',
    fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
  });
  await session.connect();

  // Manually upsert messages with proper HEADER_MSG_ID so truncation works
  const tree = session.tree;
  let prevMsgId: string | undefined;
  for (const msg of messages) {
    const headers: Record<string, string> = { [HEADER_MSG_ID]: msg.id };
    if (prevMsgId) headers[HEADER_PARENT] = prevMsgId;
    tree.upsert(msg.id, msg, headers);
    prevMsgId = msg.id;
  }

  return session;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClientSession', () => {
  let channel: MockChannel & Ably.RealtimeChannel;
  let decoder: ReturnType<typeof createMockDecoder>;
  let codec: Codec<TestEvent, TestMessage>;
  let mockFetch: MockFetch;
  let session: ClientSession<TestEvent, TestMessage>;

  beforeEach(async () => {
    channel = createMockChannel();
    decoder = createMockDecoder();
    codec = createMockCodec(decoder);
    mockFetch = createMockFetch();
    session = createClientSession({
      client: createMockClient(channel),
      channelName: 'test-channel',
      codec,
      clientId: 'client-1',
      api: '/api/chat',
      fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
    });
    await session.connect();
  });

  afterEach(async () => {
    await session.close();
  });

  // -------------------------------------------------------------------------
  // connect() contract
  // -------------------------------------------------------------------------

  describe('connect() contract', () => {
    it('connect() is idempotent — multiple calls return the same subscribe', async () => {
      const ch = createMockChannel();
      const s = createClientSession({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec,
        api: '/api/chat',
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });
      const p1 = s.connect();
      const p2 = s.connect();
      expect(p1).toBe(p2);
      await Promise.all([p1, p2]);
      // 1 subscribe in beforeEach (with the outer session) + 1 here = 2 total on this channel mock,
      // but the new session uses a fresh channel mock, so only 1.
      expect(ch.subscribe).toHaveBeenCalledTimes(1);
      await s.close();
    });

    it('send() throws InvalidArgument if connect() was not called', async () => {
      const ch = createMockChannel();
      const s = createClientSession({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec,
        clientId: 'client-1',
        api: '/api/chat',
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });
      await expect(s.view.send({ id: '1', content: 'hi' })).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
      await s.close();
    });

    it('cancel() throws InvalidArgument if connect() was not called', async () => {
      const ch = createMockChannel();
      const s = createClientSession({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec,
        clientId: 'client-1',
        api: '/api/chat',
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });
      await expect(s.cancel()).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
      await s.close();
    });

    it('waitForRun() throws InvalidArgument if connect() was not called', async () => {
      const ch = createMockChannel();
      const s = createClientSession({
        client: createMockClient(ch),
        channelName: 'test-channel',
        codec,
        clientId: 'client-1',
        api: '/api/chat',
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });
      await expect(s.waitForRun()).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
      await s.close();
    });
  });

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  describe('construction', () => {
    it('subscribes to the channel with a callback', () => {
      expect(channel.subscribe).toHaveBeenCalledWith(expect.any(Function));
    });

    it('creates a decoder from the codec', () => {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      expect(codec.createDecoder).toHaveBeenCalled();
    });

    it('seeds initial messages into the tree', () => {
      const seeded = createClientSession({
        client: createMockClient(createMockChannel()),
        channelName: 'test-channel',
        codec,
        api: '/test',
        messages: [
          { id: 'msg-1', content: 'hello' },
          { id: 'msg-2', content: 'world' },
        ],
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });

      const messages = seeded.view.flattenNodes().map((n) => n.message);
      expect(messages).toHaveLength(2);
      expect(messages[0]?.id).toBe('msg-1');
      expect(messages[1]?.id).toBe('msg-2');
    });

    it('seeded messages form a parent chain in the tree', () => {
      const seeded = createClientSession({
        client: createMockClient(createMockChannel()),
        channelName: 'test-channel',
        codec,
        api: '/test',
        messages: [
          { id: 'msg-1', content: 'first' },
          { id: 'msg-2', content: 'second' },
        ],
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });

      const nodes = seeded.view.flattenNodes();
      expect(nodes).toHaveLength(2);
      expect(nodes[1]?.parentId).toBe(nodes[0]?.msgId);
    });

    it('works with no initial messages', async () => {
      const empty = createClientSession({
        client: createMockClient(createMockChannel()),
        channelName: 'test-channel',
        codec,
        api: '/test',
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });
      await empty.connect();
      expect(empty.view.flattenNodes()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // send()
  // -------------------------------------------------------------------------

  describe('send', () => {
    it('returns an ActiveRun with stream, runId, and cancel', async () => {
      const run = await session.view.send({ id: 'user-1', content: 'hi' });
      expect(run.stream).toBeInstanceOf(ReadableStream);
      expect(typeof run.runId).toBe('string');
      expect(typeof run.cancel).toBe('function');
    });

    it('inserts optimistic user messages into the tree', async () => {
      await session.view.send({ id: 'user-1', content: 'hello' });

      const messages = session.view.flattenNodes().map((n) => n.message);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.content).toBe('hello');
    });

    it('auto-computes parent from the last message in the tree', async () => {
      const seeded = createClientSession({
        client: createMockClient(createMockChannel()),
        channelName: 'test-channel',
        codec,
        clientId: 'client-1',
        api: '/test',
        messages: [{ id: 'seed-1', content: 'first' }],
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });
      await seeded.connect();

      // Get the session-assigned msgId of the seed message
      const seedNode = seeded.view.flattenNodes()[0];
      expect(seedNode).toBeDefined();

      await seeded.view.send({ id: 'user-1', content: 'second' });
      await mockFetch.waitForCalls(1);

      const body = mockFetch.body(0);
      expect(body.parent).toBe(seedNode?.msgId);

      await seeded.close();
    });

    it('fires HTTP POST with correct body', async () => {
      const run = await session.view.send({ id: 'user-1', content: 'hello' });
      await mockFetch.waitForCalls(1);

      expect(mockFetch.calls[0]?.url).toBe('/api/chat');
      const body = mockFetch.body(0);
      expect(body.runId).toBe(run.runId);
      expect(body.clientId).toBe('client-1');
      expect(body.messages).toBeDefined();
      expect(body.history).toBeDefined();
      expect(Array.isArray(body.messages)).toBe(true);
    });

    it('does not include the new message in history (avoids duplication)', async () => {
      await session.view.send({ id: 'user-1', content: 'hello' });
      await mockFetch.waitForCalls(1);

      const body = mockFetch.body(0);
      const historyIds = (body.history as { message: { id: string } }[]).map((h) => h.message.id);
      const messageIds = (body.messages as { message: { id: string } }[]).map((m) => m.message.id);

      // The new message should only appear in messages, not in history
      for (const id of messageIds) {
        expect(historyIds).not.toContain(id);
      }
    });

    it('includes Content-Type header in POST', async () => {
      await session.view.send({ id: 'user-1', content: 'hello' });
      await mockFetch.waitForCalls(1);

      const headers = mockFetch.calls[0]?.init.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('stream is available before POST completes (fire-and-forget)', async () => {
      const blockingFetch = vi.fn(
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- intentionally returns unresolved promise
        () =>
          new Promise<Response>(() => {
            // never resolves
          }),
      );
      const blockSession = createClientSession({
        client: createMockClient(createMockChannel()),
        channelName: 'test-channel',
        codec,
        api: '/test',
        fetch: blockingFetch as unknown as typeof globalThis.fetch,
      });
      await blockSession.connect();

      const run = await blockSession.view.send({ id: 'u1', content: 'hi' });
      expect(run.stream).toBeInstanceOf(ReadableStream);

      await blockSession.close();
    });

    it('POST body messages include msg-id and role headers', async () => {
      await session.view.send({ id: 'user-1', content: 'hello' });
      await mockFetch.waitForCalls(1);

      const body = mockFetch.body(0);
      const messages = body.messages as { message: TestMessage; headers: Record<string, string> }[];
      expect(messages[0]?.headers['x-ably-msg-id']).toBeDefined();
      expect(messages[0]?.headers['x-ably-role']).toBe('user');
    });

    it('merges sendOptions.body into the POST body', async () => {
      await session.view.send({ id: 'u1', content: 'hi' }, { body: { customField: 'val' } });
      await mockFetch.waitForCalls(1);

      const body = mockFetch.body(0);
      expect(body.customField).toBe('val');
    });

    it('merges sendOptions.headers into the POST headers', async () => {
      await session.view.send({ id: 'u1', content: 'hi' }, { headers: { 'X-Custom': 'token' } });
      await mockFetch.waitForCalls(1);

      const headers = mockFetch.calls[0]?.init.headers as Record<string, string>;
      expect(headers['X-Custom']).toBe('token');
    });

    it('includes forkOf in POST body when set in sendOptions', async () => {
      await session.view.send({ id: 'u1', content: 'hi' }, { forkOf: 'msg-original' });
      await mockFetch.waitForCalls(1);

      const body = mockFetch.body(0);
      expect(body.forkOf).toBe('msg-original');
    });

    it('fires error event when POST fails with non-OK status', async () => {
      const failFetch = createMockFetch(500);
      const failSession = createClientSession({
        client: createMockClient(createMockChannel()),
        channelName: 'test-channel',
        codec,
        api: '/test',
        fetch: failFetch.fn as unknown as typeof globalThis.fetch,
      });
      await failSession.connect();

      const errors: Ably.ErrorInfo[] = [];
      failSession.on('error', (e) => errors.push(e));

      await failSession.view.send({ id: 'u1', content: 'hi' });
      await failFetch.waitForCalls(1);
      await flushMicrotasks();

      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe(ErrorCode.SessionSendFailed);

      await failSession.close();
    });

    it('fires error event when POST throws a network error', async () => {
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.reject directly
      const errorFetch = vi.fn(() => Promise.reject(new Error('network down')));
      const errorSession = createClientSession({
        client: createMockClient(createMockChannel()),
        channelName: 'test-channel',
        codec,
        api: '/test',
        fetch: errorFetch as unknown as typeof globalThis.fetch,
      });
      await errorSession.connect();

      const errors: Ably.ErrorInfo[] = [];
      errorSession.on('error', (e) => errors.push(e));

      await errorSession.view.send({ id: 'u1', content: 'hi' });
      await flushMicrotasks();

      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe(ErrorCode.SessionSendFailed);
      expect(errors[0]?.message).toContain('network down');

      await errorSession.close();
    });

    it('errors the stream when POST fails', async () => {
      const failFetch = createMockFetch(500);
      const failSession = createClientSession({
        client: createMockClient(createMockChannel()),
        channelName: 'test-channel',
        codec,
        api: '/test',
        fetch: failFetch.fn as unknown as typeof globalThis.fetch,
      });
      await failSession.connect();

      failSession.on('error', () => {
        /* consume error */
      });

      const run = await failSession.view.send({ id: 'u1', content: 'hi' });
      await failFetch.waitForCalls(1);
      await flushMicrotasks();

      const reader = run.stream.getReader();
      await expect(reader.read()).rejects.toBeErrorInfoWithCode(ErrorCode.SessionSendFailed);

      await failSession.close();
    });

    it('errors the stream when POST throws a network error', async () => {
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.reject directly
      const errorFetch = vi.fn(() => Promise.reject(new Error('network down')));
      const errorSession = createClientSession({
        client: createMockClient(createMockChannel()),
        channelName: 'test-channel',
        codec,
        api: '/test',
        fetch: errorFetch as unknown as typeof globalThis.fetch,
      });
      await errorSession.connect();

      errorSession.on('error', () => {
        /* consume error */
      });

      const run = await errorSession.view.send({ id: 'u1', content: 'hi' });
      await flushMicrotasks();

      const reader = run.stream.getReader();
      await expect(reader.read()).rejects.toBeErrorInfoWithCode(ErrorCode.SessionSendFailed);

      await errorSession.close();
    });

    it('throws when session is closed', async () => {
      await session.close();
      await expect(session.view.send({ id: 'u1', content: 'hi' })).rejects.toThrow('view is closed');
    });

    it('createView throws when session is closed', async () => {
      await session.close();
      expect(() => session.createView()).toThrow('session is closed');
    });

    for (const state of ['failed', 'suspended', 'detached', 'initialized'] as const) {
      it(`throws when channel is ${state}`, async () => {
        simulateInitialAttach(channel);
        channel.state = state;

        await expect(session.view.send({ id: 'u1', content: 'hi' })).rejects.toBeErrorInfoWithCode(
          ErrorCode.ChannelNotReady,
        );

        await session.close();
      });
    }

    it('allows send when channel is ATTACHING', async () => {
      simulateInitialAttach(channel);
      channel.state = 'attaching';

      const run = await session.view.send({ id: 'u1', content: 'hi' });
      expect(run.stream).toBeInstanceOf(ReadableStream);

      await session.close();
    });

    it('merges dynamic options.headers and options.body', async () => {
      const dynSession = createClientSession({
        client: createMockClient(createMockChannel()),
        channelName: 'test-channel',
        codec,
        api: '/test',
        headers: () => ({ 'X-Auth': 'bearer-token' }),
        body: () => ({ sessionId: 'abc' }),
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });
      await dynSession.connect();

      await dynSession.view.send({ id: 'u1', content: 'hi' });
      await mockFetch.waitForCalls(1);

      const headers = mockFetch.calls[0]?.init.headers as Record<string, string>;
      expect(headers['X-Auth']).toBe('bearer-token');

      const body = mockFetch.body(0);
      expect(body.sessionId).toBe('abc');

      await dynSession.close();
    });

    it('includes credentials option in fetch when configured', async () => {
      const credSession = createClientSession({
        client: createMockClient(createMockChannel()),
        channelName: 'test-channel',
        codec,
        api: '/test',
        credentials: 'include',
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });
      await credSession.connect();

      await credSession.view.send({ id: 'u1', content: 'hi' });
      await mockFetch.waitForCalls(1);

      const callArgs = vi.mocked(mockFetch.fn).mock.calls[0] as [string, RequestInit];
      expect(callArgs[1].credentials).toBe('include');

      await credSession.close();
    });

    it('handles array of messages', async () => {
      const run = await session.view.send([
        { id: 'u1', content: 'a' },
        { id: 'u2', content: 'b' },
      ]);
      await mockFetch.waitForCalls(1);

      const body = mockFetch.body(0);
      const messages = body.messages as { message: TestMessage }[];
      expect(messages).toHaveLength(2);
      expect(run.runId).toBeDefined();
    });

    it('sets explicit parent when provided in sendOptions', async () => {
      await session.view.send({ id: 'u1', content: 'hi' }, { parent: 'explicit-parent' });
      await mockFetch.waitForCalls(1);

      const body = mockFetch.body(0);
      expect(body.parent).toBe('explicit-parent');
    });

    it('does not auto-compute parent when forkOf is set', async () => {
      const seeded = createClientSession({
        client: createMockClient(createMockChannel()),
        channelName: 'test-channel',
        codec,
        api: '/test',
        messages: [{ id: 'seed-1', content: 'first' }],
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });
      await seeded.connect();

      await seeded.view.send({ id: 'u1', content: 'hi' }, { forkOf: 'seed-1' });
      await mockFetch.waitForCalls(1);

      // forkOf skips autoParent computation — parent should not be auto-computed
      const body = mockFetch.body(0);
      expect(body.forkOf).toBe('seed-1');
      expect(body.parent).toBeUndefined();

      await seeded.close();
    });

    it('stamps forkOf on optimistic message headers', async () => {
      await session.view.send({ id: 'u1', content: 'hi' }, { forkOf: 'original-msg' });

      const nodes = session.view.flattenNodes();
      expect(nodes[0]?.headers[HEADER_FORK_OF]).toBe('original-msg');
    });

    it('stamps role on optimistic message headers', async () => {
      await session.view.send({ id: 'u1', content: 'hi' });

      const nodes = session.view.flattenNodes();
      expect(nodes[0]?.headers[HEADER_ROLE]).toBe('user');
    });

    it('stamps runId on optimistic message headers', async () => {
      const run = await session.view.send({ id: 'u1', content: 'hi' });

      const nodes = session.view.flattenNodes();
      expect(nodes[0]?.headers[HEADER_RUN_ID]).toBe(run.runId);
    });

    it('generates unique runId for each send', async () => {
      const run1 = await session.view.send({ id: 'u1', content: 'a' });
      const run2 = await session.view.send({ id: 'u2', content: 'b' });
      expect(run1.runId).not.toBe(run2.runId);
    });
  });

  // -------------------------------------------------------------------------
  // Message routing
  // -------------------------------------------------------------------------

  describe('message routing', () => {
    it('records incoming Ably messages via ably-message event', () => {
      const received: Ably.InboundMessage[] = [];
      session.tree.on('ably-message', (msg) => received.push(msg));

      simulateMessage(channel, ablyMsg('some-event', { [HEADER_RUN_ID]: 'run-1' }));

      expect(received).toHaveLength(1);
    });

    it('handles run-start event by updating active runs', () => {
      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-1',
          [HEADER_RUN_CLIENT_ID]: 'client-1',
        }),
      );

      const activeRuns = session.tree.getActiveRunIds();
      const clientRuns = activeRuns.get('client-1');
      expect(clientRuns?.has('run-1')).toBe(true);
    });

    it('handles run-end event by removing from active runs', () => {
      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-1',
          [HEADER_RUN_CLIENT_ID]: 'client-1',
        }),
      );
      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_END, {
          [HEADER_RUN_ID]: 'run-1',
          [HEADER_RUN_CLIENT_ID]: 'client-1',
          [HEADER_RUN_REASON]: 'complete',
        }),
      );

      const activeRuns = session.tree.getActiveRunIds();
      expect(activeRuns.size).toBe(0);
    });

    it('emits run lifecycle events via on("run")', () => {
      const events: RunLifecycleEvent[] = [];
      session.tree.on('run', (e) => events.push(e));

      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-1',
          [HEADER_RUN_CLIENT_ID]: 'client-1',
        }),
      );
      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_END, {
          [HEADER_RUN_ID]: 'run-1',
          [HEADER_RUN_CLIENT_ID]: 'client-1',
          [HEADER_RUN_REASON]: 'complete',
        }),
      );

      expect(events).toHaveLength(2);
      expect(events[0]?.type).toBe(EVENT_RUN_START);
      expect(events[1]?.type).toBe(EVENT_RUN_END);
      if (events[1]?.type === EVENT_RUN_END) {
        expect(events[1].reason).toBe('complete');
      }
    });

    it('defaults run-end reason to complete when missing', () => {
      const events: RunLifecycleEvent[] = [];
      session.tree.on('run', (e) => events.push(e));

      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-1',
          [HEADER_RUN_CLIENT_ID]: 'client-1',
        }),
      );
      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_END, {
          [HEADER_RUN_ID]: 'run-1',
          [HEADER_RUN_CLIENT_ID]: 'client-1',
          // no HEADER_RUN_REASON
        }),
      );

      expect(events).toHaveLength(2);
      expect(events[1]?.type).toBe(EVENT_RUN_END);
      if (events[1]?.type === EVENT_RUN_END) {
        expect(events[1].reason).toBe('complete');
      }
    });

    it('defaults run-client-id to empty string when missing', () => {
      const events: RunLifecycleEvent[] = [];
      session.tree.on('run', (e) => events.push(e));

      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-1',
          // no HEADER_RUN_CLIENT_ID
        }),
      );

      expect(events[0]?.clientId).toBe('');
    });

    it('ignores run-start without runId', () => {
      const events: RunLifecycleEvent[] = [];
      session.tree.on('run', (e) => events.push(e));

      simulateMessage(channel, ablyMsg(EVENT_RUN_START, {}));

      expect(events).toHaveLength(0);
    });

    it('ignores run-end without runId', () => {
      const events: RunLifecycleEvent[] = [];
      session.tree.on('run', (e) => events.push(e));

      simulateMessage(channel, ablyMsg(EVENT_RUN_END, {}));

      expect(events).toHaveLength(0);
    });

    it('routes decoded events to own run stream', async () => {
      const run = await session.view.send({ id: 'u1', content: 'hi' });
      await mockFetch.waitForCalls(1);

      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'hello' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_RUN_ID]: run.runId }));

      decoder.outputs.push({ kind: 'event', event: { type: 'finish' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_RUN_ID]: run.runId }));

      const items = await drain(run.stream);
      expect(items).toEqual([{ type: 'text', text: 'hello' }, { type: 'finish' }]);
    });

    it('reconciles optimistic entry when relayed own message arrives (msg-id match)', async () => {
      const run = await session.view.send({ id: 'u1', content: 'hello' });
      await mockFetch.waitForCalls(1);

      const body = mockFetch.body(0);
      const postMessages = body.messages as { headers: Record<string, string> }[];
      const msgId = postMessages[0]?.headers['x-ably-msg-id'] ?? '';

      decoder.outputs.push({ kind: 'message', message: { id: 'u1', content: 'hello-from-server' } });
      simulateMessage(
        channel,
        ablyMsg('user-msg', {
          [HEADER_MSG_ID]: msgId,
          [HEADER_RUN_ID]: run.runId,
        }),
      );

      const messages = session.view.flattenNodes().map((n) => n.message);
      const matching = messages.filter((m) => m.content === 'hello-from-server');
      expect(matching).toHaveLength(1);
    });

    it('inserts new message into tree for non-own message.create', () => {
      decoder.outputs.push({ kind: 'message', message: { id: 'new-msg', content: 'from-other' } });
      simulateMessage(
        channel,
        ablyMsg(
          'user-msg',
          {
            [HEADER_MSG_ID]: 'msg-other',
            [HEADER_RUN_ID]: 'run-other',
          },
          undefined,
          'message.create',
        ),
      );

      const messages = session.view.flattenNodes().map((n) => n.message);
      expect(messages.some((m) => m.id === 'new-msg')).toBe(true);
    });

    it('skips non-create messages that are not relayed own messages', () => {
      decoder.outputs.push({ kind: 'message', message: { id: 'updated-msg', content: 'updated' } });
      simulateMessage(
        channel,
        ablyMsg(
          'user-msg',
          {
            [HEADER_MSG_ID]: 'msg-unknown',
            [HEADER_RUN_ID]: 'run-other',
          },
          undefined,
          'message.update', // Not message.create
        ),
      );

      const messages = session.view.flattenNodes().map((n) => n.message);
      expect(messages.some((m) => m.id === 'updated-msg')).toBe(false);
    });

    it('skips event without runId', () => {
      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'orphan' } });
      // No HEADER_RUN_ID
      simulateMessage(channel, ablyMsg('codec-msg', {}));

      // Should not throw — just skip
      expect(session.view.flattenNodes().map((n) => n.message)).toEqual([]);
    });

    it('fires ably-message handler on each incoming message', () => {
      const handler = vi.fn();
      session.tree.on('ably-message', handler);

      simulateMessage(channel, ablyMsg(EVENT_RUN_START, { [HEADER_RUN_ID]: 'run-1' }));
      simulateMessage(channel, ablyMsg(EVENT_RUN_END, { [HEADER_RUN_ID]: 'run-1' }));

      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('fires error event when decoder throws', () => {
      const errors: Ably.ErrorInfo[] = [];
      session.on('error', (e) => errors.push(e));

      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      vi.mocked(decoder.decode).mockImplementationOnce(() => {
        throw new Error('decode boom');
      });

      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_RUN_ID]: 'run-1' }));

      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe(ErrorCode.SessionSubscriptionError);
      expect(errors[0]?.message).toContain('decode boom');
    });

    it('ignores messages after close', async () => {
      const handler = vi.fn();
      session.view.on('update', handler);

      await session.close();
      simulateMessage(channel, ablyMsg(EVENT_RUN_START, { [HEADER_RUN_ID]: 'run-1' }));

      expect(handler).not.toHaveBeenCalled();
    });

    it('closes stream on run-end for own run', async () => {
      const run = await session.view.send({ id: 'u1', content: 'hi' });
      await mockFetch.waitForCalls(1);

      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'data' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_RUN_ID]: run.runId }));

      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_END, {
          [HEADER_RUN_ID]: run.runId,
          [HEADER_RUN_CLIENT_ID]: 'client-1',
        }),
      );

      const items = await drain(run.stream);
      expect(items).toEqual([{ type: 'text', text: 'data' }]);
    });

    it('accumulates observer run events into messages via on("message")', () => {
      const mockAccum = createMockAccumulator();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      vi.mocked(codec.createAccumulator).mockReturnValue(mockAccum);

      const messageHandler = vi.fn();
      session.view.on('update', messageHandler);

      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'other-run',
          [HEADER_RUN_CLIENT_ID]: 'other-client',
        }),
      );

      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'observed' } });

      Object.defineProperty(mockAccum, 'messages', {
        get: () => [{ id: 'acc-msg', content: 'accumulated' }],
      });

      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_RUN_ID]: 'other-run', [HEADER_MSG_ID]: 'obs-1' }));

      expect(messageHandler).toHaveBeenCalled();
    });

    it('cleans up observer accumulator on terminal event', () => {
      const mockAccum = createMockAccumulator();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      vi.mocked(codec.createAccumulator).mockReturnValue(mockAccum);

      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'other-run',
          [HEADER_RUN_CLIENT_ID]: 'other-client',
        }),
      );

      // First non-terminal event creates accumulator
      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'data' } });
      Object.defineProperty(mockAccum, 'messages', {
        get: () => [{ id: 'acc-msg', content: 'accumulated' }],
        configurable: true,
      });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_RUN_ID]: 'other-run' }));

      // Terminal event cleans up (observer accumulator.cleanup is called internally)
      decoder.outputs.push({ kind: 'event', event: { type: 'finish' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_RUN_ID]: 'other-run' }));

      // Subsequent events for same run should create a new accumulator
      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'new-data' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_RUN_ID]: 'other-run' }));

      // createAccumulator should have been called more than once (initial + after cleanup)
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      expect(vi.mocked(codec.createAccumulator).mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('also accumulates own run events for the message store', async () => {
      const mockAccum = createMockAccumulator();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      vi.mocked(codec.createAccumulator).mockReturnValue(mockAccum);

      const run = await session.view.send({ id: 'u1', content: 'hi' });
      await mockFetch.waitForCalls(1);

      const messageHandler = vi.fn();
      session.view.on('update', messageHandler);

      Object.defineProperty(mockAccum, 'messages', {
        get: () => [{ id: 'asst-msg', content: 'response' }],
        configurable: true,
      });

      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'hello' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_RUN_ID]: run.runId, [HEADER_MSG_ID]: 'asst-1' }));

      // Own run events are both routed to the stream AND accumulated
      expect(messageHandler).toHaveBeenCalled();
    });

    it('skips late arrival events for completed own runs', async () => {
      const run = await session.view.send({ id: 'u1', content: 'hi' });
      await mockFetch.waitForCalls(1);

      // Route some events and close the stream via terminal
      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'data' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_RUN_ID]: run.runId }));

      decoder.outputs.push({ kind: 'event', event: { type: 'finish' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_RUN_ID]: run.runId }));

      const items = await drain(run.stream);
      expect(items).toHaveLength(2);

      // Late arrival — should be skipped, not accumulated as observer run
      const nodeCountBefore = session.view.flattenNodes().length;

      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'late' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_RUN_ID]: run.runId }));

      // The own run's observer accumulator was cleaned up on stream completion,
      // so the late event should not produce new tree nodes.
      expect(session.view.flattenNodes()).toHaveLength(nodeCountBefore);
    });

    it('captures observer headers from streamed events', () => {
      const mockAccum = createMockAccumulator();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      vi.mocked(codec.createAccumulator).mockReturnValue(mockAccum);

      Object.defineProperty(mockAccum, 'messages', {
        get: () => [{ id: 'acc-msg', content: 'accumulated' }],
        configurable: true,
      });

      const messageHandler = vi.fn();
      session.view.on('update', messageHandler);

      // First event from an observer run sets initial headers
      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'data' } });
      simulateMessage(
        channel,
        ablyMsg('codec-msg', {
          [HEADER_RUN_ID]: 'other-run',
          [HEADER_MSG_ID]: 'other-msg',
        }),
      );

      expect(messageHandler).toHaveBeenCalled();
    });

    it('updates observer headers even when decoder produces no outputs', async () => {
      const mockAccum = createMockAccumulator();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      vi.mocked(codec.createAccumulator).mockReturnValue(mockAccum);
      Object.defineProperty(mockAccum, 'messages', {
        get: () => [{ id: 'acc-msg', content: 'partial' }],
        configurable: true,
      });

      const run = await session.view.send({ id: 'u1', content: 'hi' });
      await mockFetch.waitForCalls(1);

      // Stream an event to establish the observer with x-ably-status: streaming
      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'hello' } });
      simulateMessage(
        channel,
        ablyMsg('codec-msg', {
          [HEADER_RUN_ID]: run.runId,
          [HEADER_MSG_ID]: 'msg-1',
          [HEADER_STATUS]: 'streaming',
        }),
      );

      // Cancel to close the stream (but keep observer alive)
      await session.cancel({ runId: run.runId });

      // Simulate an aborted stream append — decoder produces NO outputs
      // but the headers should still be captured on the observer
      decoder.outputs.length = 0;
      simulateMessage(
        channel,
        ablyMsg('codec-msg', {
          [HEADER_RUN_ID]: run.runId,
          [HEADER_MSG_ID]: 'msg-1',
          [HEADER_STATUS]: 'aborted',
        }),
      );

      // Now the abort discrete event arrives and triggers accumulate+emit
      decoder.outputs.push({ kind: 'event', event: { type: 'finish' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_RUN_ID]: run.runId, [HEADER_MSG_ID]: 'msg-1' }));

      // The tree node should have the updated x-ably-status: aborted
      const node = session.tree.getNode('msg-1');
      expect(node?.headers[HEADER_STATUS]).toBe('aborted');
    });

    it('assistant message is visible when two user messages are sent in a single run', async () => {
      // Regression: when send() publishes multiple user messages, the
      // observer serial was pinned to the first user relay's serial. The
      // accumulated assistant node inherited that early serial and sorted
      // *before* the second user message in the tree — its parent — making
      // it unreachable in flatten().

      const mockAccum = createMockAccumulator();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      vi.mocked(codec.createAccumulator).mockReturnValue(mockAccum);

      // Seed one prior assistant message so the user messages have a parent
      const tree = session.tree;
      tree.upsert(
        'prev-asst',
        { id: 'prev-asst', content: 'London story' },
        {
          [HEADER_MSG_ID]: 'prev-asst',
          [HEADER_ROLE]: 'assistant',
        },
        'serial-0000',
      );

      // --- send two user messages in one run ---
      const run = await session.view.send([
        { id: 'u1', content: 'Actually, about Paris' },
        { id: 'u2', content: 'No Milan' },
      ]);
      await mockFetch.waitForCalls(1);

      // Retrieve the client-generated msg IDs from the POST body
      const body = mockFetch.body(0);
      const postMessages = body.messages as { headers: Record<string, string> }[];
      const msg1Id = postMessages[0]?.headers[HEADER_MSG_ID] ?? '';
      const msg2Id = postMessages[1]?.headers[HEADER_MSG_ID] ?? '';

      // --- simulate server run-start ---
      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: run.runId,
          [HEADER_RUN_CLIENT_ID]: 'client-1',
        }),
      );

      // --- simulate server relays for both user messages ---
      // These are 'message' outputs (relayed own messages) that promote the serial.
      decoder.outputs.push({ kind: 'message', message: { id: 'u1', content: 'Actually, about Paris' } });
      simulateMessage(channel, {
        name: 'text',
        data: 'Actually, about Paris',
        action: 'message.create',
        extras: {
          headers: {
            [HEADER_RUN_ID]: run.runId,
            [HEADER_MSG_ID]: msg1Id,
            [HEADER_PARENT]: 'prev-asst',
            [HEADER_ROLE]: 'user',
          },
        },
        serial: 'serial-0001',
      } as unknown as Ably.InboundMessage);

      // msg2 is chained off msg1 (not a sibling under prev-asst)
      decoder.outputs.push({ kind: 'message', message: { id: 'u2', content: 'No Milan' } });
      simulateMessage(channel, {
        name: 'text',
        data: 'No Milan',
        action: 'message.create',
        extras: {
          headers: {
            [HEADER_RUN_ID]: run.runId,
            [HEADER_MSG_ID]: msg2Id,
            [HEADER_PARENT]: msg1Id,
            [HEADER_ROLE]: 'user',
          },
        },
        serial: 'serial-0002',
      } as unknown as Ably.InboundMessage);

      // --- simulate assistant response events ---
      // The accumulator returns the assistant message when queried.
      Object.defineProperty(mockAccum, 'messages', {
        get: () => [{ id: 'asst-milan', content: 'The Violin Maker...' }],
        configurable: true,
      });

      // 'start' event — discrete, no stream
      decoder.outputs.push({ kind: 'event', event: { type: 'start' } });
      simulateMessage(channel, {
        name: 'start',
        data: undefined,
        action: 'message.create',
        extras: {
          headers: {
            [HEADER_RUN_ID]: run.runId,
            [HEADER_MSG_ID]: 'asst-milan',
            [HEADER_PARENT]: msg2Id,
            [HEADER_ROLE]: 'assistant',
          },
        },
        serial: 'serial-0003',
      } as unknown as Ably.InboundMessage);

      // Streaming text event
      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'The Violin Maker...' } });
      simulateMessage(channel, {
        name: 'text',
        data: 'The Violin Maker...',
        action: 'message.create',
        extras: {
          headers: {
            [HEADER_RUN_ID]: run.runId,
            [HEADER_MSG_ID]: 'asst-milan',
            [HEADER_PARENT]: msg2Id,
            [HEADER_ROLE]: 'assistant',
          },
        },
        serial: 'serial-0004',
      } as unknown as Ably.InboundMessage);

      // --- verify the assistant message is visible in getMessages ---
      const messages = session.view.flattenNodes().map((n) => n.message);
      const ids = messages.map((m) => m.id);
      expect(ids).toContain('prev-asst');
      expect(ids).toContain('u1');
      expect(ids).toContain('u2');
      expect(ids).toContain('asst-milan');
      expect(messages).toHaveLength(4);

      // Clean up the stream
      decoder.outputs.push({ kind: 'event', event: { type: 'finish' } });
      simulateMessage(channel, ablyMsg('finish', { [HEADER_RUN_ID]: run.runId, [HEADER_MSG_ID]: 'asst-milan' }));
      await drain(run.stream);
    });

    it('multi-message send chains messages so editing the first hides the second', async () => {
      // Regression: send([msg1, msg2]) gave both the same parent (siblings).
      // Editing msg1 (forking) should hide msg2, but it stayed visible.
      // Fix: chain messages so msg2 is a child of msg1.

      // Seed a prior message
      const tree = session.tree;
      tree.upsert(
        'prev',
        { id: 'prev', content: 'prev' },
        {
          [HEADER_MSG_ID]: 'prev',
        },
        'serial-0000',
      );

      // --- send two messages ---
      const run = await session.view.send([
        { id: 'u1', content: 'first' },
        { id: 'u2', content: 'second' },
      ]);
      await mockFetch.waitForCalls(1);

      const body = mockFetch.body(0);
      const postMsgs = body.messages as { headers: Record<string, string> }[];
      const msg1Id = postMsgs[0]?.headers[HEADER_MSG_ID] ?? '';
      const msg2Id = postMsgs[1]?.headers[HEADER_MSG_ID] ?? '';

      // Verify chaining: msg1 parents off prev, msg2 parents off msg1
      expect(postMsgs[0]?.headers[HEADER_PARENT]).toBe('prev');
      expect(postMsgs[1]?.headers[HEADER_PARENT]).toBe(msg1Id);

      // Verify optimistic tree structure
      const msg2Node = tree.getNode(msg2Id);
      expect(msg2Node?.parentId).toBe(msg1Id);

      // Both messages should be visible
      let ids = session.view
        .flattenNodes()
        .map((n) => n.message)
        .map((m) => m.id);
      expect(ids).toContain('u1');
      expect(ids).toContain('u2');

      // --- simulate an edit of msg1 (fork) ---
      // Close the stream first
      decoder.outputs.push({ kind: 'event', event: { type: 'finish' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_RUN_ID]: run.runId }));
      await drain(run.stream);

      // Simulate run-end
      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_END, {
          [HEADER_RUN_ID]: run.runId,
          [HEADER_RUN_CLIENT_ID]: 'client-1',
          [HEADER_RUN_REASON]: 'complete',
        }),
      );

      // Edit msg1 → creates a fork sibling
      const editRun = await session.view.edit(msg1Id, [{ id: 'u1-edited', content: 'edited first' }]);
      await mockFetch.waitForCalls(2);

      // After editing, the tree should show the fork, not the original branch.
      // msg2 was a child of msg1 (the old version) and should no longer be
      // on the active path — the edit fork replaces msg1's branch.
      ids = session.view
        .flattenNodes()
        .map((n) => n.message)
        .map((m) => m.id);
      expect(ids).toContain('u1-edited');
      expect(ids).not.toContain('u2');

      // Close edit stream
      decoder.outputs.push({ kind: 'event', event: { type: 'finish' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_RUN_ID]: editRun.runId }));
      await drain(editRun.stream);
    });
  });

  // -------------------------------------------------------------------------
  // regenerate()
  // -------------------------------------------------------------------------

  describe('regenerate', () => {
    it('sends with forkOf set to the target messageId', async () => {
      const seeded = await createSeededSession(codec, mockFetch, [
        { id: 'user-msg', content: 'question' },
        { id: 'asst-msg', content: 'answer' },
      ]);

      await seeded.view.regenerate('asst-msg');
      await mockFetch.waitForCalls(1);

      const body = mockFetch.body(0);
      expect(body.forkOf).toBe('asst-msg');

      await seeded.close();
    });

    it('sends with empty messages array', async () => {
      const seeded = await createSeededSession(codec, mockFetch, [{ id: 'msg-1', content: 'hi' }]);

      await seeded.view.regenerate('msg-1');
      await mockFetch.waitForCalls(1);

      const body = mockFetch.body(0);
      expect(body.messages).toEqual([]);

      await seeded.close();
    });

    it('includes truncated history in POST body', async () => {
      const seeded = await createSeededSession(codec, mockFetch, [
        { id: 'q1', content: 'question' },
        { id: 'a1', content: 'answer' },
      ]);

      await seeded.view.regenerate('a1');
      await mockFetch.waitForCalls(1);

      const body = mockFetch.body(0);
      // The inner history (from sendOptions.body.history) should NOT contain a1
      const innerHistory = body.history as { message: TestMessage }[];
      const hasTarget = innerHistory.some((h) => h.message.id === 'a1');
      expect(hasTarget).toBe(false);

      await seeded.close();
    });

    it('sets parent from the tree node', async () => {
      const seeded = await createSeededSession(codec, mockFetch, [
        { id: 'q1', content: 'question' },
        { id: 'a1', content: 'answer' },
      ]);

      await seeded.view.regenerate('a1');
      await mockFetch.waitForCalls(1);

      const body = mockFetch.body(0);
      // a1's parent is q1 in the tree, so regenerate should set parent to q1
      expect(body.parent).toBe('q1');

      await seeded.close();
    });

    it('returns an ActiveRun', async () => {
      const seeded = await createSeededSession(codec, mockFetch, [{ id: 'msg-1', content: 'hi' }]);

      const run = await seeded.view.regenerate('msg-1');
      expect(run.stream).toBeInstanceOf(ReadableStream);
      expect(typeof run.runId).toBe('string');

      await seeded.close();
    });
  });

  // -------------------------------------------------------------------------
  // edit()
  // -------------------------------------------------------------------------

  describe('edit', () => {
    it('sends with forkOf set to the target messageId', async () => {
      const seeded = await createSeededSession(codec, mockFetch, [{ id: 'user-msg', content: 'original' }]);

      await seeded.view.edit('user-msg', { id: 'edited', content: 'revised' });
      await mockFetch.waitForCalls(1);

      const body = mockFetch.body(0);
      expect(body.forkOf).toBe('user-msg');

      await seeded.close();
    });

    it('sends replacement messages in the POST body', async () => {
      const seeded = await createSeededSession(codec, mockFetch, [{ id: 'user-msg', content: 'original' }]);

      await seeded.view.edit('user-msg', [
        { id: 'edit-1', content: 'revised-1' },
        { id: 'edit-2', content: 'revised-2' },
      ]);
      await mockFetch.waitForCalls(1);

      const body = mockFetch.body(0);
      const messages = body.messages as { message: TestMessage }[];
      expect(messages).toHaveLength(2);

      await seeded.close();
    });

    it('sets parent from the tree node', async () => {
      const seeded = await createSeededSession(codec, mockFetch, [
        { id: 'q1', content: 'question' },
        { id: 'u1', content: 'user message' },
      ]);

      await seeded.view.edit('u1', { id: 'edited', content: 'revised' });
      await mockFetch.waitForCalls(1);

      const body = mockFetch.body(0);
      // u1's parent is q1 in the tree
      expect(body.parent).toBe('q1');

      await seeded.close();
    });

    it('handles single message input', async () => {
      const seeded = await createSeededSession(codec, mockFetch, [{ id: 'user-msg', content: 'original' }]);

      const run = await seeded.view.edit('user-msg', { id: 'edited', content: 'revised' });
      expect(run.stream).toBeInstanceOf(ReadableStream);

      await seeded.close();
    });

    it('truncates history before the edited message', async () => {
      // Regression: edit() sent the full tree as history, so the LLM saw
      // messages that were children of the message being edited — which
      // belong to the old branch and should not be in the edit's context.
      const seeded = await createSeededSession(codec, mockFetch, [
        { id: 'q1', content: 'Tell me a joke' },
        { id: 'a1', content: 'Why did the chicken...' },
        { id: 'u2', content: 'Actually a poem' },
        { id: 'u3', content: 'About Paris' },
      ]);

      await seeded.view.edit('u2', { id: 'u2-edit', content: 'Actually a haiku' });
      await mockFetch.waitForCalls(1);

      const body = mockFetch.body(0);
      const history = body.history as { message: TestMessage }[];

      // History should contain only messages BEFORE u2
      const historyIds = history.map((h) => h.message.id);
      expect(historyIds).toContain('q1');
      expect(historyIds).toContain('a1');
      expect(historyIds).not.toContain('u2');
      expect(historyIds).not.toContain('u3');

      await seeded.close();
    });
  });

  // -------------------------------------------------------------------------
  // amendment events
  // -------------------------------------------------------------------------

  describe('amendment events', () => {
    it('routes amendment events to _handleAmendmentEvent and updates existing tree node', () => {
      // Seed a node in the tree
      session.tree.upsert(
        'msg-1',
        { id: 'msg-1', content: 'original' },
        {
          [HEADER_MSG_ID]: 'msg-1',
          [HEADER_ROLE]: 'assistant',
        },
        'serial-1',
      );

      // Set up a mock accumulator that initMessage + processOutputs will use
      const mockAccum = createMockAccumulator();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      vi.mocked(codec.createAccumulator).mockReturnValue(mockAccum);
      Object.defineProperty(mockAccum, 'messages', {
        get: () => [{ id: 'msg-1', content: 'amended' }],
        configurable: true,
      });

      // Simulate an amendment message arriving
      decoder.outputs.push({
        kind: 'event',
        event: { type: 'tool-output' },
        messageId: 'msg-1',
      });
      simulateMessage(
        channel,
        ablyMsg('codec-msg', {
          [HEADER_AMEND]: 'msg-1',
          [HEADER_ROLE]: 'assistant',
          [HEADER_RUN_ID]: 'amend-run',
          [HEADER_MSG_ID]: 'msg-1',
        }),
      );

      // The tree should have been updated with the amended message
      const node = session.tree.getNode('msg-1');
      expect(node?.message.content).toBe('amended');

      // initMessage should have been called with the original message
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      expect(mockAccum.initMessage).toHaveBeenCalledWith('msg-1', { id: 'msg-1', content: 'original' });
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      expect(mockAccum.processOutputs).toHaveBeenCalled();
    });

    it('silently drops amendment for unknown msgId', () => {
      // No node with 'unknown-msg' in the tree
      const updateHandler = vi.fn();
      session.view.on('update', updateHandler);

      decoder.outputs.push({
        kind: 'event',
        event: { type: 'tool-output' },
        messageId: 'unknown-msg',
      });
      simulateMessage(
        channel,
        ablyMsg('codec-msg', {
          [HEADER_AMEND]: 'unknown-msg',
          [HEADER_ROLE]: 'assistant',
          [HEADER_RUN_ID]: 'amend-run',
          [HEADER_MSG_ID]: 'unknown-msg',
        }),
      );

      // Should not throw and should not create any new nodes
      expect(session.tree.getNode('unknown-msg')).toBeUndefined();
    });

    it('amendment events do not create run observer state', () => {
      // Seed a node in the tree
      session.tree.upsert(
        'msg-1',
        { id: 'msg-1', content: 'original' },
        {
          [HEADER_MSG_ID]: 'msg-1',
          [HEADER_ROLE]: 'assistant',
        },
        'serial-1',
      );

      const mockAccum = createMockAccumulator();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      vi.mocked(codec.createAccumulator).mockReturnValue(mockAccum);
      Object.defineProperty(mockAccum, 'messages', {
        get: () => [{ id: 'msg-1', content: 'amended' }],
        configurable: true,
      });

      decoder.outputs.push({
        kind: 'event',
        event: { type: 'tool-output' },
        messageId: 'msg-1',
      });
      simulateMessage(
        channel,
        ablyMsg('codec-msg', {
          [HEADER_AMEND]: 'msg-1',
          [HEADER_ROLE]: 'assistant',
          [HEADER_RUN_ID]: 'amend-run',
          [HEADER_MSG_ID]: 'msg-1',
        }),
      );

      // Amendment run should NOT appear in active runs
      const activeRuns = session.tree.getActiveRunIds();
      const allRunIds = new Set<string>();
      for (const runSet of activeRuns.values()) {
        for (const tid of runSet) allRunIds.add(tid);
      }
      expect(allRunIds.has('amend-run')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // stageEvents()
  // -------------------------------------------------------------------------

  describe('stageEvents', () => {
    it('applies events to the tree via the codec accumulator', () => {
      session.tree.upsert(
        'msg-1',
        { id: 'msg-1', content: 'original' },
        { [HEADER_MSG_ID]: 'msg-1', [HEADER_ROLE]: 'assistant' },
        'serial-1',
      );

      const mockAccum = createMockAccumulator();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      vi.mocked(codec.createAccumulator).mockReturnValue(mockAccum);
      Object.defineProperty(mockAccum, 'messages', {
        get: () => [{ id: 'msg-1', content: 'staged' }],
        configurable: true,
      });

      session.stageEvents('msg-1', [{ type: 'tool-output' }]);

      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      expect(mockAccum.initMessage).toHaveBeenCalledWith('msg-1', { id: 'msg-1', content: 'original' });
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      expect(mockAccum.processOutputs).toHaveBeenCalled();
      expect(session.tree.getNode('msg-1')?.message.content).toBe('staged');
    });

    it('queues events so the next send posts them in the events body field', async () => {
      session.tree.upsert(
        'msg-1',
        { id: 'msg-1', content: 'original' },
        { [HEADER_MSG_ID]: 'msg-1', [HEADER_ROLE]: 'assistant' },
        'serial-1',
      );

      session.stageEvents('msg-1', [{ type: 'tool-output' }]);

      await session.view.send({ id: 'u1', content: 'hi' });
      await mockFetch.waitForCalls(1);

      const body = mockFetch.body(0);
      expect(body.events).toEqual([
        {
          kind: 'event',
          msgId: 'msg-1',
          events: [{ type: 'tool-output' }],
        },
      ]);
    });

    it('clears the queue on flush — a second send without another stage ships no events', async () => {
      session.tree.upsert(
        'msg-1',
        { id: 'msg-1', content: 'original' },
        { [HEADER_MSG_ID]: 'msg-1', [HEADER_ROLE]: 'assistant' },
        'serial-1',
      );

      session.stageEvents('msg-1', [{ type: 'tool-output' }]);

      await session.view.send({ id: 'u1', content: 'first' });
      await mockFetch.waitForCalls(1);
      expect(mockFetch.body(0).events).toBeDefined();

      await session.view.send({ id: 'u2', content: 'second' });
      await mockFetch.waitForCalls(2);
      expect(mockFetch.body(1).events).toBeUndefined();
    });

    it('is a no-op when msgId is not in the tree', () => {
      // No node in the tree under 'unknown' — no throw, no queue entry.
      session.stageEvents('unknown', [{ type: 'tool-output' }]);
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      expect(codec.createAccumulator).not.toHaveBeenCalled();
    });

    it('is a no-op when events array is empty', () => {
      session.tree.upsert(
        'msg-1',
        { id: 'msg-1', content: 'original' },
        { [HEADER_MSG_ID]: 'msg-1', [HEADER_ROLE]: 'assistant' },
        'serial-1',
      );
      session.stageEvents('msg-1', []);
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      expect(codec.createAccumulator).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // stageMessage()
  // -------------------------------------------------------------------------

  describe('stageMessage', () => {
    it('replaces the tree message via upsert, preserving headers and serial', () => {
      const originalHeaders = { [HEADER_MSG_ID]: 'msg-1', [HEADER_ROLE]: 'assistant', custom: 'keep' };
      session.tree.upsert('msg-1', { id: 'msg-1', content: 'original' }, originalHeaders, 'serial-abc');

      session.stageMessage('msg-1', { id: 'msg-1', content: 'patched' });

      const node = session.tree.getNode('msg-1');
      expect(node?.message).toEqual({ id: 'msg-1', content: 'patched' });
      // Headers preserved by passing existingNode.headers through to upsert.
      expect(node?.headers).toEqual(originalHeaders);
      expect(node?.serial).toBe('serial-abc');
    });

    it('fires a tree update event', () => {
      session.tree.upsert(
        'msg-1',
        { id: 'msg-1', content: 'original' },
        { [HEADER_MSG_ID]: 'msg-1', [HEADER_ROLE]: 'assistant' },
        'serial-1',
      );

      const updateHandler = vi.fn();
      session.view.on('update', updateHandler);

      session.stageMessage('msg-1', { id: 'msg-1', content: 'patched' });

      expect(updateHandler).toHaveBeenCalled();
    });

    it('is a no-op when msgId is not in the tree', () => {
      // No exceptions. Tree stays empty.
      session.stageMessage('unknown', { id: 'unknown', content: 'whatever' });
      expect(session.tree.getNode('unknown')).toBeUndefined();
    });

    it('is a no-op after the session is closed', async () => {
      session.tree.upsert(
        'msg-1',
        { id: 'msg-1', content: 'original' },
        { [HEADER_MSG_ID]: 'msg-1', [HEADER_ROLE]: 'assistant' },
        'serial-1',
      );
      await session.close();

      session.stageMessage('msg-1', { id: 'msg-1', content: 'patched' });

      // Message should be unchanged.
      expect(session.tree.getNode('msg-1')?.message.content).toBe('original');
    });
  });

  // -------------------------------------------------------------------------
  // cancel()
  // -------------------------------------------------------------------------

  describe('cancel', () => {
    it('publishes cancel message to the channel', async () => {
      await session.cancel({ runId: 'run-1' });
      expect(channel.publish).toHaveBeenCalled();
    });

    it('closes matching own run streams', async () => {
      const run = await session.view.send({ id: 'u1', content: 'hi' });
      await mockFetch.waitForCalls(1);

      await session.cancel({ runId: run.runId });

      const items = await drain(run.stream);
      expect(items).toEqual([]);
    });

    it('defaults to { own: true } when no filter given', async () => {
      await session.cancel();
      expect(channel.publish).toHaveBeenCalled();
    });

    it('does nothing when session is closed', async () => {
      await session.close();
      vi.mocked(channel.publish).mockClear();
      await session.cancel({ runId: 'run-1' });
      expect(channel.publish).not.toHaveBeenCalled();
    });

    it('closes streams by clientId filter', async () => {
      // Simulate a run from another client so the clientId filter can match
      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'other-run',
          [HEADER_RUN_CLIENT_ID]: 'other-client',
        }),
      );

      await session.cancel({ clientId: 'other-client' });

      // After cancel, the run should still be tracked until run-end,
      // but cancel was published
      expect(channel.publish).toHaveBeenCalled();
    });

    it('preserves observer so late server events are still accumulated after cancel', async () => {
      const mockAccum = createMockAccumulator();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      vi.mocked(codec.createAccumulator).mockReturnValue(mockAccum);
      Object.defineProperty(mockAccum, 'messages', {
        get: () => [{ id: 'acc-msg', content: 'partial' }],
        configurable: true,
      });

      const run = await session.view.send({ id: 'u1', content: 'hi' });
      await mockFetch.waitForCalls(1);

      // Stream some events before cancel
      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'partial' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_RUN_ID]: run.runId, [HEADER_MSG_ID]: 'asst-1' }));

      // Cancel — closes the stream but observer should survive
      await session.cancel({ runId: run.runId });

      const treeHandler = vi.fn();
      session.tree.on('update', treeHandler);

      // Simulate late abort event from the server arriving after cancel
      decoder.outputs.push({ kind: 'event', event: { type: 'finish' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_RUN_ID]: run.runId, [HEADER_MSG_ID]: 'asst-1' }));

      // The event should have been accumulated (observer still alive)
      expect(treeHandler).toHaveBeenCalled();
    });

    it('does not recreate observer accumulator after cancel with runId filter', async () => {
      const run = await session.view.send({ id: 'u1', content: 'hi' });
      await mockFetch.waitForCalls(1);

      // Stream an event — creates the observer accumulator
      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'partial' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_RUN_ID]: run.runId }));

      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      const accCallsBefore = vi.mocked(codec.createAccumulator).mock.calls.length;

      // Cancel — should NOT delete the observer
      await session.cancel({ runId: run.runId });

      // Late event arrives — should reuse the existing observer, not create a new one
      decoder.outputs.push({ kind: 'event', event: { type: 'finish' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_RUN_ID]: run.runId }));

      // No new accumulator should have been created
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      expect(vi.mocked(codec.createAccumulator).mock.calls.length).toBe(accCallsBefore);
    });

    it('does not recreate observer accumulator after cancel with own filter', async () => {
      const run = await session.view.send({ id: 'u1', content: 'hi' });
      await mockFetch.waitForCalls(1);

      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'partial' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_RUN_ID]: run.runId }));

      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      const accCallsBefore = vi.mocked(codec.createAccumulator).mock.calls.length;

      await session.cancel({ own: true });

      decoder.outputs.push({ kind: 'event', event: { type: 'finish' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_RUN_ID]: run.runId }));

      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      expect(vi.mocked(codec.createAccumulator).mock.calls.length).toBe(accCallsBefore);
    });
  });

  // -------------------------------------------------------------------------
  // waitForRun()
  // -------------------------------------------------------------------------

  describe('waitForRun', () => {
    it('resolves immediately when no matching runs are active', async () => {
      await session.waitForRun({ runId: 'nonexistent' });
    });

    it('resolves when the matching run ends', async () => {
      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-1',
          [HEADER_RUN_CLIENT_ID]: 'client-1',
        }),
      );

      const waitPromise = session.waitForRun({ runId: 'run-1' });

      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_END, {
          [HEADER_RUN_ID]: 'run-1',
          [HEADER_RUN_CLIENT_ID]: 'client-1',
        }),
      );

      await waitPromise;
    });

    it('does nothing when session is closed', async () => {
      await session.close();
      await session.waitForRun({ runId: 'run-1' });
    });

    it('defaults to { own: true } and resolves when all own runs end', async () => {
      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-1',
          [HEADER_RUN_CLIENT_ID]: 'client-1',
        }),
      );

      const waitPromise = session.waitForRun();

      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_END, {
          [HEADER_RUN_ID]: 'run-1',
          [HEADER_RUN_CLIENT_ID]: 'client-1',
        }),
      );

      await waitPromise;
    });

    it('waits for all matching runs before resolving', async () => {
      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-1',
          [HEADER_RUN_CLIENT_ID]: 'client-1',
        }),
      );
      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-2',
          [HEADER_RUN_CLIENT_ID]: 'client-1',
        }),
      );

      let resolved = false;
      const waitPromise = session.waitForRun({ all: true }).then(() => {
        resolved = true;
      });

      // End first run
      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_END, {
          [HEADER_RUN_ID]: 'run-1',
          [HEADER_RUN_CLIENT_ID]: 'client-1',
        }),
      );
      await flushMicrotasks();
      expect(resolved).toBe(false);

      // End second run
      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_END, {
          [HEADER_RUN_ID]: 'run-2',
          [HEADER_RUN_CLIENT_ID]: 'client-1',
        }),
      );

      await waitPromise;
      expect(resolved).toBe(true);
    });

    it('ignores run-start events while waiting', async () => {
      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-1',
          [HEADER_RUN_CLIENT_ID]: 'client-1',
        }),
      );

      const waitPromise = session.waitForRun({ runId: 'run-1' });

      // A run-start for a different run should not affect anything
      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-2',
          [HEADER_RUN_CLIENT_ID]: 'client-1',
        }),
      );

      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_END, {
          [HEADER_RUN_ID]: 'run-1',
          [HEADER_RUN_CLIENT_ID]: 'client-1',
        }),
      );

      await waitPromise;
    });
  });

  // -------------------------------------------------------------------------
  // on()
  // -------------------------------------------------------------------------

  describe('on', () => {
    it('subscribes to message events and returns unsubscribe', () => {
      const handler = vi.fn();
      const unsub = session.view.on('update', handler);

      decoder.outputs.push({ kind: 'message', message: { id: 'new', content: 'test' } });
      simulateMessage(channel, ablyMsg('msg', { [HEADER_MSG_ID]: 'msg-new' }, undefined, 'message.create'));

      expect(handler).toHaveBeenCalled();

      handler.mockClear();
      unsub();

      decoder.outputs.push({ kind: 'message', message: { id: 'new2', content: 'test2' } });
      simulateMessage(channel, ablyMsg('msg', { [HEADER_MSG_ID]: 'msg-new2' }, undefined, 'message.create'));

      expect(handler).not.toHaveBeenCalled();
    });

    it('subscribes to error events', () => {
      const handler = vi.fn();
      session.on('error', handler);

      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      vi.mocked(decoder.decode).mockImplementationOnce(() => {
        throw new Error('test error');
      });
      simulateMessage(channel, ablyMsg('codec-msg', {}));

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: ErrorCode.SessionSubscriptionError }));
    });

    it('unsubscribes from error events', () => {
      const handler = vi.fn();
      const unsub = session.on('error', handler);
      unsub();

      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      vi.mocked(decoder.decode).mockImplementationOnce(() => {
        throw new Error('test error');
      });
      simulateMessage(channel, ablyMsg('codec-msg', {}));

      expect(handler).not.toHaveBeenCalled();
    });

    it('subscribes to ably-message events', () => {
      const handler = vi.fn();
      session.tree.on('ably-message', handler);

      simulateMessage(channel, ablyMsg(EVENT_RUN_START, { [HEADER_RUN_ID]: 't1' }));
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('unsubscribes from ably-message events', () => {
      const handler = vi.fn();
      const unsub = session.tree.on('ably-message', handler);
      unsub();

      simulateMessage(channel, ablyMsg(EVENT_RUN_START, { [HEADER_RUN_ID]: 't1' }));
      expect(handler).not.toHaveBeenCalled();
    });

    it('returns no-op unsubscribe when session is closed', async () => {
      await session.close();
      const unsub = session.on('error', vi.fn());
      expect(typeof unsub).toBe('function');
      unsub();
    });

    it('subscribes to run events', () => {
      const handler = vi.fn();
      session.tree.on('run', handler);

      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-1',
          [HEADER_RUN_CLIENT_ID]: 'client-1',
        }),
      );

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: EVENT_RUN_START, runId: 'run-1' }));
    });

    it('unsubscribes from run events', () => {
      const handler = vi.fn();
      const unsub = session.tree.on('run', handler);
      unsub();

      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-1',
          [HEADER_RUN_CLIENT_ID]: 'client-1',
        }),
      );

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // getMessages()
  // -------------------------------------------------------------------------

  describe('getMessages', () => {
    it('returns empty array initially', () => {
      expect(session.view.flattenNodes().map((n) => n.message)).toEqual([]);
    });

    it('returns seeded messages', () => {
      const seeded = createClientSession({
        client: createMockClient(createMockChannel()),
        channelName: 'test-channel',
        codec,
        api: '/test',
        messages: [{ id: 'a', content: 'alpha' }],
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });

      expect(seeded.view.flattenNodes().map((n) => n.message)).toHaveLength(1);
    });

    it('reflects optimistic messages after send', async () => {
      await session.view.send({ id: 'u1', content: 'hi' });
      const messages = session.view.flattenNodes().map((n) => n.message);
      expect(messages.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // getActiveRunIds()
  // -------------------------------------------------------------------------

  describe('getActiveRunIds', () => {
    it('returns empty map when no runs are active', () => {
      expect(session.tree.getActiveRunIds().size).toBe(0);
    });

    it('tracks multiple runs per client', () => {
      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-1',
          [HEADER_RUN_CLIENT_ID]: 'client-1',
        }),
      );
      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-2',
          [HEADER_RUN_CLIENT_ID]: 'client-1',
        }),
      );

      const active = session.tree.getActiveRunIds();
      const clientRuns = active.get('client-1');
      expect(clientRuns?.size).toBe(2);
      expect(clientRuns?.has('run-1')).toBe(true);
      expect(clientRuns?.has('run-2')).toBe(true);
    });

    it('groups runs by clientId', () => {
      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-1',
          [HEADER_RUN_CLIENT_ID]: 'client-a',
        }),
      );
      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-2',
          [HEADER_RUN_CLIENT_ID]: 'client-b',
        }),
      );

      const active = session.tree.getActiveRunIds();
      expect(active.get('client-a')?.has('run-1')).toBe(true);
      expect(active.get('client-b')?.has('run-2')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // tree
  // -------------------------------------------------------------------------

  describe('tree', () => {
    it('returns the conversation tree', () => {
      const tree = session.tree;
      expect(tree).toBeDefined();
      expect(typeof tree.upsert).toBe('function');
      expect(typeof tree.getSiblings).toBe('function');
    });

    it('emits ably-message events for incoming messages', () => {
      const received: Ably.InboundMessage[] = [];
      session.tree.on('ably-message', (msg) => received.push(msg));

      simulateMessage(channel, ablyMsg(EVENT_RUN_START, { [HEADER_RUN_ID]: 't1' }));

      expect(received).toHaveLength(1);
    });

    it('returns conversation nodes with headers and msgId', () => {
      const seeded = createClientSession({
        client: createMockClient(createMockChannel()),
        channelName: 'test-channel',
        codec,
        api: '/test',
        messages: [{ id: 'msg-1', content: 'hi' }],
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });

      const nodes = seeded.view.flattenNodes();
      expect(nodes).toHaveLength(1);
      expect(nodes[0]?.message.id).toBe('msg-1');
      expect(nodes[0]?.msgId).toBeDefined();
      expect(nodes[0]?.headers).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // close()
  // -------------------------------------------------------------------------

  describe('close', () => {
    it('unsubscribes from the channel', async () => {
      await session.close();
      expect(channel.unsubscribe).toHaveBeenCalledWith(expect.any(Function));
    });

    it('clears active streams', async () => {
      const run = await session.view.send({ id: 'u1', content: 'hi' });
      await session.close();

      const items = await drain(run.stream);
      expect(items).toEqual([]);
    });

    it('is idempotent', async () => {
      await session.close();
      await session.close();
    });

    it('publishes cancel when cancel option is provided', async () => {
      await session.close({ cancel: { all: true } });
      expect(channel.publish).toHaveBeenCalled();
    });

    it('has messages before close', async () => {
      const seeded = createClientSession({
        client: createMockClient(createMockChannel()),
        channelName: 'test-channel',
        codec,
        api: '/test',
        messages: [{ id: 'msg-1', content: 'hi' }],
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });
      expect(seeded.view.flattenNodes().map((n) => n.message)).toHaveLength(1);

      await seeded.close();
      // View may still have data after close — close prevents further operations
    });

    it('tracks active run ids before close', async () => {
      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'run-1',
          [HEADER_RUN_CLIENT_ID]: 'client-1',
        }),
      );
      expect(session.tree.getActiveRunIds().size).toBe(1);

      await session.close();
      // After close, new messages are ignored but existing tree state is preserved
    });

    it('closes matching streams when cancel option specifies runId', async () => {
      const run = await session.view.send({ id: 'u1', content: 'hi' });
      await session.close({ cancel: { runId: run.runId } });

      const items = await drain(run.stream);
      expect(items).toEqual([]);
    });

    it('swallows cancel publish failure during teardown', async () => {
      vi.mocked(channel.publish).mockRejectedValueOnce(new Error('publish failed'));
      // Should not throw
      await session.close({ cancel: { all: true } });
    });
  });

  // -------------------------------------------------------------------------
  // Channel continuity loss
  // -------------------------------------------------------------------------

  describe('channel continuity loss', () => {
    it('detects discontinuity on pre-attached channel without needing initial attach event', async () => {
      const preAttachedChannel = createMockChannel();
      preAttachedChannel.state = 'attached';

      const preAttachedSession = createClientSession({
        client: createMockClient(preAttachedChannel),
        channelName: 'test-channel',
        codec,
        api: '/test',
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });
      await preAttachedSession.connect();

      const run = await preAttachedSession.view.send({ id: 'u1', content: 'hi' });
      await mockFetch.waitForCalls(1);

      // UPDATE with resumed: false — should be treated as a real discontinuity
      // even though no initial attach event was observed
      simulateStateChange(preAttachedChannel, {
        current: 'attached',
        previous: 'attached',
        resumed: false,
      } as Ably.ChannelStateChange);

      const reader = run.stream.getReader();
      await expect(reader.read()).rejects.toBeErrorInfoWithCode(ErrorCode.ChannelContinuityLost);

      await preAttachedSession.close();
    });

    it('does not treat the initial attach as continuity loss', async () => {
      const uninitChannel = createMockChannel();
      uninitChannel.state = 'initialized';

      const uninitSession = createClientSession({
        client: createMockClient(uninitChannel),
        channelName: 'test-channel',
        codec,
        api: '/test',
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });
      await uninitSession.connect();

      const errors: Ably.ErrorInfo[] = [];
      uninitSession.on('error', (e) => errors.push(e));

      simulateStateChange(uninitChannel, {
        current: 'attached',
        previous: 'attaching',
        resumed: false,
      } as Ably.ChannelStateChange);

      expect(errors).toHaveLength(0);

      await uninitSession.close();
    });

    // Documents current behaviour — see AIT-692 for revisiting this.
    it('emits error event if channel fails before first attach', async () => {
      const uninitChannel = createMockChannel();
      uninitChannel.state = 'initialized';

      const uninitSession = createClientSession({
        client: createMockClient(uninitChannel),
        channelName: 'test-channel',
        codec,
        api: '/test',
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });
      await uninitSession.connect();

      const errors: Ably.ErrorInfo[] = [];
      uninitSession.on('error', (e) => errors.push(e));

      simulateStateChange(uninitChannel, {
        current: 'attaching',
        previous: 'initialized',
        resumed: false,
      } as Ably.ChannelStateChange);

      simulateStateChange(uninitChannel, {
        current: 'failed',
        previous: 'attaching',
        resumed: false,
      } as Ably.ChannelStateChange);

      // The session was never receiving messages, so there was no continuity
      // to lose — but we still emit the error. No streams are affected because
      // _ownRunIds is empty (send() hasn't been called).
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeErrorInfoWithCode(ErrorCode.ChannelContinuityLost);

      await uninitSession.close();
    });

    for (const state of ['failed', 'suspended', 'detached'] as const) {
      it(`errors active streams when channel enters ${state}`, async () => {
        simulateInitialAttach(channel);

        const run = await session.view.send({ id: 'u1', content: 'hi' });
        await mockFetch.waitForCalls(1);

        simulateStateChange(channel, {
          current: state,
          previous: 'attached',
          resumed: false,
        } as Ably.ChannelStateChange);

        const reader = run.stream.getReader();
        await expect(reader.read()).rejects.toBeErrorInfoWithCode(ErrorCode.ChannelContinuityLost);

        await session.close();
      });
    }

    // RTL12: already ATTACHED, receives ATTACHED ProtocolMessage with resumed: false
    // → channel emits UPDATE (not a state change), previous === current === 'attached'
    it('errors active streams on UPDATE with resumed: false', async () => {
      simulateInitialAttach(channel);

      const run = await session.view.send({ id: 'u1', content: 'hi' });
      await mockFetch.waitForCalls(1);

      simulateStateChange(channel, {
        current: 'attached',
        previous: 'attached',
        resumed: false,
      } as Ably.ChannelStateChange);

      const reader = run.stream.getReader();
      await expect(reader.read()).rejects.toBeErrorInfoWithCode(ErrorCode.ChannelContinuityLost);

      await session.close();
    });

    it('errors active streams when re-attaching with resumed: false', async () => {
      simulateInitialAttach(channel);

      const run = await session.view.send({ id: 'u1', content: 'hi' });
      await mockFetch.waitForCalls(1);

      // Simulate the channel losing connection and re-attaching without resume.
      // ATTACHING is not a continuity-breaking state, so only the subsequent
      // ATTACHED/resumed:false should error the stream.
      simulateStateChange(channel, {
        current: 'attaching',
        previous: 'attached',
        resumed: false,
      } as Ably.ChannelStateChange);

      simulateStateChange(channel, {
        current: 'attached',
        previous: 'attaching',
        resumed: false,
      } as Ably.ChannelStateChange);

      const reader = run.stream.getReader();
      await expect(reader.read()).rejects.toBeErrorInfoWithCode(ErrorCode.ChannelContinuityLost);

      await session.close();
    });

    it('does not error streams on UPDATE with resumed: true', async () => {
      simulateInitialAttach(channel);

      const errors: Ably.ErrorInfo[] = [];
      session.on('error', (e) => errors.push(e));

      const run = await session.view.send({ id: 'u1', content: 'hi' });
      await mockFetch.waitForCalls(1);

      simulateStateChange(channel, {
        current: 'attached',
        previous: 'attached',
        resumed: true,
      } as Ably.ChannelStateChange);

      expect(errors).toHaveLength(0);

      // Stream is still open — close cleanly
      await session.close();
      const items = await drain(run.stream);
      expect(items).toEqual([]);
    });

    it('emits an error event with state name in message', async () => {
      simulateInitialAttach(channel);

      const errors: Ably.ErrorInfo[] = [];
      session.on('error', (e) => errors.push(e));

      await session.view.send({ id: 'u1', content: 'hi' });
      await mockFetch.waitForCalls(1);

      simulateStateChange(channel, {
        current: 'failed',
        previous: 'attached',
        resumed: false,
      } as Ably.ChannelStateChange);

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeErrorInfoWithCode(ErrorCode.ChannelContinuityLost);
      expect(errors[0]?.message).toContain('failed');

      await session.close();
    });

    it('includes the channel reason as cause when present', async () => {
      simulateInitialAttach(channel);

      const errors: Ably.ErrorInfo[] = [];
      session.on('error', (e) => errors.push(e));

      await session.view.send({ id: 'u1', content: 'hi' });
      await mockFetch.waitForCalls(1);

      const reason = new Ably.ErrorInfo('connection lost', 80003, 500);
      simulateStateChange(channel, {
        current: 'suspended',
        previous: 'attached',
        resumed: false,
        reason,
      } as Ably.ChannelStateChange);

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeErrorInfo({
        code: ErrorCode.ChannelContinuityLost,
        cause: { code: 80003 },
      });

      await session.close();
    });

    it('errors multiple active streams on continuity loss', async () => {
      simulateInitialAttach(channel);

      const run1 = await session.view.send({ id: 'u1', content: 'hi' });
      const run2 = await session.view.send({ id: 'u2', content: 'hey' });
      await mockFetch.waitForCalls(2);

      simulateStateChange(channel, {
        current: 'suspended',
        previous: 'attached',
        resumed: false,
      } as Ably.ChannelStateChange);

      const reader1 = run1.stream.getReader();
      const reader2 = run2.stream.getReader();
      await expect(reader1.read()).rejects.toBeErrorInfoWithCode(ErrorCode.ChannelContinuityLost);
      await expect(reader2.read()).rejects.toBeErrorInfoWithCode(ErrorCode.ChannelContinuityLost);

      await session.close();
    });

    it('unsubscribes from channel state changes on close', async () => {
      await session.close();
      expect(channel.stateListeners.size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Error handler isolation
  // -------------------------------------------------------------------------

  describe('error handler isolation', () => {
    it('one throwing error handler does not prevent others', () => {
      const handler1 = vi.fn(() => {
        throw new Error('handler1 broke');
      });
      const handler2 = vi.fn();

      session.on('error', handler1);
      session.on('error', handler2);

      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      vi.mocked(decoder.decode).mockImplementationOnce(() => {
        throw new Error('decode error');
      });
      simulateMessage(channel, ablyMsg('codec-msg', {}));

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Ably message handler isolation
  // -------------------------------------------------------------------------

  describe('ably-message handler isolation', () => {
    it('one throwing ably-message handler does not prevent others', () => {
      const handler1 = vi.fn(() => {
        throw new Error('handler1 broke');
      });
      const handler2 = vi.fn();

      session.tree.on('ably-message', handler1);
      session.tree.on('ably-message', handler2);

      simulateMessage(channel, ablyMsg(EVENT_RUN_START, { [HEADER_RUN_ID]: 'run-1' }));

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Run-end cleanup
  // -------------------------------------------------------------------------

  describe('run-end cleanup', () => {
    it('cleans up per-run state after run-end', async () => {
      const run = await session.view.send({ id: 'u1', content: 'hi' });
      await mockFetch.waitForCalls(1);

      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: run.runId,
          [HEADER_RUN_CLIENT_ID]: 'client-1',
        }),
      );
      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_END, {
          [HEADER_RUN_ID]: run.runId,
          [HEADER_RUN_CLIENT_ID]: 'client-1',
        }),
      );

      const active = session.tree.getActiveRunIds();
      expect(active.size).toBe(0);
    });

    it('cleans up observer accumulator on run-end', () => {
      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'other-run',
          [HEADER_RUN_CLIENT_ID]: 'other-client',
        }),
      );

      // Accumulate an observer event
      const mockAccum = createMockAccumulator();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      vi.mocked(codec.createAccumulator).mockReturnValue(mockAccum);

      Object.defineProperty(mockAccum, 'messages', {
        get: () => [{ id: 'acc-msg', content: 'accumulated' }],
        configurable: true,
      });

      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'data' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_RUN_ID]: 'other-run' }));

      // run-end should clean up observer state
      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_END, {
          [HEADER_RUN_ID]: 'other-run',
          [HEADER_RUN_CLIENT_ID]: 'other-client',
        }),
      );

      const active = session.tree.getActiveRunIds();
      expect(active.size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Cancel stream close behavior
  // -------------------------------------------------------------------------

  describe('cancel with filter variants', () => {
    it('closes streams for all own runs when filter is { own: true }', async () => {
      const run1 = await session.view.send({ id: 'u1', content: 'a' });
      const run2 = await session.view.send({ id: 'u2', content: 'b' });

      await session.cancel({ own: true });

      const items1 = await drain(run1.stream);
      const items2 = await drain(run2.stream);
      expect(items1).toEqual([]);
      expect(items2).toEqual([]);
    });

    it('closes streams for all runs when filter is { all: true }', async () => {
      const run = await session.view.send({ id: 'u1', content: 'a' });
      await session.cancel({ all: true });

      const items = await drain(run.stream);
      expect(items).toEqual([]);
    });

    it('closes stream for specific run when filter has runId', async () => {
      const run1 = await session.view.send({ id: 'u1', content: 'a' });
      const run2 = await session.view.send({ id: 'u2', content: 'b' });

      await session.cancel({ runId: run1.runId });

      const items1 = await drain(run1.stream);
      expect(items1).toEqual([]);

      await session.cancel({ runId: run2.runId });
      const items2 = await drain(run2.stream);
      expect(items2).toEqual([]);
    });

    it('closes streams for clientId filter on observer runs', async () => {
      // Register an observer run via run-start
      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'observer-run',
          [HEADER_RUN_CLIENT_ID]: 'other-client',
        }),
      );

      await session.cancel({ clientId: 'other-client' });

      // Verify cancel was published
      expect(channel.publish).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // ActiveRun.cancel()
  // -------------------------------------------------------------------------

  describe('ActiveRun.cancel', () => {
    it('cancels the specific run via the handle', async () => {
      const run = await session.view.send({ id: 'u1', content: 'hi' });
      await run.cancel();

      const items = await drain(run.stream);
      expect(items).toEqual([]);

      expect(channel.publish).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Concurrency
  // -------------------------------------------------------------------------

  describe('concurrent runs', () => {
    it('routes events to the correct run stream independently', async () => {
      const run1 = await session.view.send({ id: 'u1', content: 'a' });
      const run2 = await session.view.send({ id: 'u2', content: 'b' });
      await mockFetch.waitForCalls(2);

      // Route events to run1
      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'for-run-1' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_RUN_ID]: run1.runId }));

      // Route events to run2
      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'for-run-2' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_RUN_ID]: run2.runId }));

      // Close both
      decoder.outputs.push({ kind: 'event', event: { type: 'finish' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_RUN_ID]: run1.runId }));

      decoder.outputs.push({ kind: 'event', event: { type: 'finish' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_RUN_ID]: run2.runId }));

      const items1 = await drain(run1.stream);
      const items2 = await drain(run2.stream);

      expect(items1).toEqual([{ type: 'text', text: 'for-run-1' }, { type: 'finish' }]);
      expect(items2).toEqual([{ type: 'text', text: 'for-run-2' }, { type: 'finish' }]);
    });

    it('cancel one run does not affect the other', async () => {
      const run1 = await session.view.send({ id: 'u1', content: 'a' });
      const run2 = await session.view.send({ id: 'u2', content: 'b' });
      await mockFetch.waitForCalls(2);

      await session.cancel({ runId: run1.runId });

      const items1 = await drain(run1.stream);
      expect(items1).toEqual([]);

      // run2 should still be open
      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'still-open' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_RUN_ID]: run2.runId }));

      decoder.outputs.push({ kind: 'event', event: { type: 'finish' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_RUN_ID]: run2.runId }));

      const items2 = await drain(run2.stream);
      expect(items2).toEqual([{ type: 'text', text: 'still-open' }, { type: 'finish' }]);
    });
  });

  // -------------------------------------------------------------------------
  // view.loadOlder()
  // -------------------------------------------------------------------------

  describe('view.loadOlder', () => {
    it('loads history and populates the view', async () => {
      // view.loadOlder calls decodeHistory which calls channel.attach() +
      // channel.history(), then processes via a fresh decoder.
      // For simplicity, configure channel.history to return empty results.
      await session.view.loadOlder();
      expect(channel.attach).toHaveBeenCalled();
    });

    it('populates flattenNodes after loading', async () => {
      await session.view.loadOlder();
      // With empty channel history, flattenNodes should still work
      expect(session.view.flattenNodes()).toBeDefined();
    });

    it('accepts a limit option', async () => {
      await session.view.loadOlder(50);
      // Should not throw; the limit is passed to decodeHistory
      expect(channel.history).toHaveBeenCalled();
    });

    it('does not throw when session is closed', async () => {
      await session.close();
      // loadOlder is a no-op after close — should not throw
      await session.view.loadOlder();
    });
  });

  // -------------------------------------------------------------------------
  // view windowing
  // -------------------------------------------------------------------------

  describe('view windowing', () => {
    it('view shows fewer nodes than tree when history is partially loaded', async () => {
      const histChannel = createMockChannel();

      // Create 2 Ably messages that will be decoded into 2 domain messages.
      const historyAblyMessages = [
        ablyMsg('msg', { [HEADER_MSG_ID]: 'hist-2' }, undefined, 'message.create'),
        ablyMsg('msg', { [HEADER_MSG_ID]: 'hist-1' }, undefined, 'message.create'),
      ];

      // decodeHistory creates a fresh decoder. Set up the mock codec so that
      // each call to createDecoder returns a decoder that produces message
      // outputs when decoding the history messages.
      let decodeCallCount = 0;
      const histMessages: TestMessage[] = [
        { id: 'hist-1', content: 'older' },
        { id: 'hist-2', content: 'newer' },
      ];
      const histDecoder = createMockDecoder();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      vi.mocked(codec.createDecoder).mockReturnValue(histDecoder);
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      vi.mocked(histDecoder.decode).mockImplementation(() => {
        const msg = histMessages[decodeCallCount % histMessages.length];
        decodeCallCount++;
        if (msg) return [{ kind: 'message', message: msg }];
        return [];
      });

      // Mock the accumulator's completedMessages to return both messages
      const histAccum = createMockAccumulator();
      Object.defineProperty(histAccum, 'completedMessages', {
        get: () => [...histMessages],
        configurable: true,
      });
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      vi.mocked(codec.createAccumulator).mockReturnValue(histAccum);

      // Mock channel.history to return the 2 messages (newest first, as Ably does)
      const histPage = {
        items: historyAblyMessages,
        hasNext: () => false,
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
        next: () => Promise.resolve(histPage),
      };
      vi.mocked(histChannel.history).mockResolvedValueOnce(histPage);

      const histSession = createClientSession({
        client: createMockClient(histChannel as unknown as Ably.RealtimeChannel),
        channelName: 'test-channel',
        codec,
        api: '/test',
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });
      await histSession.connect();

      // Load history with limit=1 — view should reveal 1 message and withhold the rest
      await histSession.view.loadOlder(1);

      const visible = histSession.view.flattenNodes();
      expect(visible).toHaveLength(1);
      expect(histSession.view.hasOlder()).toBe(true);

      await histSession.close();
    });
  });

  // -------------------------------------------------------------------------
  // close() during pending attach
  // -------------------------------------------------------------------------

  describe('close during pending attach', () => {
    it('throws when close() is called while send() awaits connect', async () => {
      let resolveAttach: (() => void) | undefined;
      const pendingChannel = createMockChannel();
      vi.mocked(pendingChannel.subscribe).mockReturnValue(
        new Promise<void>((r) => {
          resolveAttach = r;
        }),
      );

      const pendingSession = createClientSession({
        client: createMockClient(pendingChannel as unknown as Ably.RealtimeChannel),
        channelName: 'test-channel',
        codec,
        api: '/test',
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });
      // Fire-and-forget connect — its promise never resolves until we trigger
      // the subscribe mock. Send awaits the same promise.
      void pendingSession.connect();

      const sendPromise = pendingSession.view.send({ id: 'u1', content: 'hi' });

      // Close while connect is pending
      await pendingSession.close();

      // Now resolve attach — send should reject because the session is closed
      if (resolveAttach) resolveAttach();

      await expect(sendPromise).rejects.toThrow('session is closed');
    });

    it('returns silently from cancel() when close() lands while awaiting connect', async () => {
      let resolveAttach: (() => void) | undefined;
      const pendingChannel = createMockChannel();
      vi.mocked(pendingChannel.subscribe).mockReturnValue(
        new Promise<void>((r) => {
          resolveAttach = r;
        }),
      );

      const pendingTransport = createClientSession({
        client: createMockClient(pendingChannel as unknown as Ably.RealtimeChannel),
        channelName: 'test-channel',
        codec,
        api: '/test',
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });
      void pendingTransport.connect();

      const cancelPromise = pendingTransport.cancel({ all: true });

      await pendingTransport.close();
      if (resolveAttach) resolveAttach();

      // cancel must not throw and must not have published anything after CLOSED
      await expect(cancelPromise).resolves.toBeUndefined();
      expect(pendingChannel.publish).not.toHaveBeenCalled();
    });

    it('returns silently from waitForRun() when close() lands while awaiting connect', async () => {
      let resolveAttach: (() => void) | undefined;
      const pendingChannel = createMockChannel();
      vi.mocked(pendingChannel.subscribe).mockReturnValue(
        new Promise<void>((r) => {
          resolveAttach = r;
        }),
      );

      const pendingTransport = createClientSession({
        client: createMockClient(pendingChannel as unknown as Ably.RealtimeChannel),
        channelName: 'test-channel',
        codec,
        api: '/test',
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });
      void pendingTransport.connect();

      const waitPromise = pendingTransport.waitForRun({ all: true });

      await pendingTransport.close();
      if (resolveAttach) resolveAttach();

      // waitForRun must not throw and must not hang on the run-end subscription
      await expect(waitPromise).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // cancel({ all: true }) observer cleanup
  // -------------------------------------------------------------------------

  describe('cancel all preserves observer state for late events', () => {
    it('keeps observer accumulators alive after cancel all so abort events are processed', async () => {
      const accumulators: ReturnType<typeof createMockAccumulator>[] = [];
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      vi.mocked(codec.createAccumulator).mockImplementation(() => {
        const acc = createMockAccumulator();
        Object.defineProperty(acc, 'messages', {
          get: () => [{ id: `acc-msg-${String(accumulators.length)}`, content: 'accumulated' }],
          configurable: true,
        });
        accumulators.push(acc);
        return acc;
      });

      // Create an observer run
      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'observer-run',
          [HEADER_RUN_CLIENT_ID]: 'other-client',
        }),
      );

      // Accumulate an event for the observer run — creates first accumulator
      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'data' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_RUN_ID]: 'observer-run' }));
      const countBefore = accumulators.length;

      // Cancel all — observer must survive for late abort events from the server
      await session.cancel({ all: true });

      // Subsequent events reuse the same accumulator (observer not cleared)
      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'abort-data' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_RUN_ID]: 'observer-run' }));

      expect(accumulators.length).toBe(countBefore);
    });

    it('cleans up observer on run-end after cancel', async () => {
      const accumulators: ReturnType<typeof createMockAccumulator>[] = [];
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      vi.mocked(codec.createAccumulator).mockImplementation(() => {
        const acc = createMockAccumulator();
        Object.defineProperty(acc, 'messages', {
          get: () => [{ id: `acc-msg-${String(accumulators.length)}`, content: 'accumulated' }],
          configurable: true,
        });
        accumulators.push(acc);
        return acc;
      });

      // Create an observer run
      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'observer-run',
          [HEADER_RUN_CLIENT_ID]: 'other-client',
        }),
      );

      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'data' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_RUN_ID]: 'observer-run' }));
      const countBefore = accumulators.length;

      await session.cancel({ all: true });

      // Run-end cleans up the observer
      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_END, {
          [HEADER_RUN_ID]: 'observer-run',
          [HEADER_RUN_CLIENT_ID]: 'other-client',
          [HEADER_RUN_REASON]: 'cancelled',
        }),
      );

      // New events for a fresh run on the same run IDs create a new accumulator
      simulateMessage(
        channel,
        ablyMsg(EVENT_RUN_START, {
          [HEADER_RUN_ID]: 'observer-run',
          [HEADER_RUN_CLIENT_ID]: 'other-client',
        }),
      );
      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'new' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_RUN_ID]: 'observer-run' }));

      expect(accumulators.length).toBeGreaterThan(countBefore);
    });
  });

  // -------------------------------------------------------------------------
  // Initial messages emit 'message' event
  // -------------------------------------------------------------------------

  describe('initial messages notification', () => {
    it('emits message event when initial messages are provided', async () => {
      const handler = vi.fn();
      const ch = createMockChannel();
      const seeded = createClientSession({
        client: createMockClient(ch as unknown as Ably.RealtimeChannel),
        channelName: 'test-channel',
        codec,
        api: '/test',
        messages: [{ id: 'seed-1', content: 'hi' }],
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });
      await seeded.connect();

      // Register handler AFTER construction (event was already emitted during construction)
      // Verify messages are present — the event fired during construction
      expect(seeded.view.flattenNodes().map((n) => n.message)).toHaveLength(1);

      // Verify subsequent messages still emit
      seeded.view.on('update', handler);
      decoder.outputs.push({ kind: 'message', message: { id: 'new', content: 'test' } });
      simulateMessage(ch, ablyMsg('msg', { [HEADER_MSG_ID]: 'msg-new' }, undefined, 'message.create'));
      expect(handler).toHaveBeenCalled();

      void seeded.close();
    });
  });
});
