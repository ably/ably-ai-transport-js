import '../../helper/expectations.js';

import type * as Ably from 'ably';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EVENT_CANCEL,
  EVENT_TURN_END,
  EVENT_TURN_START,
  HEADER_AMEND,
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
import type { MessageNode, ServerTransport } from '../../../src/core/transport/types.js';
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

interface MockChannel {
  publish: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  state: Ably.ChannelState;
  publishCalls: (Ably.Message | Ably.Message[])[];
  listeners: Map<string, ((msg: Ably.InboundMessage) => void)[]>;
  stateListeners: Set<Ably.channelEventCallback>;
}

const createMockChannel = (): MockChannel & Ably.RealtimeChannel => {
  const stateListeners = new Set<Ably.channelEventCallback>();
  const mock: MockChannel = {
    publishCalls: [],
    listeners: new Map(),
    stateListeners,
    // Default to 'attached' — most tests don't care about state transitions
    // and this lets existing publishes work without setup.
    state: 'attached',
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
    on: vi.fn((callback: Ably.channelEventCallback) => {
      stateListeners.add(callback);
    }),
    off: vi.fn((callback: Ably.channelEventCallback) => {
      stateListeners.delete(callback);
    }),
  };
  // CAST: Tests only use publish/subscribe/unsubscribe/on/off/state — other members are unused.
  return mock as unknown as MockChannel & Ably.RealtimeChannel;
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
 * Simulate the initial attach so the transport doesn't treat subsequent
 * state changes as the first attach.
 * @param ch - The mock channel to simulate initial attach on.
 */
const simulateInitialAttach = (ch: MockChannel): void => {
  simulateStateChange(ch, {
    current: 'attached',
    previous: 'attaching',
    resumed: false,
  } as Ably.ChannelStateChange);
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
const simulateCancel = (channel: MockChannel, headers: Record<string, string>, clientId?: string): void => {
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

      const startMsg = channel.publishCalls.find((m) => !Array.isArray(m) && m.name === EVENT_TURN_START) as
        | Ably.Message
        | undefined;
      expect(startMsg).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- narrowed by expect(startMsg).toBeDefined() above
      expect(headersOf(startMsg!)[HEADER_TURN_ID]).toBe('turn-1');
    });

    it('start is idempotent', async () => {
      const turn = transport.newTurn({ turnId: 'turn-1' });
      await turn.start();
      await turn.start();

      const startMsgs = channel.publishCalls.filter((m) => !Array.isArray(m) && m.name === EVENT_TURN_START);
      expect(startMsgs).toHaveLength(1);
    });

    it('end publishes turn-end event', async () => {
      const turn = transport.newTurn({ turnId: 'turn-1' });
      await turn.start();
      await turn.end('complete');

      const endMsg = channel.publishCalls.find((m) => !Array.isArray(m) && m.name === EVENT_TURN_END) as
        | Ably.Message
        | undefined;
      expect(endMsg).toBeDefined();
    });

    it('end is idempotent', async () => {
      const turn = transport.newTurn({ turnId: 'turn-1' });
      await turn.start();
      await turn.end('complete');
      await turn.end('complete');

      const endMsgs = channel.publishCalls.filter((m) => !Array.isArray(m) && m.name === EVENT_TURN_END);
      expect(endMsgs).toHaveLength(1);
    });

    it('addMessages throws if start() not called', async () => {
      const turn = transport.newTurn({ turnId: 'turn-1' });
      await expect(turn.addMessages([makeNode({ id: '1', content: 'hi' })])).rejects.toBeErrorInfoWithCode(
        ErrorCode.InvalidArgument,
      );
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
      await turn.addMessages([makeNode({ id: 'm1', content: 'a' }), makeNode({ id: 'm2', content: 'b' })]);

      // Each message gets its own encoder (distinct x-ably-msg-id)
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      expect(vi.mocked(codec.createEncoder).mock.calls).toHaveLength(2);
    });

    it('per-message headers override transport defaults', async () => {
      const turn = transport.newTurn({ turnId: 'turn-1' });
      await turn.start();
      await turn.addMessages([
        makeNode(
          { id: 'm1', content: 'hi' },
          {
            msgId: 'client-assigned-id',
            headers: { [HEADER_MSG_ID]: 'client-assigned-id', 'x-domain-foo': 'bar' },
          },
        ),
      ]);

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
      await turn.addMessages([
        makeNode(
          { id: 'm1', content: 'hi' },
          {
            parentId: 'parent-abc',
            forkOf: 'fork-xyz',
          },
        ),
      ]);

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

  describe('addEvents', () => {
    it('creates encoder with amend header and target msgId headers', async () => {
      const turn = transport.newTurn({ turnId: 'turn-1', clientId: 'user-a' });
      await turn.start();
      await turn.addEvents([{ kind: 'event', msgId: 'target-msg-1', events: [{ type: 'tool-output' }] }]);

      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      expect(codec.createEncoder).toHaveBeenCalled();
      const opts = lastEncoderOpts(codec);
      const headers = opts?.extras?.headers ?? {};
      expect(headers[HEADER_AMEND]).toBe('target-msg-1');
      expect(headers[HEADER_ROLE]).toBe('assistant');
      expect(headers[HEADER_MSG_ID]).toBe('target-msg-1');
      expect(headers[HEADER_TURN_ID]).toBe('turn-1');
    });

    it('calls writeEvent per event in each node', async () => {
      const turn = transport.newTurn({ turnId: 'turn-1' });
      await turn.start();
      await turn.addEvents([
        {
          kind: 'event',
          msgId: 'target-1',
          events: [{ type: 'ev-a' }, { type: 'ev-b' }, { type: 'ev-c' }],
        },
      ]);

      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      const calls = vi.mocked(codec.createEncoder).mock.results;
      const encoder = calls.at(-1)?.value as ReturnType<typeof createMockEncoder>;
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      expect(vi.mocked(encoder.writeEvent).mock.calls).toHaveLength(3);
    });

    it('throws if turn not started', async () => {
      const turn = transport.newTurn({ turnId: 'turn-1' });
      await expect(
        turn.addEvents([{ kind: 'event', msgId: 'target-1', events: [{ type: 'ev' }] }]),
      ).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });

    it('handles multiple EventsNodes', async () => {
      const turn = transport.newTurn({ turnId: 'turn-1', clientId: 'user-a' });
      await turn.start();
      await turn.addEvents([
        { kind: 'event', msgId: 'target-1', events: [{ type: 'ev-1' }] },
        { kind: 'event', msgId: 'target-2', events: [{ type: 'ev-2' }] },
      ]);

      // Each EventsNode gets its own encoder
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      const encoderCalls = vi.mocked(codec.createEncoder).mock.calls;
      // addMessages calls may also have created encoders, so check the last 2
      // which correspond to the addEvents call
      const addEventsCalls = encoderCalls.filter((_call, i) => {
        const opts = encoderCalls[i]?.[1];
        const headers = opts?.extras?.headers ?? {};
        return headers[HEADER_AMEND] !== undefined;
      });
      expect(addEventsCalls).toHaveLength(2);

      // Verify each targets the correct msgId
      const msgIds = addEventsCalls.map((call) => {
        const opts = call[1];
        return opts?.extras?.headers?.[HEADER_MSG_ID];
      });
      expect(msgIds).toEqual(['target-1', 'target-2']);
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

    it('forwards resolveWriteOptions per-event overrides to encoder.appendEvent', async () => {
      const turn = transport.newTurn({ turnId: 'turn-1' });
      await turn.start();

      const events: TestEvent[] = [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ];

      await turn.streamResponse(streamOf(...events), {
        resolveWriteOptions: (event) => (event.text === 'b' ? { messageId: 'override-b' } : undefined),
      });

      // eslint-disable-next-line @typescript-eslint/unbound-method -- mock accessor
      const createEncoderCalls = vi.mocked(codec.createEncoder).mock.results;
      const encoder = createEncoderCalls.at(-1)?.value as StreamEncoder<TestEvent, TestMessage>;
      // eslint-disable-next-line @typescript-eslint/unbound-method -- mock accessor
      const appendCalls = vi.mocked(encoder.appendEvent).mock.calls;

      expect(appendCalls).toHaveLength(2);
      expect(appendCalls[0]).toEqual([events[0], undefined]);
      expect(appendCalls[1]).toEqual([events[1], { messageId: 'override-b' }]);
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
    it('start() throws on publish failure without invoking onError', async () => {
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
      expect(onError).not.toHaveBeenCalled();

      failTransport.close();
    });

    it('end() throws on publish failure without invoking onError', async () => {
      const onError = vi.fn();
      const turn = transport.newTurn({ turnId: 'turn-1', onError });
      await turn.start();

      // Make the next publish fail (for turn-end)
      vi.mocked(channel.publish).mockRejectedValueOnce(new Error('publish failed'));

      await expect(turn.end('complete')).rejects.toBeErrorInfoWithCode(ErrorCode.TurnLifecycleError);
      expect(onError).not.toHaveBeenCalled();
    });

    it('addMessages() throws on publish failure without invoking onError', async () => {
      const onError = vi.fn();
      const failCodec = createMockCodec();
      const failEncoder = createMockEncoder();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      vi.mocked(failEncoder.writeMessages).mockRejectedValue(new Error('publish failed'));
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      vi.mocked(failCodec.createEncoder).mockReturnValue(failEncoder);

      const failTransport = createServerTransport({ channel, codec: failCodec });
      const turn = failTransport.newTurn({ turnId: 'turn-1', onError });
      await turn.start();

      await expect(turn.addMessages([makeNode({ id: 'm1', content: 'hello' })])).rejects.toBeErrorInfoWithCode(
        ErrorCode.TurnLifecycleError,
      );
      expect(onError).not.toHaveBeenCalled();

      failTransport.close();
    });

    it('addEvents() throws on publish failure without invoking onError', async () => {
      const onError = vi.fn();
      const failCodec = createMockCodec();
      const failEncoder = createMockEncoder();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      vi.mocked(failEncoder.writeEvent).mockRejectedValue(new Error('publish failed'));
      // eslint-disable-next-line @typescript-eslint/unbound-method -- vi mock
      vi.mocked(failCodec.createEncoder).mockReturnValue(failEncoder);

      const failTransport = createServerTransport({ channel, codec: failCodec });
      const turn = failTransport.newTurn({ turnId: 'turn-1', onError });
      await turn.start();

      await expect(
        turn.addEvents([{ kind: 'event', msgId: 'target-1', events: [{ type: 'ev' }] }]),
      ).rejects.toBeErrorInfoWithCode(ErrorCode.TurnLifecycleError);
      expect(onError).not.toHaveBeenCalled();

      failTransport.close();
    });

    it('streamResponse() calls onError when stream errors', async () => {
      const onError = vi.fn();
      const turn = transport.newTurn({ turnId: 'turn-1', onError });
      await turn.start();

      const stream = new ReadableStream<TestEvent>({
        start: (controller) => {
          controller.enqueue({ type: 'text', text: 'partial' });
          controller.error(new Error('model rate limit exceeded'));
        },
      });

      const result = await turn.streamResponse(stream);
      expect(result.reason).toBe('error');
      expect(result.error).toBeInstanceOf(Error);
      expect(onError).toHaveBeenCalledWith(expect.toBeErrorInfo({ code: ErrorCode.StreamError, statusCode: 500 }));
    });

    it('streamResponse() does not call onError when stream completes', async () => {
      const onError = vi.fn();
      const turn = transport.newTurn({ turnId: 'turn-1', onError });
      await turn.start();

      const result = await turn.streamResponse(streamOf({ type: 'text', text: 'done' }));
      expect(result.reason).toBe('complete');
      expect(result.error).toBeUndefined();
      expect(onError).not.toHaveBeenCalled();
    });

    it('onCancel handler error calls onError and does not prevent other turns', async () => {
      const onError = vi.fn();
      const turn1 = transport.newTurn({
        turnId: 'turn-1',
        clientId: 'user-a',
        // eslint-disable-next-line @typescript-eslint/require-await -- mock throws
        onCancel: async () => {
          throw new Error('handler broke');
        },
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

  describe('external signal', () => {
    it('aborts the turn when the external signal fires', async () => {
      const externalController = new AbortController();
      const turn = transport.newTurn({ turnId: 'turn-1', signal: externalController.signal });
      await turn.start();

      externalController.abort();

      expect(turn.abortSignal.aborted).toBe(true);
    });

    it('aborts the turn immediately when the external signal is already aborted', () => {
      const turn = transport.newTurn({ turnId: 'turn-1', signal: AbortSignal.abort() });

      expect(turn.abortSignal.aborted).toBe(true);
    });

    it('start() throws when the external signal was already aborted', async () => {
      const turn = transport.newTurn({ turnId: 'turn-1', signal: AbortSignal.abort() });

      await expect(turn.start()).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    });

    it('cancels an in-flight streamResponse when the external signal fires', async () => {
      const externalController = new AbortController();
      const turn = transport.newTurn({ turnId: 'turn-1', signal: externalController.signal });
      await turn.start();

      // A stream that never closes on its own — waits for cancellation.
      const stream = new ReadableStream<TestEvent>({
        start: (controller) => {
          controller.enqueue({ type: 'text', text: 'partial' });
        },
      });

      const resultPromise = turn.streamResponse(stream);
      externalController.abort();

      const result = await resultPromise;
      expect(result.reason).toBe('cancelled');
    });

    it('does not interfere with Ably cancel routing', async () => {
      const externalController = new AbortController();
      const turn = transport.newTurn({ turnId: 'turn-1', clientId: 'user-a', signal: externalController.signal });
      await turn.start();

      // Cancel via Ably channel message (not external signal)
      simulateCancel(channel, { [HEADER_CANCEL_TURN_ID]: 'turn-1' });
      await new Promise((r) => setTimeout(r, 10));

      expect(turn.abortSignal.aborted).toBe(true);
      // External signal was NOT fired
      expect(externalController.signal.aborted).toBe(false);
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

    it('unsubscribes from channel state changes', () => {
      transport.close();
      expect(channel.off).toHaveBeenCalledWith(expect.any(Function));
      expect(channel.stateListeners.size).toBe(0);
    });

    it('is idempotent', () => {
      transport.close();
      transport.close();
      // Second close() must not attempt teardown again.
      expect(channel.unsubscribe).toHaveBeenCalledTimes(1);
      expect(channel.off).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Channel continuity loss (AIT-ST12)
  // -------------------------------------------------------------------------

  describe('channel continuity', () => {
    for (const state of ['failed', 'suspended', 'detached'] as const) {
      it(`emits onError with ChannelContinuityLost when channel enters ${state}`, () => {
        const onError = vi.fn();
        const ch = createMockChannel();
        ch.state = 'initialized';
        createServerTransport({ channel: ch, codec: createMockCodec(), onError });
        simulateInitialAttach(ch);

        simulateStateChange(ch, {
          current: state,
          previous: 'attached',
        } as Ably.ChannelStateChange);

        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(
          expect.toBeErrorInfo({ code: ErrorCode.ChannelContinuityLost, statusCode: 500 }),
        );
      });
    }

    // RTL12: already ATTACHED, receives ATTACHED ProtocolMessage with resumed: false
    // → channel emits UPDATE (not a state change), previous === current === 'attached'
    it('emits onError on UPDATE with resumed: false', () => {
      const onError = vi.fn();
      const ch = createMockChannel();
      ch.state = 'initialized';
      createServerTransport({ channel: ch, codec: createMockCodec(), onError });
      simulateInitialAttach(ch);

      simulateStateChange(ch, {
        current: 'attached',
        previous: 'attached',
        resumed: false,
      } as Ably.ChannelStateChange);

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(expect.toBeErrorInfoWithCode(ErrorCode.ChannelContinuityLost));
    });

    it('emits onError when re-attaching with resumed: false', () => {
      const onError = vi.fn();
      const ch = createMockChannel();
      ch.state = 'initialized';
      createServerTransport({ channel: ch, codec: createMockCodec(), onError });
      simulateInitialAttach(ch);

      // Simulate the channel losing connection and re-attaching without resume.
      // ATTACHING is not a continuity-breaking state, so only the subsequent
      // ATTACHED/resumed:false should fire.
      simulateStateChange(ch, {
        current: 'attaching',
        previous: 'attached',
      } as Ably.ChannelStateChange);
      expect(onError).not.toHaveBeenCalled();

      simulateStateChange(ch, {
        current: 'attached',
        previous: 'attaching',
        resumed: false,
      } as Ably.ChannelStateChange);

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(expect.toBeErrorInfoWithCode(ErrorCode.ChannelContinuityLost));
    });

    it('does not emit on the initial ATTACHING → ATTACHED transition', () => {
      const onError = vi.fn();
      const ch = createMockChannel();
      ch.state = 'initialized';
      createServerTransport({ channel: ch, codec: createMockCodec(), onError });

      simulateStateChange(ch, {
        current: 'attached',
        previous: 'attaching',
        resumed: false,
      } as Ably.ChannelStateChange);

      expect(onError).not.toHaveBeenCalled();
    });

    it('does not emit on UPDATE with resumed: true', () => {
      const onError = vi.fn();
      const ch = createMockChannel();
      ch.state = 'initialized';
      createServerTransport({ channel: ch, codec: createMockCodec(), onError });
      simulateInitialAttach(ch);

      simulateStateChange(ch, {
        current: 'attached',
        previous: 'attached',
        resumed: true,
      } as Ably.ChannelStateChange);

      expect(onError).not.toHaveBeenCalled();
    });

    it('detects discontinuity on a pre-attached channel without an initial attach event', () => {
      const onError = vi.fn();
      const ch = createMockChannel();
      ch.state = 'attached';
      createServerTransport({ channel: ch, codec: createMockCodec(), onError });

      // UPDATE with resumed: false — should be treated as a real discontinuity
      // even though no initial ATTACHING → ATTACHED transition was observed.
      simulateStateChange(ch, {
        current: 'attached',
        previous: 'attached',
        resumed: false,
      } as Ably.ChannelStateChange);

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(expect.toBeErrorInfoWithCode(ErrorCode.ChannelContinuityLost));
    });

    it('does not propagate channel-wide errors to per-turn onError', async () => {
      const transportOnError = vi.fn();
      const turnOnError = vi.fn();
      const ch = createMockChannel();
      ch.state = 'initialized';
      const t = createServerTransport({ channel: ch, codec: createMockCodec(), onError: transportOnError });
      simulateInitialAttach(ch);

      const turn = t.newTurn({ turnId: 'turn-1', onError: turnOnError });
      await turn.start();

      simulateStateChange(ch, {
        current: 'failed',
        previous: 'attached',
      } as Ably.ChannelStateChange);

      expect(transportOnError).toHaveBeenCalledTimes(1);
      expect(turnOnError).not.toHaveBeenCalled();
    });

    it('does not emit after close()', () => {
      const onError = vi.fn();
      const ch = createMockChannel();
      ch.state = 'initialized';
      const t = createServerTransport({ channel: ch, codec: createMockCodec(), onError });
      simulateInitialAttach(ch);

      t.close();

      simulateStateChange(ch, {
        current: 'failed',
        previous: 'attached',
      } as Ably.ChannelStateChange);

      expect(onError).not.toHaveBeenCalled();
    });

    it('does not crash when no onError callback is supplied', () => {
      const ch = createMockChannel();
      ch.state = 'initialized';
      createServerTransport({ channel: ch, codec: createMockCodec() });
      simulateInitialAttach(ch);

      expect(() => {
        simulateStateChange(ch, {
          current: 'failed',
          previous: 'attached',
        } as Ably.ChannelStateChange);
      }).not.toThrow();
    });
  });
});
