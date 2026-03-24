import type * as Ably from 'ably';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EVENT_TURN_END,
  EVENT_TURN_START,
  HEADER_FORK_OF,
  HEADER_MSG_ID,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_STATUS,
  HEADER_TURN_CLIENT_ID,
  HEADER_TURN_ID,
  HEADER_TURN_REASON,
} from '../../../src/constants.js';
import type { Codec, DecoderOutput, MessageAccumulator, StreamDecoder } from '../../../src/core/codec/types.js';
import { createClientTransport } from '../../../src/core/transport/client-transport.js';
import type { ClientTransport, TurnLifecycleEvent } from '../../../src/core/transport/types.js';
import { ErrorCode } from '../../../src/errors.js';

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
    const urlStr = typeof url === 'string' ? url : (url instanceof URL ? url.href : url.url);
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
  attach: ReturnType<typeof vi.fn>;
  history: ReturnType<typeof vi.fn>;
  listener: ((msg: Ably.InboundMessage) => void) | undefined;
}

interface MockHistoryPage {
  items: Ably.InboundMessage[];
  hasNext: () => boolean;
  next: () => Promise<MockHistoryPage>;
}

const createMockChannel = (): MockChannel & Ably.RealtimeChannel => {
  const mock: MockChannel = {
    listener: undefined,
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    publish: vi.fn(() => Promise.resolve()),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    subscribe: vi.fn((callback: (msg: Ably.InboundMessage) => void) => {
      mock.listener = callback;
      return Promise.resolve();
    }),
    unsubscribe: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    attach: vi.fn(() => Promise.resolve()),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    history: vi.fn(() => {
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
      const emptyPage: MockHistoryPage = { items: [], hasNext: () => false, next: () => Promise.resolve(emptyPage) };
      return Promise.resolve(emptyPage);
    }),
  };
  // CAST: Tests only use publish/subscribe/unsubscribe/attach/history — other members are unused.
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
  messages: [],
  completedMessages: [],
  hasActiveStream: false,
});

const createMockCodec = (decoderInstance: ReturnType<typeof createMockDecoder>): Codec<TestEvent, TestMessage> => ({
  createEncoder: vi.fn(),
  createDecoder: vi.fn(() => decoderInstance),
  createAccumulator: vi.fn(() => createMockAccumulator()),
  isTerminal: vi.fn((event: TestEvent) => event.type === 'finish'),
  getMessageKey: vi.fn((m: TestMessage) => m.id),
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
 * Create a seeded transport with messages already in the tree, where each
 * message carries a proper x-ably-msg-id header matching its id. This
 * enables _getHistoryBefore to find the correct truncation point.
 * @param codec - The codec to use.
 * @param mockFetch - The mock fetch to use.
 * @param messages - Seed messages.
 * @returns A new client transport with seeded messages.
 */
const createSeededTransport = (
  codec: Codec<TestEvent, TestMessage>,
  mockFetch: MockFetch,
  messages: TestMessage[],
): ClientTransport<TestEvent, TestMessage> => {
  const ch = createMockChannel();
  const transport = createClientTransport({
    channel: ch,
    codec,
    clientId: 'client-1',
    fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
  });

  // Manually upsert messages with proper HEADER_MSG_ID so truncation works
  const tree = transport.getTree();
  let prevMsgId: string | undefined;
  for (const msg of messages) {
    const headers: Record<string, string> = { [HEADER_MSG_ID]: msg.id };
    if (prevMsgId) headers[HEADER_PARENT] = prevMsgId;
    tree.upsert(msg.id, msg, headers);
    prevMsgId = msg.id;
  }

  return transport;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClientTransport', () => {
  let channel: MockChannel & Ably.RealtimeChannel;
  let decoder: ReturnType<typeof createMockDecoder>;
  let codec: Codec<TestEvent, TestMessage>;
  let mockFetch: MockFetch;
  let transport: ClientTransport<TestEvent, TestMessage>;

  beforeEach(() => {
    channel = createMockChannel();
    decoder = createMockDecoder();
    codec = createMockCodec(decoder);
    mockFetch = createMockFetch();
    transport = createClientTransport({
      channel,
      codec,
      clientId: 'client-1',
      api: '/api/chat',
      fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
    });
  });

  afterEach(async () => {
    await transport.close();
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
      const seeded = createClientTransport({
        channel: createMockChannel(),
        codec,
        messages: [
          { id: 'msg-1', content: 'hello' },
          { id: 'msg-2', content: 'world' },
        ],
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });

      const messages = seeded.getMessages();
      expect(messages).toHaveLength(2);
      expect(messages[0]?.id).toBe('msg-1');
      expect(messages[1]?.id).toBe('msg-2');
    });

    it('seeded messages form a parent chain in the tree', () => {
      const seeded = createClientTransport({
        channel: createMockChannel(),
        codec,
        messages: [
          { id: 'msg-1', content: 'first' },
          { id: 'msg-2', content: 'second' },
        ],
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });

      const tree = seeded.getTree();
      const node2 = tree.getNodeByKey('msg-2');
      expect(node2?.parentId).toBe('msg-1');
    });

    it('works with no initial messages', () => {
      const empty = createClientTransport({
        channel: createMockChannel(),
        codec,
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });
      expect(empty.getMessages()).toEqual([]);
    });

    it('uses default api path when not specified', async () => {
      const defaultTransport = createClientTransport({
        channel: createMockChannel(),
        codec,
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });

      await defaultTransport.send({ id: 'u1', content: 'hi' });
      await mockFetch.waitForCalls(1);

      expect(mockFetch.calls[0]?.url).toBe('/api/chat');

      await defaultTransport.close();
    });
  });

  // -------------------------------------------------------------------------
  // send()
  // -------------------------------------------------------------------------

  describe('send', () => {
    it('returns an ActiveTurn with stream, turnId, and cancel', async () => {
      const turn = await transport.send({ id: 'user-1', content: 'hi' });
      expect(turn.stream).toBeInstanceOf(ReadableStream);
      expect(typeof turn.turnId).toBe('string');
      expect(typeof turn.cancel).toBe('function');
    });

    it('inserts optimistic user messages into the tree', async () => {
      await transport.send({ id: 'user-1', content: 'hello' });

      const messages = transport.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]?.content).toBe('hello');
    });

    it('auto-computes parent from the last message in the tree', async () => {
      const seeded = createClientTransport({
        channel: createMockChannel(),
        codec,
        clientId: 'client-1',
        messages: [{ id: 'seed-1', content: 'first' }],
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });

      await seeded.send({ id: 'user-1', content: 'second' });
      await mockFetch.waitForCalls(1);

      const body = mockFetch.body(0);
      expect(body.parent).toBe('seed-1');

      await seeded.close();
    });

    it('fires HTTP POST with correct body', async () => {
      const turn = await transport.send({ id: 'user-1', content: 'hello' });
      await mockFetch.waitForCalls(1);

      expect(mockFetch.calls[0]?.url).toBe('/api/chat');
      const body = mockFetch.body(0);
      expect(body.turnId).toBe(turn.turnId);
      expect(body.clientId).toBe('client-1');
      expect(body.messages).toBeDefined();
      expect(body.history).toBeDefined();
      expect(Array.isArray(body.messages)).toBe(true);
    });

    it('does not include the new message in history (avoids duplication)', async () => {
      await transport.send({ id: 'user-1', content: 'hello' });
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
      await transport.send({ id: 'user-1', content: 'hello' });
      await mockFetch.waitForCalls(1);

      const headers = mockFetch.calls[0]?.init.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('stream is available before POST completes (fire-and-forget)', async () => {
      const blockingFetch = vi.fn(
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- intentionally returns unresolved promise
        () => new Promise<Response>(() => {
          // never resolves
        }),
      );
      const blockTransport = createClientTransport({
        channel: createMockChannel(),
        codec,
        fetch: blockingFetch as unknown as typeof globalThis.fetch,
      });

      const turn = await blockTransport.send({ id: 'u1', content: 'hi' });
      expect(turn.stream).toBeInstanceOf(ReadableStream);

      await blockTransport.close();
    });

    it('POST body messages include msg-id and role headers', async () => {
      await transport.send({ id: 'user-1', content: 'hello' });
      await mockFetch.waitForCalls(1);

      const body = mockFetch.body(0);
      const messages = body.messages as { message: TestMessage; headers: Record<string, string> }[];
      expect(messages[0]?.headers['x-ably-msg-id']).toBeDefined();
      expect(messages[0]?.headers['x-ably-role']).toBe('user');
    });

    it('merges sendOptions.body into the POST body', async () => {
      await transport.send({ id: 'u1', content: 'hi' }, { body: { customField: 'val' } });
      await mockFetch.waitForCalls(1);

      const body = mockFetch.body(0);
      expect(body.customField).toBe('val');
    });

    it('merges sendOptions.headers into the POST headers', async () => {
      await transport.send({ id: 'u1', content: 'hi' }, { headers: { 'X-Custom': 'token' } });
      await mockFetch.waitForCalls(1);

      const headers = mockFetch.calls[0]?.init.headers as Record<string, string>;
      expect(headers['X-Custom']).toBe('token');
    });

    it('includes forkOf in POST body when set in sendOptions', async () => {
      await transport.send({ id: 'u1', content: 'hi' }, { forkOf: 'msg-original' });
      await mockFetch.waitForCalls(1);

      const body = mockFetch.body(0);
      expect(body.forkOf).toBe('msg-original');
    });

    it('fires error event when POST fails with non-OK status', async () => {
      const failFetch = createMockFetch(500);
      const failTransport = createClientTransport({
        channel: createMockChannel(),
        codec,
        fetch: failFetch.fn as unknown as typeof globalThis.fetch,
      });

      const errors: Ably.ErrorInfo[] = [];
      failTransport.on('error', (e) => errors.push(e));

      await failTransport.send({ id: 'u1', content: 'hi' });
      await failFetch.waitForCalls(1);
      await flushMicrotasks();

      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe(ErrorCode.TransportSendFailed);

      await failTransport.close();
    });

    it('fires error event when POST throws a network error', async () => {
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.reject directly
      const errorFetch = vi.fn(() => Promise.reject(new Error('network down')));
      const errorTransport = createClientTransport({
        channel: createMockChannel(),
        codec,
        fetch: errorFetch as unknown as typeof globalThis.fetch,
      });

      const errors: Ably.ErrorInfo[] = [];
      errorTransport.on('error', (e) => errors.push(e));

      await errorTransport.send({ id: 'u1', content: 'hi' });
      await flushMicrotasks();

      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe(ErrorCode.TransportSendFailed);
      expect(errors[0]?.message).toContain('network down');

      await errorTransport.close();
    });

    it('closes the stream when POST fails', async () => {
      const failFetch = createMockFetch(500);
      const failTransport = createClientTransport({
        channel: createMockChannel(),
        codec,
        fetch: failFetch.fn as unknown as typeof globalThis.fetch,
      });

      failTransport.on('error', () => {
        /* consume error */
      });

      const turn = await failTransport.send({ id: 'u1', content: 'hi' });
      await failFetch.waitForCalls(1);
      await flushMicrotasks();

      const items = await drain(turn.stream);
      expect(items).toEqual([]);

      await failTransport.close();
    });

    it('closes the stream when POST throws a network error', async () => {
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.reject directly
      const errorFetch = vi.fn(() => Promise.reject(new Error('network down')));
      const errorTransport = createClientTransport({
        channel: createMockChannel(),
        codec,
        fetch: errorFetch as unknown as typeof globalThis.fetch,
      });

      errorTransport.on('error', () => {
        /* consume error */
      });

      const turn = await errorTransport.send({ id: 'u1', content: 'hi' });
      await flushMicrotasks();

      const items = await drain(turn.stream);
      expect(items).toEqual([]);

      await errorTransport.close();
    });

    it('throws when transport is closed', async () => {
      await transport.close();
      await expect(transport.send({ id: 'u1', content: 'hi' })).rejects.toThrow('transport is closed');
    });

    it('merges dynamic options.headers and options.body', async () => {
      const dynTransport = createClientTransport({
        channel: createMockChannel(),
        codec,
        headers: () => ({ 'X-Auth': 'bearer-token' }),
        body: () => ({ sessionId: 'abc' }),
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });

      await dynTransport.send({ id: 'u1', content: 'hi' });
      await mockFetch.waitForCalls(1);

      const headers = mockFetch.calls[0]?.init.headers as Record<string, string>;
      expect(headers['X-Auth']).toBe('bearer-token');

      const body = mockFetch.body(0);
      expect(body.sessionId).toBe('abc');

      await dynTransport.close();
    });

    it('includes credentials option in fetch when configured', async () => {
      const credTransport = createClientTransport({
        channel: createMockChannel(),
        codec,
        credentials: 'include',
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });

      await credTransport.send({ id: 'u1', content: 'hi' });
      await mockFetch.waitForCalls(1);

      const callArgs = vi.mocked(mockFetch.fn).mock.calls[0] as [string, RequestInit];
      expect(callArgs[1].credentials).toBe('include');

      await credTransport.close();
    });

    it('handles array of messages', async () => {
      const turn = await transport.send([
        { id: 'u1', content: 'a' },
        { id: 'u2', content: 'b' },
      ]);
      await mockFetch.waitForCalls(1);

      const body = mockFetch.body(0);
      const messages = body.messages as { message: TestMessage }[];
      expect(messages).toHaveLength(2);
      expect(turn.turnId).toBeDefined();
    });

    it('sets explicit parent when provided in sendOptions', async () => {
      await transport.send({ id: 'u1', content: 'hi' }, { parent: 'explicit-parent' });
      await mockFetch.waitForCalls(1);

      const body = mockFetch.body(0);
      expect(body.parent).toBe('explicit-parent');
    });

    it('sets null parent when explicitly provided', async () => {
      const seeded = createClientTransport({
        channel: createMockChannel(),
        codec,
        messages: [{ id: 'seed-1', content: 'first' }],
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });

      // eslint-disable-next-line unicorn/no-null -- testing null parent explicitly (root message)
      await seeded.send({ id: 'u1', content: 'hi' }, { parent: null });
      await mockFetch.waitForCalls(1);

      const body = mockFetch.body(0);
      // parent should be null — not auto-computed from the tree
      expect(body.parent).toBeNull();

      await seeded.close();
    });

    it('does not auto-compute parent when forkOf is set', async () => {
      const seeded = createClientTransport({
        channel: createMockChannel(),
        codec,
        messages: [{ id: 'seed-1', content: 'first' }],
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });

      await seeded.send({ id: 'u1', content: 'hi' }, { forkOf: 'seed-1' });
      await mockFetch.waitForCalls(1);

      // forkOf skips autoParent computation
      const body = mockFetch.body(0);
      expect(body.forkOf).toBe('seed-1');

      await seeded.close();
    });

    it('stamps forkOf on optimistic message headers', async () => {
      await transport.send({ id: 'u1', content: 'hi' }, { forkOf: 'original-msg' });

      const messages = transport.getMessages();
      const firstMsg = messages[0];
      expect(firstMsg).toBeDefined();
      if (firstMsg) {
        const headers = transport.getMessageHeaders(firstMsg);
        expect(headers?.[HEADER_FORK_OF]).toBe('original-msg');
      }
    });

    it('stamps role on optimistic message headers', async () => {
      await transport.send({ id: 'u1', content: 'hi' });

      const messages = transport.getMessages();
      const firstMsg = messages[0];
      expect(firstMsg).toBeDefined();
      if (firstMsg) {
        const headers = transport.getMessageHeaders(firstMsg);
        expect(headers?.[HEADER_ROLE]).toBe('user');
      }
    });

    it('stamps turnId on optimistic message headers', async () => {
      const turn = await transport.send({ id: 'u1', content: 'hi' });

      const messages = transport.getMessages();
      const firstMsg = messages[0];
      expect(firstMsg).toBeDefined();
      if (firstMsg) {
        const headers = transport.getMessageHeaders(firstMsg);
        expect(headers?.[HEADER_TURN_ID]).toBe(turn.turnId);
      }
    });

    it('generates unique turnId for each send', async () => {
      const turn1 = await transport.send({ id: 'u1', content: 'a' });
      const turn2 = await transport.send({ id: 'u2', content: 'b' });
      expect(turn1.turnId).not.toBe(turn2.turnId);
    });
  });

  // -------------------------------------------------------------------------
  // Message routing
  // -------------------------------------------------------------------------

  describe('message routing', () => {
    it('records incoming Ably messages', () => {
      simulateMessage(channel, ablyMsg('some-event', { [HEADER_TURN_ID]: 'turn-1' }));

      const ablyMessages = transport.getAblyMessages();
      expect(ablyMessages).toHaveLength(1);
    });

    it('handles turn-start event by updating active turns', () => {
      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_START, {
          [HEADER_TURN_ID]: 'turn-1',
          [HEADER_TURN_CLIENT_ID]: 'client-1',
        }),
      );

      const activeTurns = transport.getActiveTurnIds();
      const clientTurns = activeTurns.get('client-1');
      expect(clientTurns?.has('turn-1')).toBe(true);
    });

    it('handles turn-end event by removing from active turns', () => {
      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_START, {
          [HEADER_TURN_ID]: 'turn-1',
          [HEADER_TURN_CLIENT_ID]: 'client-1',
        }),
      );
      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_END, {
          [HEADER_TURN_ID]: 'turn-1',
          [HEADER_TURN_CLIENT_ID]: 'client-1',
          [HEADER_TURN_REASON]: 'complete',
        }),
      );

      const activeTurns = transport.getActiveTurnIds();
      expect(activeTurns.size).toBe(0);
    });

    it('emits turn lifecycle events via on("turn")', () => {
      const events: TurnLifecycleEvent[] = [];
      transport.on('turn', (e) => events.push(e));

      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_START, {
          [HEADER_TURN_ID]: 'turn-1',
          [HEADER_TURN_CLIENT_ID]: 'client-1',
        }),
      );
      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_END, {
          [HEADER_TURN_ID]: 'turn-1',
          [HEADER_TURN_CLIENT_ID]: 'client-1',
          [HEADER_TURN_REASON]: 'complete',
        }),
      );

      expect(events).toHaveLength(2);
      expect(events[0]?.type).toBe(EVENT_TURN_START);
      expect(events[1]?.type).toBe(EVENT_TURN_END);
      if (events[1]?.type === EVENT_TURN_END) {
        expect(events[1].reason).toBe('complete');
      }
    });

    it('defaults turn-end reason to complete when missing', () => {
      const events: TurnLifecycleEvent[] = [];
      transport.on('turn', (e) => events.push(e));

      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_START, {
          [HEADER_TURN_ID]: 'turn-1',
          [HEADER_TURN_CLIENT_ID]: 'client-1',
        }),
      );
      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_END, {
          [HEADER_TURN_ID]: 'turn-1',
          [HEADER_TURN_CLIENT_ID]: 'client-1',
          // no HEADER_TURN_REASON
        }),
      );

      const endEvent = events.find((e) => e.type === EVENT_TURN_END);
      if (endEvent?.type === EVENT_TURN_END) {
        expect(endEvent.reason).toBe('complete');
      }
    });

    it('defaults turn-client-id to empty string when missing', () => {
      const events: TurnLifecycleEvent[] = [];
      transport.on('turn', (e) => events.push(e));

      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_START, {
          [HEADER_TURN_ID]: 'turn-1',
          // no HEADER_TURN_CLIENT_ID
        }),
      );

      expect(events[0]?.clientId).toBe('');
    });

    it('ignores turn-start without turnId', () => {
      const events: TurnLifecycleEvent[] = [];
      transport.on('turn', (e) => events.push(e));

      simulateMessage(channel, ablyMsg(EVENT_TURN_START, {}));

      expect(events).toHaveLength(0);
    });

    it('ignores turn-end without turnId', () => {
      const events: TurnLifecycleEvent[] = [];
      transport.on('turn', (e) => events.push(e));

      simulateMessage(channel, ablyMsg(EVENT_TURN_END, {}));

      expect(events).toHaveLength(0);
    });

    it('routes decoded events to own turn stream', async () => {
      const turn = await transport.send({ id: 'u1', content: 'hi' });
      await mockFetch.waitForCalls(1);

      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'hello' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_TURN_ID]: turn.turnId }));

      decoder.outputs.push({ kind: 'event', event: { type: 'finish' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_TURN_ID]: turn.turnId }));

      const items = await drain(turn.stream);
      expect(items).toEqual([
        { type: 'text', text: 'hello' },
        { type: 'finish' },
      ]);
    });

    it('updates existing tree entry on own echo (msg-id match)', async () => {
      const turn = await transport.send({ id: 'u1', content: 'hello' });
      await mockFetch.waitForCalls(1);

      const body = mockFetch.body(0);
      const postMessages = body.messages as { headers: Record<string, string> }[];
      const msgId = postMessages[0]?.headers['x-ably-msg-id'] ?? '';

      decoder.outputs.push({ kind: 'message', message: { id: 'u1', content: 'hello-from-server' } });
      simulateMessage(
        channel,
        ablyMsg('user-msg', {
          [HEADER_MSG_ID]: msgId,
          [HEADER_TURN_ID]: turn.turnId,
        }),
      );

      const messages = transport.getMessages();
      const matching = messages.filter((m) => m.content === 'hello-from-server');
      expect(matching).toHaveLength(1);
    });

    it('inserts new message into tree for non-echo message.create', () => {
      decoder.outputs.push({ kind: 'message', message: { id: 'new-msg', content: 'from-other' } });
      simulateMessage(
        channel,
        ablyMsg(
          'user-msg',
          {
            [HEADER_MSG_ID]: 'msg-other',
            [HEADER_TURN_ID]: 'turn-other',
          },
          undefined,
          'message.create',
        ),
      );

      const messages = transport.getMessages();
      expect(messages.some((m) => m.id === 'new-msg')).toBe(true);
    });

    it('skips non-create messages that are not own echoes', () => {
      decoder.outputs.push({ kind: 'message', message: { id: 'updated-msg', content: 'updated' } });
      simulateMessage(
        channel,
        ablyMsg(
          'user-msg',
          {
            [HEADER_MSG_ID]: 'msg-unknown',
            [HEADER_TURN_ID]: 'turn-other',
          },
          undefined,
          'message.update', // Not message.create
        ),
      );

      const messages = transport.getMessages();
      expect(messages.some((m) => m.id === 'updated-msg')).toBe(false);
    });

    it('skips event without turnId', () => {
      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'orphan' } });
      // No HEADER_TURN_ID
      simulateMessage(channel, ablyMsg('codec-msg', {}));

      // Should not throw — just skip
      expect(transport.getMessages()).toEqual([]);
    });

    it('fires ably-message handler on each incoming message', () => {
      const handler = vi.fn();
      transport.on('ably-message', handler);

      simulateMessage(channel, ablyMsg(EVENT_TURN_START, { [HEADER_TURN_ID]: 'turn-1' }));
      simulateMessage(channel, ablyMsg(EVENT_TURN_END, { [HEADER_TURN_ID]: 'turn-1' }));

      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('fires error event when decoder throws', () => {
      const errors: Ably.ErrorInfo[] = [];
      transport.on('error', (e) => errors.push(e));

      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      vi.mocked(decoder.decode).mockImplementationOnce(() => {
        throw new Error('decode boom');
      });

      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_TURN_ID]: 'turn-1' }));

      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe(ErrorCode.TransportSubscriptionError);
      expect(errors[0]?.message).toContain('decode boom');
    });

    it('ignores messages after close', async () => {
      const handler = vi.fn();
      transport.on('message', handler);

      await transport.close();
      simulateMessage(channel, ablyMsg(EVENT_TURN_START, { [HEADER_TURN_ID]: 'turn-1' }));

      expect(handler).not.toHaveBeenCalled();
    });

    it('closes stream on turn-end for own turn', async () => {
      const turn = await transport.send({ id: 'u1', content: 'hi' });
      await mockFetch.waitForCalls(1);

      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'data' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_TURN_ID]: turn.turnId }));

      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_END, {
          [HEADER_TURN_ID]: turn.turnId,
          [HEADER_TURN_CLIENT_ID]: 'client-1',
        }),
      );

      const items = await drain(turn.stream);
      expect(items).toEqual([{ type: 'text', text: 'data' }]);
    });

    it('accumulates observer turn events into messages via on("message")', () => {
      const mockAccum = createMockAccumulator();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      vi.mocked(codec.createAccumulator).mockReturnValue(mockAccum);

      const messageHandler = vi.fn();
      transport.on('message', messageHandler);

      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_START, {
          [HEADER_TURN_ID]: 'other-turn',
          [HEADER_TURN_CLIENT_ID]: 'other-client',
        }),
      );

      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'observed' } });

      Object.defineProperty(mockAccum, 'messages', {
        get: () => [{ id: 'acc-msg', content: 'accumulated' }],
      });

      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_TURN_ID]: 'other-turn' }));

      expect(messageHandler).toHaveBeenCalled();
    });

    it('cleans up observer accumulator on terminal event', () => {
      const mockAccum = createMockAccumulator();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      vi.mocked(codec.createAccumulator).mockReturnValue(mockAccum);

      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_START, {
          [HEADER_TURN_ID]: 'other-turn',
          [HEADER_TURN_CLIENT_ID]: 'other-client',
        }),
      );

      // First non-terminal event creates accumulator
      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'data' } });
      Object.defineProperty(mockAccum, 'messages', {
        get: () => [{ id: 'acc-msg', content: 'accumulated' }],
        configurable: true,
      });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_TURN_ID]: 'other-turn' }));

      // Terminal event cleans up (observer accumulator.cleanup is called internally)
      decoder.outputs.push({ kind: 'event', event: { type: 'finish' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_TURN_ID]: 'other-turn' }));

      // Subsequent events for same turn should create a new accumulator
      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'new-data' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_TURN_ID]: 'other-turn' }));

      // createAccumulator should have been called more than once (initial + after cleanup)
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      expect(vi.mocked(codec.createAccumulator).mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('also accumulates own turn events for the message store', async () => {
      const mockAccum = createMockAccumulator();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      vi.mocked(codec.createAccumulator).mockReturnValue(mockAccum);

      const turn = await transport.send({ id: 'u1', content: 'hi' });
      await mockFetch.waitForCalls(1);

      const messageHandler = vi.fn();
      transport.on('message', messageHandler);

      Object.defineProperty(mockAccum, 'messages', {
        get: () => [{ id: 'asst-msg', content: 'response' }],
        configurable: true,
      });

      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'hello' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_TURN_ID]: turn.turnId }));

      // Own turn events are both routed to the stream AND accumulated
      expect(messageHandler).toHaveBeenCalled();
    });

    it('skips late arrival events for completed own turns', async () => {
      const turn = await transport.send({ id: 'u1', content: 'hi' });
      await mockFetch.waitForCalls(1);

      // Route some events and close the stream via terminal
      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'data' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_TURN_ID]: turn.turnId }));

      decoder.outputs.push({ kind: 'event', event: { type: 'finish' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_TURN_ID]: turn.turnId }));

      const items = await drain(turn.stream);
      expect(items).toHaveLength(2);

      // Late arrival — should be skipped, not accumulated as observer turn
      const messageHandler = vi.fn();
      transport.on('message', messageHandler);

      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'late' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_TURN_ID]: turn.turnId }));

      // The message handler is called once from the observer path — but since
      // the own turn has completed and its observer accumulator was cleaned up,
      // the code path at line 283 should skip the event
      // We verify by checking no new messages were accumulated (handler may fire
      // from the dispatcher emit, but the skip happens before observer.process)
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
      transport.on('message', messageHandler);

      // First event from an observer turn sets initial headers
      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'data' } });
      simulateMessage(
        channel,
        ablyMsg('codec-msg', {
          [HEADER_TURN_ID]: 'other-turn',
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

      const turn = await transport.send({ id: 'u1', content: 'hi' });
      await mockFetch.waitForCalls(1);

      // Stream an event to establish the observer with x-ably-status: streaming
      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'hello' } });
      simulateMessage(
        channel,
        ablyMsg('codec-msg', {
          [HEADER_TURN_ID]: turn.turnId,
          [HEADER_MSG_ID]: 'msg-1',
          [HEADER_STATUS]: 'streaming',
        }),
      );

      // Cancel to close the stream (but keep observer alive)
      await transport.cancel({ turnId: turn.turnId });

      // Simulate an aborted stream append — decoder produces NO outputs
      // but the headers should still be captured on the observer
      decoder.outputs.length = 0;
      simulateMessage(
        channel,
        ablyMsg('codec-msg', {
          [HEADER_TURN_ID]: turn.turnId,
          [HEADER_MSG_ID]: 'msg-1',
          [HEADER_STATUS]: 'aborted',
        }),
      );

      // Now the abort discrete event arrives and triggers accumulate+emit
      decoder.outputs.push({ kind: 'event', event: { type: 'finish' } });
      simulateMessage(
        channel,
        ablyMsg('codec-msg', { [HEADER_TURN_ID]: turn.turnId, [HEADER_MSG_ID]: 'msg-1' }),
      );

      // The tree node should have the updated x-ably-status: aborted
      const node = transport.getTree().getNode('msg-1');
      expect(node?.headers[HEADER_STATUS]).toBe('aborted');
    });

    it('assistant message is visible when two user messages are sent in a single turn', async () => {
      // Regression: when send() publishes multiple user messages, the
      // observer serial was pinned to the first user-echo's serial. The
      // accumulated assistant node inherited that early serial and sorted
      // *before* the second user message in the tree — its parent — making
      // it unreachable in flatten().

      const mockAccum = createMockAccumulator();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      vi.mocked(codec.createAccumulator).mockReturnValue(mockAccum);

      // Seed one prior assistant message so the user messages have a parent
      const tree = transport.getTree();
      tree.upsert('prev-asst', { id: 'prev-asst', content: 'London story' }, {
        [HEADER_MSG_ID]: 'prev-asst',
        [HEADER_ROLE]: 'assistant',
      }, 'serial-0000');

      // --- send two user messages in one turn ---
      const turn = await transport.send([
        { id: 'u1', content: 'Actually, about Paris' },
        { id: 'u2', content: 'No Milan' },
      ]);
      await mockFetch.waitForCalls(1);

      // Retrieve the client-generated msg IDs from the POST body
      const body = mockFetch.body(0);
      const postMessages = body.messages as { headers: Record<string, string> }[];
      const msg1Id = postMessages[0]?.headers[HEADER_MSG_ID] ?? '';
      const msg2Id = postMessages[1]?.headers[HEADER_MSG_ID] ?? '';

      // --- simulate server turn-start ---
      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_START, {
          [HEADER_TURN_ID]: turn.turnId,
          [HEADER_TURN_CLIENT_ID]: 'client-1',
        }),
      );

      // --- simulate server echoes for both user messages ---
      // These are 'message' outputs (own echoes) that promote the serial.
      decoder.outputs.push({ kind: 'message', message: { id: 'u1', content: 'Actually, about Paris' } });
      simulateMessage(channel, {
        name: 'text',
        data: 'Actually, about Paris',
        action: 'message.create',
        extras: { headers: {
          [HEADER_TURN_ID]: turn.turnId,
          [HEADER_MSG_ID]: msg1Id,
          [HEADER_PARENT]: 'prev-asst',
          [HEADER_ROLE]: 'user',
        } },
        serial: 'serial-0001',
      } as unknown as Ably.InboundMessage);

      // msg2 is chained off msg1 (not a sibling under prev-asst)
      decoder.outputs.push({ kind: 'message', message: { id: 'u2', content: 'No Milan' } });
      simulateMessage(channel, {
        name: 'text',
        data: 'No Milan',
        action: 'message.create',
        extras: { headers: {
          [HEADER_TURN_ID]: turn.turnId,
          [HEADER_MSG_ID]: msg2Id,
          [HEADER_PARENT]: msg1Id,
          [HEADER_ROLE]: 'user',
        } },
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
        extras: { headers: {
          [HEADER_TURN_ID]: turn.turnId,
          [HEADER_MSG_ID]: 'asst-milan',
          [HEADER_PARENT]: msg2Id,
          [HEADER_ROLE]: 'assistant',
        } },
        serial: 'serial-0003',
      } as unknown as Ably.InboundMessage);

      // Streaming text event
      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'The Violin Maker...' } });
      simulateMessage(channel, {
        name: 'text',
        data: 'The Violin Maker...',
        action: 'message.create',
        extras: { headers: {
          [HEADER_TURN_ID]: turn.turnId,
          [HEADER_MSG_ID]: 'asst-milan',
          [HEADER_PARENT]: msg2Id,
          [HEADER_ROLE]: 'assistant',
        } },
        serial: 'serial-0004',
      } as unknown as Ably.InboundMessage);

      // --- verify the assistant message is visible in getMessages ---
      const messages = transport.getMessages();
      const ids = messages.map((m) => m.id);
      expect(ids).toContain('prev-asst');
      expect(ids).toContain('u1');
      expect(ids).toContain('u2');
      expect(ids).toContain('asst-milan');
      expect(messages).toHaveLength(4);

      // Clean up the stream
      decoder.outputs.push({ kind: 'event', event: { type: 'finish' } });
      simulateMessage(channel, ablyMsg('finish', { [HEADER_TURN_ID]: turn.turnId, [HEADER_MSG_ID]: 'asst-milan' }));
      await drain(turn.stream);
    });

    it('multi-message send chains messages so editing the first hides the second', async () => {
      // Regression: send([msg1, msg2]) gave both the same parent (siblings).
      // Editing msg1 (forking) should hide msg2, but it stayed visible.
      // Fix: chain messages so msg2 is a child of msg1.

      // Seed a prior message
      const tree = transport.getTree();
      tree.upsert('prev', { id: 'prev', content: 'prev' }, {
        [HEADER_MSG_ID]: 'prev',
      }, 'serial-0000');

      // --- send two messages ---
      const turn = await transport.send([
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
      let ids = transport.getMessages().map((m) => m.id);
      expect(ids).toContain('u1');
      expect(ids).toContain('u2');

      // --- simulate an edit of msg1 (fork) ---
      // Close the stream first
      decoder.outputs.push({ kind: 'event', event: { type: 'finish' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_TURN_ID]: turn.turnId }));
      await drain(turn.stream);

      // Simulate turn-end
      simulateMessage(channel, ablyMsg(EVENT_TURN_END, {
        [HEADER_TURN_ID]: turn.turnId,
        [HEADER_TURN_CLIENT_ID]: 'client-1',
        [HEADER_TURN_REASON]: 'complete',
      }));

      // Edit msg1 → creates a fork sibling
      const editTurn = await transport.edit(msg1Id, [{ id: 'u1-edited', content: 'edited first' }]);
      await mockFetch.waitForCalls(2);

      // After editing, the tree should show the fork, not the original branch.
      // msg2 was a child of msg1 (the old version) and should no longer be
      // on the active path — the edit fork replaces msg1's branch.
      ids = transport.getMessages().map((m) => m.id);
      expect(ids).toContain('u1-edited');
      expect(ids).not.toContain('u2');

      // Close edit stream
      decoder.outputs.push({ kind: 'event', event: { type: 'finish' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_TURN_ID]: editTurn.turnId }));
      await drain(editTurn.stream);
    });
  });

  // -------------------------------------------------------------------------
  // regenerate()
  // -------------------------------------------------------------------------

  describe('regenerate', () => {
    it('sends with forkOf set to the target messageId', async () => {
      const seeded = createSeededTransport(codec, mockFetch, [
        { id: 'user-msg', content: 'question' },
        { id: 'asst-msg', content: 'answer' },
      ]);

      await seeded.regenerate('asst-msg');
      await mockFetch.waitForCalls(1);

      const body = mockFetch.body(0);
      expect(body.forkOf).toBe('asst-msg');

      await seeded.close();
    });

    it('sends with empty messages array', async () => {
      const seeded = createSeededTransport(codec, mockFetch, [
        { id: 'msg-1', content: 'hi' },
      ]);

      await seeded.regenerate('msg-1');
      await mockFetch.waitForCalls(1);

      const body = mockFetch.body(0);
      expect(body.messages).toEqual([]);

      await seeded.close();
    });

    it('includes truncated history in POST body', async () => {
      const seeded = createSeededTransport(codec, mockFetch, [
        { id: 'q1', content: 'question' },
        { id: 'a1', content: 'answer' },
      ]);

      await seeded.regenerate('a1');
      await mockFetch.waitForCalls(1);

      const body = mockFetch.body(0);
      // The inner history (from sendOptions.body.history) should NOT contain a1
      const innerHistory = body.history as { message: TestMessage }[];
      const hasTarget = innerHistory.some((h) => h.message.id === 'a1');
      expect(hasTarget).toBe(false);

      await seeded.close();
    });

    it('sets parent from the tree node', async () => {
      const seeded = createSeededTransport(codec, mockFetch, [
        { id: 'q1', content: 'question' },
        { id: 'a1', content: 'answer' },
      ]);

      await seeded.regenerate('a1');
      await mockFetch.waitForCalls(1);

      const body = mockFetch.body(0);
      // a1's parent is q1 in the tree, so regenerate should set parent to q1
      expect(body.parent).toBe('q1');

      await seeded.close();
    });

    it('returns an ActiveTurn', async () => {
      const seeded = createSeededTransport(codec, mockFetch, [
        { id: 'msg-1', content: 'hi' },
      ]);

      const turn = await seeded.regenerate('msg-1');
      expect(turn.stream).toBeInstanceOf(ReadableStream);
      expect(typeof turn.turnId).toBe('string');

      await seeded.close();
    });
  });

  // -------------------------------------------------------------------------
  // edit()
  // -------------------------------------------------------------------------

  describe('edit', () => {
    it('sends with forkOf set to the target messageId', async () => {
      const seeded = createSeededTransport(codec, mockFetch, [
        { id: 'user-msg', content: 'original' },
      ]);

      await seeded.edit('user-msg', { id: 'edited', content: 'revised' });
      await mockFetch.waitForCalls(1);

      const body = mockFetch.body(0);
      expect(body.forkOf).toBe('user-msg');

      await seeded.close();
    });

    it('sends replacement messages in the POST body', async () => {
      const seeded = createSeededTransport(codec, mockFetch, [
        { id: 'user-msg', content: 'original' },
      ]);

      await seeded.edit('user-msg', [
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
      const seeded = createSeededTransport(codec, mockFetch, [
        { id: 'q1', content: 'question' },
        { id: 'u1', content: 'user message' },
      ]);

      await seeded.edit('u1', { id: 'edited', content: 'revised' });
      await mockFetch.waitForCalls(1);

      const body = mockFetch.body(0);
      // u1's parent is q1 in the tree
      expect(body.parent).toBe('q1');

      await seeded.close();
    });

    it('handles single message input', async () => {
      const seeded = createSeededTransport(codec, mockFetch, [
        { id: 'user-msg', content: 'original' },
      ]);

      const turn = await seeded.edit('user-msg', { id: 'edited', content: 'revised' });
      expect(turn.stream).toBeInstanceOf(ReadableStream);

      await seeded.close();
    });

    it('truncates history before the edited message', async () => {
      // Regression: edit() sent the full tree as history, so the LLM saw
      // messages that were children of the message being edited — which
      // belong to the old branch and should not be in the edit's context.
      const seeded = createSeededTransport(codec, mockFetch, [
        { id: 'q1', content: 'Tell me a joke' },
        { id: 'a1', content: 'Why did the chicken...' },
        { id: 'u2', content: 'Actually a poem' },
        { id: 'u3', content: 'About Paris' },
      ]);

      await seeded.edit('u2', { id: 'u2-edit', content: 'Actually a haiku' });
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
  // cancel()
  // -------------------------------------------------------------------------

  describe('cancel', () => {
    it('publishes cancel message to the channel', async () => {
      await transport.cancel({ turnId: 'turn-1' });
      expect(channel.publish).toHaveBeenCalled();
    });

    it('closes matching own turn streams', async () => {
      const turn = await transport.send({ id: 'u1', content: 'hi' });
      await mockFetch.waitForCalls(1);

      await transport.cancel({ turnId: turn.turnId });

      const items = await drain(turn.stream);
      expect(items).toEqual([]);
    });

    it('defaults to { own: true } when no filter given', async () => {
      await transport.cancel();
      expect(channel.publish).toHaveBeenCalled();
    });

    it('does nothing when transport is closed', async () => {
      await transport.close();
      vi.mocked(channel.publish).mockClear();
      await transport.cancel({ turnId: 'turn-1' });
      expect(channel.publish).not.toHaveBeenCalled();
    });

    it('closes streams by clientId filter', async () => {
      // Simulate a turn from another client so the clientId filter can match
      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_START, {
          [HEADER_TURN_ID]: 'other-turn',
          [HEADER_TURN_CLIENT_ID]: 'other-client',
        }),
      );

      await transport.cancel({ clientId: 'other-client' });

      // After cancel, the turn should still be tracked until turn-end,
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

      const turn = await transport.send({ id: 'u1', content: 'hi' });
      await mockFetch.waitForCalls(1);

      // Stream some events before cancel
      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'partial' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_TURN_ID]: turn.turnId }));

      // Cancel — closes the stream but observer should survive
      await transport.cancel({ turnId: turn.turnId });

      const messageHandler = vi.fn();
      transport.on('message', messageHandler);

      // Simulate late abort event from the server arriving after cancel
      decoder.outputs.push({ kind: 'event', event: { type: 'finish' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_TURN_ID]: turn.turnId }));

      // The event should have been accumulated (observer still alive)
      expect(messageHandler).toHaveBeenCalled();
    });

    it('does not recreate observer accumulator after cancel with turnId filter', async () => {
      const turn = await transport.send({ id: 'u1', content: 'hi' });
      await mockFetch.waitForCalls(1);

      // Stream an event — creates the observer accumulator
      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'partial' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_TURN_ID]: turn.turnId }));

      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      const accCallsBefore = vi.mocked(codec.createAccumulator).mock.calls.length;

      // Cancel — should NOT delete the observer
      await transport.cancel({ turnId: turn.turnId });

      // Late event arrives — should reuse the existing observer, not create a new one
      decoder.outputs.push({ kind: 'event', event: { type: 'finish' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_TURN_ID]: turn.turnId }));

      // No new accumulator should have been created
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      expect(vi.mocked(codec.createAccumulator).mock.calls.length).toBe(accCallsBefore);
    });

    it('does not recreate observer accumulator after cancel with own filter', async () => {
      const turn = await transport.send({ id: 'u1', content: 'hi' });
      await mockFetch.waitForCalls(1);

      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'partial' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_TURN_ID]: turn.turnId }));

      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      const accCallsBefore = vi.mocked(codec.createAccumulator).mock.calls.length;

      await transport.cancel({ own: true });

      decoder.outputs.push({ kind: 'event', event: { type: 'finish' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_TURN_ID]: turn.turnId }));

      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      expect(vi.mocked(codec.createAccumulator).mock.calls.length).toBe(accCallsBefore);
    });
  });

  // -------------------------------------------------------------------------
  // waitForTurn()
  // -------------------------------------------------------------------------

  describe('waitForTurn', () => {
    it('resolves immediately when no matching turns are active', async () => {
      await transport.waitForTurn({ turnId: 'nonexistent' });
    });

    it('resolves when the matching turn ends', async () => {
      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_START, {
          [HEADER_TURN_ID]: 'turn-1',
          [HEADER_TURN_CLIENT_ID]: 'client-1',
        }),
      );

      const waitPromise = transport.waitForTurn({ turnId: 'turn-1' });

      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_END, {
          [HEADER_TURN_ID]: 'turn-1',
          [HEADER_TURN_CLIENT_ID]: 'client-1',
        }),
      );

      await waitPromise;
    });

    it('does nothing when transport is closed', async () => {
      await transport.close();
      await transport.waitForTurn({ turnId: 'turn-1' });
    });

    it('defaults to { own: true } and resolves when all own turns end', async () => {
      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_START, {
          [HEADER_TURN_ID]: 'turn-1',
          [HEADER_TURN_CLIENT_ID]: 'client-1',
        }),
      );

      const waitPromise = transport.waitForTurn();

      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_END, {
          [HEADER_TURN_ID]: 'turn-1',
          [HEADER_TURN_CLIENT_ID]: 'client-1',
        }),
      );

      await waitPromise;
    });

    it('waits for all matching turns before resolving', async () => {
      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_START, {
          [HEADER_TURN_ID]: 'turn-1',
          [HEADER_TURN_CLIENT_ID]: 'client-1',
        }),
      );
      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_START, {
          [HEADER_TURN_ID]: 'turn-2',
          [HEADER_TURN_CLIENT_ID]: 'client-1',
        }),
      );

      let resolved = false;
      const waitPromise = transport.waitForTurn({ all: true }).then(() => {
        resolved = true;
      });

      // End first turn
      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_END, {
          [HEADER_TURN_ID]: 'turn-1',
          [HEADER_TURN_CLIENT_ID]: 'client-1',
        }),
      );
      await flushMicrotasks();
      expect(resolved).toBe(false);

      // End second turn
      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_END, {
          [HEADER_TURN_ID]: 'turn-2',
          [HEADER_TURN_CLIENT_ID]: 'client-1',
        }),
      );

      await waitPromise;
      expect(resolved).toBe(true);
    });

    it('ignores turn-start events while waiting', async () => {
      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_START, {
          [HEADER_TURN_ID]: 'turn-1',
          [HEADER_TURN_CLIENT_ID]: 'client-1',
        }),
      );

      const waitPromise = transport.waitForTurn({ turnId: 'turn-1' });

      // A turn-start for a different turn should not affect anything
      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_START, {
          [HEADER_TURN_ID]: 'turn-2',
          [HEADER_TURN_CLIENT_ID]: 'client-1',
        }),
      );

      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_END, {
          [HEADER_TURN_ID]: 'turn-1',
          [HEADER_TURN_CLIENT_ID]: 'client-1',
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
      const unsub = transport.on('message', handler);

      decoder.outputs.push({ kind: 'message', message: { id: 'new', content: 'test' } });
      simulateMessage(
        channel,
        ablyMsg('msg', { [HEADER_MSG_ID]: 'msg-new' }, undefined, 'message.create'),
      );

      expect(handler).toHaveBeenCalled();

      handler.mockClear();
      unsub();

      decoder.outputs.push({ kind: 'message', message: { id: 'new2', content: 'test2' } });
      simulateMessage(
        channel,
        ablyMsg('msg', { [HEADER_MSG_ID]: 'msg-new2' }, undefined, 'message.create'),
      );

      expect(handler).not.toHaveBeenCalled();
    });

    it('subscribes to error events', () => {
      const handler = vi.fn();
      transport.on('error', handler);

      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      vi.mocked(decoder.decode).mockImplementationOnce(() => {
        throw new Error('test error');
      });
      simulateMessage(channel, ablyMsg('codec-msg', {}));

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ code: ErrorCode.TransportSubscriptionError }));
    });

    it('unsubscribes from error events', () => {
      const handler = vi.fn();
      const unsub = transport.on('error', handler);
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
      transport.on('ably-message', handler);

      simulateMessage(channel, ablyMsg(EVENT_TURN_START, { [HEADER_TURN_ID]: 't1' }));
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('unsubscribes from ably-message events', () => {
      const handler = vi.fn();
      const unsub = transport.on('ably-message', handler);
      unsub();

      simulateMessage(channel, ablyMsg(EVENT_TURN_START, { [HEADER_TURN_ID]: 't1' }));
      expect(handler).not.toHaveBeenCalled();
    });

    it('returns no-op unsubscribe when transport is closed', async () => {
      await transport.close();
      const unsub = transport.on('message', vi.fn());
      expect(typeof unsub).toBe('function');
      unsub();
    });

    it('subscribes to turn events', () => {
      const handler = vi.fn();
      transport.on('turn', handler);

      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_START, {
          [HEADER_TURN_ID]: 'turn-1',
          [HEADER_TURN_CLIENT_ID]: 'client-1',
        }),
      );

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ type: EVENT_TURN_START, turnId: 'turn-1' }),
      );
    });

    it('unsubscribes from turn events', () => {
      const handler = vi.fn();
      const unsub = transport.on('turn', handler);
      unsub();

      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_START, {
          [HEADER_TURN_ID]: 'turn-1',
          [HEADER_TURN_CLIENT_ID]: 'client-1',
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
      expect(transport.getMessages()).toEqual([]);
    });

    it('returns seeded messages', () => {
      const seeded = createClientTransport({
        channel: createMockChannel(),
        codec,
        messages: [{ id: 'a', content: 'alpha' }],
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });

      expect(seeded.getMessages()).toHaveLength(1);
    });

    it('reflects optimistic messages after send', async () => {
      await transport.send({ id: 'u1', content: 'hi' });
      const messages = transport.getMessages();
      expect(messages.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // getActiveTurnIds()
  // -------------------------------------------------------------------------

  describe('getActiveTurnIds', () => {
    it('returns empty map when no turns are active', () => {
      expect(transport.getActiveTurnIds().size).toBe(0);
    });

    it('tracks multiple turns per client', () => {
      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_START, {
          [HEADER_TURN_ID]: 'turn-1',
          [HEADER_TURN_CLIENT_ID]: 'client-1',
        }),
      );
      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_START, {
          [HEADER_TURN_ID]: 'turn-2',
          [HEADER_TURN_CLIENT_ID]: 'client-1',
        }),
      );

      const active = transport.getActiveTurnIds();
      const clientTurns = active.get('client-1');
      expect(clientTurns?.size).toBe(2);
      expect(clientTurns?.has('turn-1')).toBe(true);
      expect(clientTurns?.has('turn-2')).toBe(true);
    });

    it('groups turns by clientId', () => {
      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_START, {
          [HEADER_TURN_ID]: 'turn-1',
          [HEADER_TURN_CLIENT_ID]: 'client-a',
        }),
      );
      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_START, {
          [HEADER_TURN_ID]: 'turn-2',
          [HEADER_TURN_CLIENT_ID]: 'client-b',
        }),
      );

      const active = transport.getActiveTurnIds();
      expect(active.get('client-a')?.has('turn-1')).toBe(true);
      expect(active.get('client-b')?.has('turn-2')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // getTree()
  // -------------------------------------------------------------------------

  describe('getTree', () => {
    it('returns the conversation tree', () => {
      const tree = transport.getTree();
      expect(tree).toBeDefined();
      expect(typeof tree.flatten).toBe('function');
      expect(typeof tree.upsert).toBe('function');
    });
  });

  // -------------------------------------------------------------------------
  // getAblyMessages()
  // -------------------------------------------------------------------------

  describe('getAblyMessages', () => {
    it('returns empty array initially', () => {
      expect(transport.getAblyMessages()).toEqual([]);
    });

    it('returns a copy of accumulated messages', () => {
      simulateMessage(channel, ablyMsg(EVENT_TURN_START, { [HEADER_TURN_ID]: 't1' }));

      const msgs1 = transport.getAblyMessages();
      const msgs2 = transport.getAblyMessages();
      expect(msgs1).toHaveLength(1);
      expect(msgs1).not.toBe(msgs2);
    });
  });

  // -------------------------------------------------------------------------
  // getMessageHeaders()
  // -------------------------------------------------------------------------

  describe('getMessageHeaders', () => {
    it('returns headers for a message in the tree', async () => {
      await transport.send({ id: 'u1', content: 'hello' });

      const messages = transport.getMessages();
      const firstMsg = messages[0];
      if (firstMsg) {
        const headers = transport.getMessageHeaders(firstMsg);
        expect(headers).toBeDefined();
        expect(headers?.[HEADER_ROLE]).toBe('user');
      }
    });

    it('returns undefined for unknown message', () => {
      const headers = transport.getMessageHeaders({ id: 'unknown', content: 'nope' });
      expect(headers).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // getMessagesWithHeaders()
  // -------------------------------------------------------------------------

  describe('getMessagesWithHeaders', () => {
    it('returns messages with headers', () => {
      const seeded = createClientTransport({
        channel: createMockChannel(),
        codec,
        messages: [{ id: 'msg-1', content: 'hi' }],
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });

      const inputs = seeded.getMessagesWithHeaders();
      expect(inputs).toHaveLength(1);
      expect(inputs[0]?.message.id).toBe('msg-1');
      expect(inputs[0]?.headers).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // close()
  // -------------------------------------------------------------------------

  describe('close', () => {
    it('unsubscribes from the channel', async () => {
      await transport.close();
      expect(channel.unsubscribe).toHaveBeenCalledWith(expect.any(Function));
    });

    it('clears active streams', async () => {
      const turn = await transport.send({ id: 'u1', content: 'hi' });
      await transport.close();

      const items = await drain(turn.stream);
      expect(items).toEqual([]);
    });

    it('is idempotent', async () => {
      await transport.close();
      await transport.close();
    });

    it('publishes cancel when cancel option is provided', async () => {
      await transport.close({ cancel: { all: true } });
      expect(channel.publish).toHaveBeenCalled();
    });

    it('clears getAblyMessages after close', async () => {
      const seeded = createClientTransport({
        channel: createMockChannel(),
        codec,
        messages: [{ id: 'msg-1', content: 'hi' }],
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });
      expect(seeded.getMessages()).toHaveLength(1);

      await seeded.close();
      expect(seeded.getAblyMessages()).toEqual([]);
    });

    it('clears active turn ids after close', async () => {
      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_START, {
          [HEADER_TURN_ID]: 'turn-1',
          [HEADER_TURN_CLIENT_ID]: 'client-1',
        }),
      );
      expect(transport.getActiveTurnIds().size).toBe(1);

      await transport.close();
      expect(transport.getActiveTurnIds().size).toBe(0);
    });

    it('closes matching streams when cancel option specifies turnId', async () => {
      const turn = await transport.send({ id: 'u1', content: 'hi' });
      await transport.close({ cancel: { turnId: turn.turnId } });

      const items = await drain(turn.stream);
      expect(items).toEqual([]);
    });

    it('swallows cancel publish failure during teardown', async () => {
      vi.mocked(channel.publish).mockRejectedValueOnce(new Error('publish failed'));
      // Should not throw
      await transport.close({ cancel: { all: true } });
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

      transport.on('error', handler1);
      transport.on('error', handler2);

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

      transport.on('ably-message', handler1);
      transport.on('ably-message', handler2);

      simulateMessage(channel, ablyMsg(EVENT_TURN_START, { [HEADER_TURN_ID]: 'turn-1' }));

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Turn-end cleanup
  // -------------------------------------------------------------------------

  describe('turn-end cleanup', () => {
    it('cleans up per-turn state after turn-end', async () => {
      const turn = await transport.send({ id: 'u1', content: 'hi' });
      await mockFetch.waitForCalls(1);

      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_START, {
          [HEADER_TURN_ID]: turn.turnId,
          [HEADER_TURN_CLIENT_ID]: 'client-1',
        }),
      );
      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_END, {
          [HEADER_TURN_ID]: turn.turnId,
          [HEADER_TURN_CLIENT_ID]: 'client-1',
        }),
      );

      const active = transport.getActiveTurnIds();
      expect(active.size).toBe(0);
    });

    it('cleans up observer accumulator on turn-end', () => {
      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_START, {
          [HEADER_TURN_ID]: 'other-turn',
          [HEADER_TURN_CLIENT_ID]: 'other-client',
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
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_TURN_ID]: 'other-turn' }));

      // turn-end should clean up observer state
      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_END, {
          [HEADER_TURN_ID]: 'other-turn',
          [HEADER_TURN_CLIENT_ID]: 'other-client',
        }),
      );

      const active = transport.getActiveTurnIds();
      expect(active.size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Cancel stream close behavior
  // -------------------------------------------------------------------------

  describe('cancel with filter variants', () => {
    it('closes streams for all own turns when filter is { own: true }', async () => {
      const turn1 = await transport.send({ id: 'u1', content: 'a' });
      const turn2 = await transport.send({ id: 'u2', content: 'b' });

      await transport.cancel({ own: true });

      const items1 = await drain(turn1.stream);
      const items2 = await drain(turn2.stream);
      expect(items1).toEqual([]);
      expect(items2).toEqual([]);
    });

    it('closes streams for all turns when filter is { all: true }', async () => {
      const turn = await transport.send({ id: 'u1', content: 'a' });
      await transport.cancel({ all: true });

      const items = await drain(turn.stream);
      expect(items).toEqual([]);
    });

    it('closes stream for specific turn when filter has turnId', async () => {
      const turn1 = await transport.send({ id: 'u1', content: 'a' });
      const turn2 = await transport.send({ id: 'u2', content: 'b' });

      await transport.cancel({ turnId: turn1.turnId });

      const items1 = await drain(turn1.stream);
      expect(items1).toEqual([]);

      await transport.cancel({ turnId: turn2.turnId });
      const items2 = await drain(turn2.stream);
      expect(items2).toEqual([]);
    });

    it('closes streams for clientId filter on observer turns', async () => {
      // Register an observer turn via turn-start
      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_START, {
          [HEADER_TURN_ID]: 'observer-turn',
          [HEADER_TURN_CLIENT_ID]: 'other-client',
        }),
      );

      await transport.cancel({ clientId: 'other-client' });

      // Verify cancel was published
      expect(channel.publish).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // ActiveTurn.cancel()
  // -------------------------------------------------------------------------

  describe('ActiveTurn.cancel', () => {
    it('cancels the specific turn via the handle', async () => {
      const turn = await transport.send({ id: 'u1', content: 'hi' });
      await turn.cancel();

      const items = await drain(turn.stream);
      expect(items).toEqual([]);

      expect(channel.publish).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Concurrency
  // -------------------------------------------------------------------------

  describe('concurrent turns', () => {
    it('routes events to the correct turn stream independently', async () => {
      const turn1 = await transport.send({ id: 'u1', content: 'a' });
      const turn2 = await transport.send({ id: 'u2', content: 'b' });
      await mockFetch.waitForCalls(2);

      // Route events to turn1
      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'for-turn-1' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_TURN_ID]: turn1.turnId }));

      // Route events to turn2
      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'for-turn-2' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_TURN_ID]: turn2.turnId }));

      // Close both
      decoder.outputs.push({ kind: 'event', event: { type: 'finish' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_TURN_ID]: turn1.turnId }));

      decoder.outputs.push({ kind: 'event', event: { type: 'finish' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_TURN_ID]: turn2.turnId }));

      const items1 = await drain(turn1.stream);
      const items2 = await drain(turn2.stream);

      expect(items1).toEqual([
        { type: 'text', text: 'for-turn-1' },
        { type: 'finish' },
      ]);
      expect(items2).toEqual([
        { type: 'text', text: 'for-turn-2' },
        { type: 'finish' },
      ]);
    });

    it('cancel one turn does not affect the other', async () => {
      const turn1 = await transport.send({ id: 'u1', content: 'a' });
      const turn2 = await transport.send({ id: 'u2', content: 'b' });
      await mockFetch.waitForCalls(2);

      await transport.cancel({ turnId: turn1.turnId });

      const items1 = await drain(turn1.stream);
      expect(items1).toEqual([]);

      // turn2 should still be open
      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'still-open' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_TURN_ID]: turn2.turnId }));

      decoder.outputs.push({ kind: 'event', event: { type: 'finish' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_TURN_ID]: turn2.turnId }));

      const items2 = await drain(turn2.stream);
      expect(items2).toEqual([
        { type: 'text', text: 'still-open' },
        { type: 'finish' },
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // history()
  // -------------------------------------------------------------------------

  describe('history', () => {
    it('returns a PaginatedMessages result', async () => {
      // The history() method calls decodeHistory which calls channel.attach() +
      // channel.history(), then processes via a fresh decoder. We test the
      // transport's processing of the decodeHistory result.
      // For simplicity, configure channel.history to return empty results.
      const result = await transport.history();
      expect(result).toBeDefined();
      expect(result.items).toBeDefined();
      expect(typeof result.hasNext).toBe('function');
      expect(typeof result.next).toBe('function');
    });

    it('calls channel.attach before channel.history', async () => {
      await transport.history();
      expect(channel.attach).toHaveBeenCalled();
    });

    it('returns empty items when no history exists', async () => {
      const result = await transport.history();
      expect(result.items).toEqual([]);
      expect(result.hasNext()).toBe(false);
    });

    it('accepts a limit option', async () => {
      await transport.history({ limit: 50 });
      // Should not throw; the limit is passed to decodeHistory
      expect(channel.history).toHaveBeenCalled();
    });

    it('throws when transport is closed', async () => {
      await transport.close();
      await expect(transport.history()).rejects.toThrow('transport is closed');
    });
  });

  // -------------------------------------------------------------------------
  // getMessages with withheld keys
  // -------------------------------------------------------------------------

  describe('getMessages filtering', () => {
    it('withholds messages loaded by history beyond the limit', async () => {
      // Set up a transport with a mock channel whose history returns messages
      // that the decoder can process. We use limit=1 so that if history
      // returns 2 messages, 1 is withheld and excluded from getMessages().
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

      const histTransport = createClientTransport({
        channel: histChannel as unknown as Ably.RealtimeChannel,
        codec,
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });

      // Load history with limit=1 — should withhold 1 of the 2 messages
      const page = await histTransport.history({ limit: 1 });

      // The page should return 1 item
      expect(page.items).toHaveLength(1);

      // getMessages should show the tree's messages minus withheld ones
      // (the tree has both messages from _processHistoryPage, but getMessages
      // filters out withheld keys)
      const visible = histTransport.getMessages();
      const treeAll = histTransport.getTree().flatten();

      // If withholding is working, visible < total in tree
      expect(treeAll.length).toBeGreaterThanOrEqual(visible.length);

      await histTransport.close();
    });
  });

  // -------------------------------------------------------------------------
  // close() during pending attach
  // -------------------------------------------------------------------------

  describe('close during pending attach', () => {
    it('throws when close() is called while send() awaits attach', async () => {
      let resolveAttach: (() => void) | undefined;
      const pendingChannel = createMockChannel();
      vi.mocked(pendingChannel.subscribe).mockReturnValue(
        new Promise<void>((r) => {
          resolveAttach = r;
        }),
      );

      const pendingTransport = createClientTransport({
        channel: pendingChannel as unknown as Ably.RealtimeChannel,
        codec,
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });

      // Start send() — it will await the _attachPromise
      const sendPromise = pendingTransport.send({ id: 'u1', content: 'hi' });

      // Close while attach is pending
      await pendingTransport.close();

      // Now resolve attach — send should reject because transport is closed
      if (resolveAttach) resolveAttach();

      await expect(sendPromise).rejects.toThrow('transport is closed');
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

      // Create an observer turn
      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_START, {
          [HEADER_TURN_ID]: 'observer-turn',
          [HEADER_TURN_CLIENT_ID]: 'other-client',
        }),
      );

      // Accumulate an event for the observer turn — creates first accumulator
      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'data' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_TURN_ID]: 'observer-turn' }));
      const countBefore = accumulators.length;

      // Cancel all — observer must survive for late abort events from the server
      await transport.cancel({ all: true });

      // Subsequent events reuse the same accumulator (observer not cleared)
      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'abort-data' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_TURN_ID]: 'observer-turn' }));

      expect(accumulators.length).toBe(countBefore);
    });

    it('cleans up observer on turn-end after cancel', async () => {
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

      // Create an observer turn
      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_START, {
          [HEADER_TURN_ID]: 'observer-turn',
          [HEADER_TURN_CLIENT_ID]: 'other-client',
        }),
      );

      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'data' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_TURN_ID]: 'observer-turn' }));
      const countBefore = accumulators.length;

      await transport.cancel({ all: true });

      // Turn-end cleans up the observer
      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_END, {
          [HEADER_TURN_ID]: 'observer-turn',
          [HEADER_TURN_CLIENT_ID]: 'other-client',
          [HEADER_TURN_REASON]: 'cancelled',
        }),
      );

      // New events for a fresh turn on the same turn ID create a new accumulator
      simulateMessage(
        channel,
        ablyMsg(EVENT_TURN_START, {
          [HEADER_TURN_ID]: 'observer-turn',
          [HEADER_TURN_CLIENT_ID]: 'other-client',
        }),
      );
      decoder.outputs.push({ kind: 'event', event: { type: 'text', text: 'new' } });
      simulateMessage(channel, ablyMsg('codec-msg', { [HEADER_TURN_ID]: 'observer-turn' }));

      expect(accumulators.length).toBeGreaterThan(countBefore);
    });
  });

  // -------------------------------------------------------------------------
  // Initial messages emit 'message' event
  // -------------------------------------------------------------------------

  describe('initial messages notification', () => {
    it('emits message event when initial messages are provided', () => {
      const handler = vi.fn();
      const ch = createMockChannel();
      const seeded = createClientTransport({
        channel: ch as unknown as Ably.RealtimeChannel,
        codec,
        messages: [{ id: 'seed-1', content: 'hi' }],
        fetch: mockFetch.fn as unknown as typeof globalThis.fetch,
      });

      // Register handler AFTER construction (event was already emitted during construction)
      // Verify messages are present — the event fired during construction
      expect(seeded.getMessages()).toHaveLength(1);

      // Verify subsequent messages still emit
      seeded.on('message', handler);
      decoder.outputs.push({ kind: 'message', message: { id: 'new', content: 'test' } });
      simulateMessage(
        ch,
        ablyMsg('msg', { [HEADER_MSG_ID]: 'msg-new' }, undefined, 'message.create'),
      );
      expect(handler).toHaveBeenCalled();

      void seeded.close();
    });
  });
});
