import '../../helper/expectations.js';

import type * as Ably from 'ably';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EVENT_CANCEL,
  EVENT_TURN_END,
  EVENT_TURN_START,
  HEADER_CANCEL_ALL,
  HEADER_CANCEL_CLIENT_ID,
  HEADER_CANCEL_OWN,
  HEADER_CANCEL_TURN_ID,
  HEADER_MSG_ID,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_TURN_ID,
} from '../../../src/constants.js';
import type { Codec, StreamEncoder } from '../../../src/core/codec/types.js';
import { createServerTransport } from '../../../src/core/transport/server-transport.js';
import type { ConversationNode, ServerTransport } from '../../../src/core/transport/types.js';
import { ErrorCode } from '../../../src/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestEvent { type: string; text?: string }
interface TestMessage { id: string; content: string }

const makeNode = (message: TestMessage, overrides?: Partial<ConversationNode<TestMessage>>): ConversationNode<TestMessage> => ({
  message,
  msgId: overrides?.msgId ?? crypto.randomUUID(),
  parentId: undefined,
  forkOf: undefined,
  headers: {},
  serial: undefined,
  ...overrides,
});

interface MockChannel {
  publish: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  publishCalls: (Ably.Message | Ably.Message[])[];
  listeners: Map<string, ((msg: Ably.InboundMessage) => void)[]>;
}

const createMockChannel = (): MockChannel & Ably.RealtimeChannel => {
  const mock: MockChannel = {
    publishCalls: [],
    listeners: new Map(),
    // eslint-disable-next-line @typescript-eslint/require-await -- mock
    publish: vi.fn(async (msgOrMsgs: Ably.Message | Ably.Message[]) => {
      mock.publishCalls.push(msgOrMsgs);
      return { serials: ['serial-1'] } as Ably.PublishResult;
    }),
    // eslint-disable-next-line @typescript-eslint/require-await -- mock
    subscribe: vi.fn(async (name: string, listener: (msg: Ably.InboundMessage) => void) => {
      const arr = mock.listeners.get(name) ?? [];
      arr.push(listener);
      mock.listeners.set(name, arr);
    }),
    unsubscribe: vi.fn((name: string, listener: (msg: Ably.InboundMessage) => void) => {
      const arr = mock.listeners.get(name) ?? [];
      mock.listeners.set(
        name,
        arr.filter((l) => l !== listener),
      );
    }),
  };
  // CAST: Tests only use publish/subscribe/unsubscribe — other members are unused.
  return mock as unknown as MockChannel & Ably.RealtimeChannel;
};

const mockPublishResult = { serials: ['serial-1'] } as unknown as Ably.PublishResult;

const createMockEncoder = (): StreamEncoder<TestEvent, TestMessage> => ({
  // eslint-disable-next-line @typescript-eslint/no-empty-function -- mock
  appendEvent: vi.fn(async () => {}),
  // eslint-disable-next-line @typescript-eslint/no-empty-function -- mock
  abort: vi.fn(async () => {}),
  // eslint-disable-next-line @typescript-eslint/no-empty-function -- mock
  close: vi.fn(async () => {}),
  // eslint-disable-next-line @typescript-eslint/require-await -- mock
  writeMessages: vi.fn(async () => mockPublishResult),
  // eslint-disable-next-line @typescript-eslint/require-await -- mock
  writeEvent: vi.fn(async () => mockPublishResult),
});

const createMockCodec = (): Codec<TestEvent, TestMessage> => ({
  createEncoder: vi.fn(() => createMockEncoder()),
  createDecoder: vi.fn() as Codec<TestEvent, TestMessage>['createDecoder'],
  createAccumulator: vi.fn() as Codec<TestEvent, TestMessage>['createAccumulator'],
  isTerminal: vi.fn(() => false),
});

const headersOf = (msg: Ably.Message): Record<string, string> =>
  (msg.extras as { headers: Record<string, string> }).headers;

/**
 * Simulate a cancel message arriving on the channel.
 * @param channel - The mock channel with listeners.
 * @param headers - Cancel headers to include.
 * @param clientId - Sender clientId.
 */
const simulateCancel = (
  channel: MockChannel,
  headers: Record<string, string>,
  clientId?: string,
): void => {
  const listeners = channel.listeners.get(EVENT_CANCEL) ?? [];
  const msg = {
    name: EVENT_CANCEL,
    clientId,
    extras: { headers },
  } as unknown as Ably.InboundMessage;
  for (const listener of listeners) {
    listener(msg);
  }
};

/**
 * Get the options from the last createEncoder call.
 * @param c - The codec mock.
 * @returns The encoder options from the last call.
 */
const lastEncoderOpts = (c: Codec<TestEvent, TestMessage>) => {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- accessing vi mock
  const calls = vi.mocked(c.createEncoder).mock.calls;
  const last = calls.at(-1);
  expect(last).toBeDefined();
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by expect above
  return last![1];
};

/**
 * Create a ReadableStream from events.
 * @param events - Events to enqueue.
 * @returns A ReadableStream that emits the events then closes.
 */
const streamOf = (...events: TestEvent[]): ReadableStream<TestEvent> =>
  new ReadableStream({
    start: (controller) => {
      for (const event of events) {
        controller.enqueue(event);
      }
      controller.close();
    },
  });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ServerTransport', () => {
  let channel: MockChannel & Ably.RealtimeChannel;
  let codec: Codec<TestEvent, TestMessage>;
  let transport: ServerTransport<TestEvent, TestMessage>;

  beforeEach(() => {
    channel = createMockChannel();
    codec = createMockCodec();
    transport = createServerTransport({ channel, codec });
  });

  afterEach(() => {
    transport.close();
  });

  describe('newTurn', () => {
    it('returns a Turn with the correct turnId', () => {
      const turn = transport.newTurn({ turnId: 'turn-1' });
      expect(turn.turnId).toBe('turn-1');
    });

    it('returns a Turn with an AbortSignal', () => {
      const turn = transport.newTurn({ turnId: 'turn-1' });
      expect(turn.abortSignal).toBeInstanceOf(AbortSignal);
      expect(turn.abortSignal.aborted).toBe(false);
    });
  });

  describe('turn lifecycle', () => {
    it('start publishes turn-start event', async () => {
      const turn = transport.newTurn({ turnId: 'turn-1', clientId: 'user-a' });
      await turn.start();

      const startMsg = channel.publishCalls.find(
        (m) => !Array.isArray(m) && m.name === EVENT_TURN_START,
      ) as Ably.Message | undefined;
      expect(startMsg).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- narrowed by expect(startMsg).toBeDefined() above
      expect(headersOf(startMsg!)[HEADER_TURN_ID]).toBe('turn-1');
    });

    it('start is idempotent', async () => {
      const turn = transport.newTurn({ turnId: 'turn-1' });
      await turn.start();
      await turn.start();

      const startMsgs = channel.publishCalls.filter(
        (m) => !Array.isArray(m) && (m).name === EVENT_TURN_START,
      );
      expect(startMsgs).toHaveLength(1);
    });

    it('end publishes turn-end event', async () => {
      const turn = transport.newTurn({ turnId: 'turn-1' });
      await turn.start();
      await turn.end('complete');

      const endMsg = channel.publishCalls.find(
        (m) => !Array.isArray(m) && m.name === EVENT_TURN_END,
      ) as Ably.Message | undefined;
      expect(endMsg).toBeDefined();
    });

    it('end is idempotent', async () => {
      const turn = transport.newTurn({ turnId: 'turn-1' });
      await turn.start();
      await turn.end('complete');
      await turn.end('complete');

      const endMsgs = channel.publishCalls.filter(
        (m) => !Array.isArray(m) && (m).name === EVENT_TURN_END,
      );
      expect(endMsgs).toHaveLength(1);
    });

    it('addMessages throws if start() not called', async () => {
      const turn = transport.newTurn({ turnId: 'turn-1' });
      await expect(
        turn.addMessages([makeNode({ id: '1', content: 'hi' })]),
      ).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });

    it('streamResponse throws if start() not called', async () => {
      const turn = transport.newTurn({ turnId: 'turn-1' });
      await expect(turn.streamResponse(streamOf())).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });

    it('end throws if start() not called', async () => {
      const turn = transport.newTurn({ turnId: 'turn-1' });
      await expect(turn.end('complete')).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });
  });

  describe('addMessages', () => {
    it('creates encoder with user role and turn headers', async () => {
      const turn = transport.newTurn({ turnId: 'turn-1', clientId: 'user-a' });
      await turn.start();
      await turn.addMessages([makeNode({ id: 'm1', content: 'hello' })]);

      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      expect(codec.createEncoder).toHaveBeenCalled();
      const opts = lastEncoderOpts(codec);
      const headers = opts?.extras?.headers ?? {};
      expect(headers[HEADER_ROLE]).toBe('user');
      expect(headers[HEADER_TURN_ID]).toBe('turn-1');
      expect(headers[HEADER_MSG_ID]).toBeDefined();
    });

    it('creates one encoder per message for distinct headers', async () => {
      const turn = transport.newTurn({ turnId: 'turn-1' });
      await turn.start();
      await turn.addMessages([
        makeNode({ id: 'm1', content: 'a' }),
        makeNode({ id: 'm2', content: 'b' }),
      ]);

      // Each message gets its own encoder (distinct x-ably-msg-id)
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      expect(vi.mocked(codec.createEncoder).mock.calls).toHaveLength(2);
    });

    it('per-message headers override transport defaults', async () => {
      const turn = transport.newTurn({ turnId: 'turn-1' });
      await turn.start();
      await turn.addMessages([makeNode({ id: 'm1', content: 'hi' }, {
        msgId: 'client-assigned-id',
        headers: { [HEADER_MSG_ID]: 'client-assigned-id', 'x-domain-foo': 'bar' },
      })]);

      const opts = lastEncoderOpts(codec);
      const headers = opts?.extras?.headers ?? {};
      // Client headers override transport defaults
      expect(headers[HEADER_MSG_ID]).toBe('client-assigned-id');
      expect(headers['x-domain-foo']).toBe('bar');
      // Transport headers still present for non-overridden keys
      expect(headers[HEADER_ROLE]).toBe('user');
      expect(headers[HEADER_TURN_ID]).toBe('turn-1');
    });

    it('uses node parentId and forkOf in transport headers', async () => {
      const turn = transport.newTurn({ turnId: 'turn-1' });
      await turn.start();
      await turn.addMessages([makeNode({ id: 'm1', content: 'hi' }, {
        parentId: 'parent-abc',
        forkOf: 'fork-xyz',
      })]);

      const opts = lastEncoderOpts(codec);
      const headers = opts?.extras?.headers ?? {};
      expect(headers[HEADER_PARENT]).toBe('parent-abc');
    });

    it('returns published msg-ids', async () => {
      const turn = transport.newTurn({ turnId: 'turn-1' });
      await turn.start();
      const node1 = makeNode({ id: 'm1', content: 'a' });
      const node2 = makeNode({ id: 'm2', content: 'b' });
      const { msgIds } = await turn.addMessages([node1, node2]);

      expect(msgIds).toHaveLength(2);
      expect(msgIds[0]).toBe(node1.msgId);
      expect(msgIds[1]).toBe(node2.msgId);
    });
  });

  describe('streamResponse', () => {
    it('creates encoder with assistant role', async () => {
      const turn = transport.newTurn({ turnId: 'turn-1', clientId: 'user-a' });
      await turn.start();
      await turn.streamResponse(streamOf({ type: 'text', text: 'hi' }));

      const opts = lastEncoderOpts(codec);
      const headers = opts?.extras?.headers ?? {};
      expect(headers[HEADER_ROLE]).toBe('assistant');
      expect(headers[HEADER_TURN_ID]).toBe('turn-1');
    });

    it('returns complete reason for normal stream', async () => {
      const turn = transport.newTurn({ turnId: 'turn-1' });
      await turn.start();
      const result = await turn.streamResponse(streamOf({ type: 'text', text: 'done' }));
      expect(result.reason).toBe('complete');
    });

    it('uses explicit parent from streamResponse options', async () => {
      const turn = transport.newTurn({ turnId: 'turn-1' });
      await turn.start();
      const { msgIds } = await turn.addMessages([makeNode({ id: 'm1', content: 'q' })]);

      await turn.streamResponse(streamOf({ type: 'text', text: 'answer' }), {
        parent: msgIds.at(-1),
      });

      const streamOpts = lastEncoderOpts(codec);
      const assistantParent = streamOpts?.extras?.headers?.[HEADER_PARENT];
      expect(assistantParent).toBe(msgIds[0]);
    });
  });

  describe('cancel routing', () => {
    it('aborts turn when cancel by turnId arrives', async () => {
      const turn = transport.newTurn({ turnId: 'turn-1', clientId: 'user-a' });
      await turn.start();

      simulateCancel(channel, { [HEADER_CANCEL_TURN_ID]: 'turn-1' });

      // Allow async handler to run
      await new Promise((r) => setTimeout(r, 10));

      expect(turn.abortSignal.aborted).toBe(true);
    });

    it('aborts own turns when cancel own arrives', async () => {
      const turn1 = transport.newTurn({ turnId: 'turn-1', clientId: 'user-a' });
      const turn2 = transport.newTurn({ turnId: 'turn-2', clientId: 'user-b' });
      await turn1.start();
      await turn2.start();

      simulateCancel(channel, { [HEADER_CANCEL_OWN]: 'true' }, 'user-a');
      await new Promise((r) => setTimeout(r, 10));

      expect(turn1.abortSignal.aborted).toBe(true);
      expect(turn2.abortSignal.aborted).toBe(false);
    });

    it('aborts turns by clientId', async () => {
      const turn1 = transport.newTurn({ turnId: 'turn-1', clientId: 'user-a' });
      const turn2 = transport.newTurn({ turnId: 'turn-2', clientId: 'user-b' });
      await turn1.start();
      await turn2.start();

      simulateCancel(channel, { [HEADER_CANCEL_CLIENT_ID]: 'user-b' });
      await new Promise((r) => setTimeout(r, 10));

      expect(turn1.abortSignal.aborted).toBe(false);
      expect(turn2.abortSignal.aborted).toBe(true);
    });

    it('aborts all turns when cancel all arrives', async () => {
      const turn1 = transport.newTurn({ turnId: 'turn-1', clientId: 'user-a' });
      const turn2 = transport.newTurn({ turnId: 'turn-2', clientId: 'user-b' });
      await turn1.start();
      await turn2.start();

      simulateCancel(channel, { [HEADER_CANCEL_ALL]: 'true' });
      await new Promise((r) => setTimeout(r, 10));

      expect(turn1.abortSignal.aborted).toBe(true);
      expect(turn2.abortSignal.aborted).toBe(true);
    });

    it('onCancel returning false prevents abort', async () => {
      const turn = transport.newTurn({
        turnId: 'turn-1',
        clientId: 'user-a',
        // eslint-disable-next-line @typescript-eslint/require-await -- mock
        onCancel: async () => false,
      });
      await turn.start();

      simulateCancel(channel, { [HEADER_CANCEL_TURN_ID]: 'turn-1' });
      await new Promise((r) => setTimeout(r, 10));

      expect(turn.abortSignal.aborted).toBe(false);
    });

    it('does nothing when no turns match', async () => {
      const turn = transport.newTurn({ turnId: 'turn-1' });
      await turn.start();

      simulateCancel(channel, { [HEADER_CANCEL_TURN_ID]: 'turn-999' });
      await new Promise((r) => setTimeout(r, 10));

      expect(turn.abortSignal.aborted).toBe(false);
    });
  });

  describe('early cancel', () => {
    it('fires abort signal even before start() is called', async () => {
      const turn = transport.newTurn({ turnId: 'turn-1', clientId: 'user-a' });

      simulateCancel(channel, { [HEADER_CANCEL_TURN_ID]: 'turn-1' });
      await new Promise((r) => setTimeout(r, 10));

      expect(turn.abortSignal.aborted).toBe(true);
    });

    it('start() throws when turn was cancelled early', async () => {
      const turn = transport.newTurn({ turnId: 'turn-1' });

      simulateCancel(channel, { [HEADER_CANCEL_TURN_ID]: 'turn-1' });
      await new Promise((r) => setTimeout(r, 10));

      await expect(turn.start()).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });
  });

  describe('error handling', () => {
    it('start() calls onError and throws on publish failure', async () => {
      const failChannel = createMockChannel();
      vi.mocked(failChannel.publish).mockRejectedValue(new Error('publish failed'));
      const onError = vi.fn();

      const failTransport = createServerTransport({
        channel: failChannel,
        codec,
        onError,
      });
      const turn = failTransport.newTurn({
        turnId: 'turn-1',
        onError,
      });

      await expect(turn.start()).rejects.toBeErrorInfoWithCode(ErrorCode.TurnLifecycleError);
      expect(onError).toHaveBeenCalled();

      failTransport.close();
    });

    it('end() calls onError and throws on publish failure', async () => {
      const turn = transport.newTurn({ turnId: 'turn-1', onError: vi.fn() });
      await turn.start();

      // Make the next publish fail (for turn-end)
      vi.mocked(channel.publish).mockRejectedValueOnce(new Error('publish failed'));

      await expect(turn.end('complete')).rejects.toBeErrorInfoWithCode(ErrorCode.TurnLifecycleError);
    });

    it('onCancel handler error calls onError and does not prevent other turns', async () => {
      const onError = vi.fn();
      const turn1 = transport.newTurn({
        turnId: 'turn-1',
        clientId: 'user-a',
        // eslint-disable-next-line @typescript-eslint/require-await -- mock throws
        onCancel: async () => { throw new Error('handler broke'); },
        onError,
      });
      const turn2 = transport.newTurn({ turnId: 'turn-2', clientId: 'user-a' });
      await turn1.start();
      await turn2.start();

      simulateCancel(channel, { [HEADER_CANCEL_ALL]: 'true' });
      await new Promise((r) => setTimeout(r, 10));

      // turn1's onCancel threw, but turn2 should still be aborted
      expect(turn2.abortSignal.aborted).toBe(true);
      expect(onError).toHaveBeenCalled();
    });
  });

  describe('close', () => {
    it('aborts all registered turns', async () => {
      const turn1 = transport.newTurn({ turnId: 'turn-1' });
      const turn2 = transport.newTurn({ turnId: 'turn-2' });
      await turn1.start();
      await turn2.start();

      transport.close();

      expect(turn1.abortSignal.aborted).toBe(true);
      expect(turn2.abortSignal.aborted).toBe(true);
    });

    it('unsubscribes from cancel messages', () => {
      transport.close();
      expect(channel.unsubscribe).toHaveBeenCalledWith(EVENT_CANCEL, expect.any(Function));
    });
  });
});
