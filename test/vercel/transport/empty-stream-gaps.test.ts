/**
 * Minimal repro: useChat features broken by the empty stream pattern.
 *
 * The Ably ChatTransport returns an empty ReadableStream from sendMessages().
 * useChat's internal Chat class reads that stream to drive status transitions,
 * callbacks, and automatic resubmission. Since no chunks arrive through the
 * stream, these features don't work as expected.
 *
 * This file demonstrates the gaps by instantiating a concrete Chat subclass
 * with the Ably ChatTransport and showing what breaks.
 */

import type * as AI from 'ai';
import { AbstractChat } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import type { ClientTransport, ConversationTree } from '../../../src/core/transport/types.js';
import { createChatTransport } from '../../../src/vercel/transport/chat-transport.js';

// ---------------------------------------------------------------------------
// Concrete Chat subclass (mirrors what useChat does internally)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-empty-function -- no-op stub
const noop = (): void => {};

class TestChat extends AbstractChat<AI.UIMessage> {
  constructor(
    options: Omit<ConstructorParameters<typeof AbstractChat<AI.UIMessage>>[0], 'state'>,
  ) {
    const messages: AI.UIMessage[] = [];
    super({
      ...options,
      state: {
        status: 'ready' as AI.ChatStatus,
        error: undefined,
        messages,
        pushMessage: (msg: AI.UIMessage) => messages.push(msg),
        popMessage: () => messages.pop(),
        replaceMessage: (i: number, msg: AI.UIMessage) => {
          messages[i] = msg;
        },
        snapshot: <T,>(x: T) => structuredClone(x),
      },
    });
  }

  /** Expose the protected setStatus for assertions. */
  override setStatus(opts: { status: AI.ChatStatus; error?: Error }): void {
    super.setStatus(opts);
  }
}

// ---------------------------------------------------------------------------
// Mock transport (same pattern as chat-transport.test.ts)
// ---------------------------------------------------------------------------

interface MockTurn {
  stream: ReadableStream<AI.UIMessageChunk>;
  turnId: string;
  cancel: ReturnType<typeof vi.fn>;
  /** Enqueue a chunk into the turn stream. */
  enqueue: (chunk: AI.UIMessageChunk) => void;
  /** Close the turn stream (simulates turn end). */
  close: () => void;
}

const createMockTurn = (): MockTurn => {
  let controller!: ReadableStreamDefaultController<AI.UIMessageChunk>;
  const stream = new ReadableStream<AI.UIMessageChunk>({
    start: (c) => {
      controller = c;
    },
  });
  return {
    stream,
    turnId: 'turn-1',
    cancel: vi.fn(),
    enqueue: (chunk: AI.UIMessageChunk) => controller.enqueue(chunk),
    close: () => controller.close(),
  };
};

const createMockTransport = () => {
  const mockTurn = createMockTurn();
  const tree = {
    flattenNodes: vi.fn(() => []),
    getSiblings: vi.fn(() => []),
    hasSiblings: vi.fn(() => false),
    getSelectedIndex: vi.fn(() => 0),
    select: vi.fn(),
    getNode: vi.fn(),
    getHeaders: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
  };

  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const send = vi.fn(() => Promise.resolve(mockTurn));

  const transport = {
    send,
    cancel: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    getTree: vi.fn(() => tree as unknown as ConversationTree<AI.UIMessage>),
    getNodes: vi.fn(() => []),
    regenerate: vi.fn(),
    edit: vi.fn(),
    waitForTurn: vi.fn(),
    on: vi.fn(() => noop),
    getActiveTurnIds: vi.fn(() => new Map()),
    getMessages: vi.fn(() => []),
    getAblyMessages: vi.fn(() => []),
    history: vi.fn(),
  } as unknown as ClientTransport<AI.UIMessageChunk, AI.UIMessage>;

  return { transport, send, mockTurn };
};

// ---------------------------------------------------------------------------
// Helper: simulate a server turn producing chunks through the mock transport
// ---------------------------------------------------------------------------

/**
 * Enqueue a realistic chunk sequence into the mock turn stream:
 * start → start-step → text → tool-input → data → finish → close
 */
const simulateServerTurn = (turn: MockTurn): void => {
  turn.enqueue({ type: 'start', messageId: 'assistant-1' });
  turn.enqueue({ type: 'start-step' });
  turn.enqueue({ type: 'text-start', id: 'text-1' });
  turn.enqueue({ type: 'text-delta', id: 'text-1', delta: 'Hello' });
  turn.enqueue({ type: 'text-end', id: 'text-1' });
  turn.enqueue({
    type: 'tool-input-start',
    toolCallId: 'tool-1',
    toolName: 'get_weather',
    dynamic: true,
  });
  turn.enqueue({ type: 'tool-input-delta', toolCallId: 'tool-1', inputTextDelta: '{"city":' });
  turn.enqueue({ type: 'tool-input-delta', toolCallId: 'tool-1', inputTextDelta: '"London"}' });
  turn.enqueue({
    type: 'tool-input-available',
    toolCallId: 'tool-1',
    toolName: 'get_weather',
    input: { city: 'London' },
    dynamic: true,
  });
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- data-* chunk requires `data` field with any shape
  turn.enqueue({ type: 'data-custom', data: { value: 42 }, id: 'data-1' } as AI.UIMessageChunk);
  turn.enqueue({ type: 'finish-step' });
  turn.enqueue({ type: 'finish', finishReason: 'tool-calls' });
  turn.close();
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('empty stream gaps — useChat features that do not work with the Ably ChatTransport', () => {
  describe('status transitions', () => {
    it('never transitions to streaming — goes directly from submitted to ready', async () => {
      const { transport, mockTurn } = createMockTransport();
      const chatTransport = createChatTransport(transport);

      const statusLog: AI.ChatStatus[] = [];
      const chat = new TestChat({
        transport: chatTransport,
        generateId: () => 'generated-id',
      });

      // Patch setStatus to record transitions
      const origSetStatus = chat.setStatus.bind(chat);
      chat.setStatus = (opts: { status: AI.ChatStatus; error?: Error }) => {
        statusLog.push(opts.status);
        origSetStatus(opts);
      };

      // Simulate: server produces a full turn with text + tool call
      const sendPromise = chat.sendMessage({ text: 'Hello' });
      // Let the stream be consumed before closing
      await new Promise((r) => setTimeout(r, 10));
      simulateServerTurn(mockTurn);
      await sendPromise;

      // Expected by the AI SDK: submitted → streaming → ready
      // Actual with empty stream: submitted → ready (streaming is skipped)
      expect(statusLog).not.toContain('streaming');
      expect(statusLog).toEqual(
        expect.arrayContaining(['submitted', 'ready']),
      );
    });
  });

  describe('onToolCall', () => {
    it('never fires even when the server streams a tool call', async () => {
      const { transport, mockTurn } = createMockTransport();
      const chatTransport = createChatTransport(transport);

      const onToolCall = vi.fn();
      const chat = new TestChat({
        transport: chatTransport,
        generateId: () => 'generated-id',
        onToolCall,
      });

      const sendPromise = chat.sendMessage({ text: 'What is the weather?' });
      await new Promise((r) => setTimeout(r, 10));
      simulateServerTurn(mockTurn); // includes tool-input-available
      await sendPromise;

      // The tool call was streamed through the Ably channel, but the
      // ChatTransport returned an empty stream → useChat never saw it.
      expect(onToolCall).not.toHaveBeenCalled();
    });
  });

  describe('onData', () => {
    it('never fires even when the server streams a data-* chunk', async () => {
      const { transport, mockTurn } = createMockTransport();
      const chatTransport = createChatTransport(transport);

      const onData = vi.fn();
      const chat = new TestChat({
        transport: chatTransport,
        generateId: () => 'generated-id',
        onData,
      });

      const sendPromise = chat.sendMessage({ text: 'Give me data' });
      await new Promise((r) => setTimeout(r, 10));
      simulateServerTurn(mockTurn); // includes data-custom chunk
      await sendPromise;

      expect(onData).not.toHaveBeenCalled();
    });
  });

  describe('onFinish', () => {
    it('fires but message is empty and finishReason is undefined', async () => {
      const { transport, mockTurn } = createMockTransport();
      const chatTransport = createChatTransport(transport);

      const onFinish = vi.fn();
      const chat = new TestChat({
        transport: chatTransport,
        generateId: () => 'generated-id',
        onFinish,
      });

      const sendPromise = chat.sendMessage({ text: 'Hello' });
      await new Promise((r) => setTimeout(r, 10));
      simulateServerTurn(mockTurn); // includes finish with finishReason: 'tool-calls'
      await sendPromise;

      expect(onFinish).toHaveBeenCalledOnce();

      // CAST: the assertion above guarantees the call exists.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/non-nullable-type-assertion-style -- extracting mock call args
      const args = onFinish.mock.calls[0]![0] as {
        message: AI.UIMessage;
        finishReason?: AI.FinishReason;
      };

      // The message accumulated from the empty stream has no parts
      expect(args.message.parts).toHaveLength(0);

      // finishReason is undefined because no finish chunk arrived through the stream.
      // The server DID send finish with reason 'tool-calls', but it went through
      // the Ably channel → transport decoder → useMessageSync, not the stream.
      expect(args.finishReason).toBeUndefined();
    });
  });

  describe('sendAutomaticallyWhen', () => {
    it('does not trigger resubmission for client-side tool calls (onToolCall never fires)', async () => {
      const { transport, mockTurn, send } = createMockTransport();
      const chatTransport = createChatTransport(transport);

      // This callback checks if the last message has an unanswered tool call.
      // In the normal AI SDK flow: onToolCall fires → dev provides result →
      // sendAutomaticallyWhen sees the result and triggers resubmission.
      // With the empty stream: onToolCall never fires → no result added →
      // the callback might still run, but the tool result was never provided.
      const sendAutomaticallyWhen = vi.fn(() => false);
      const onToolCall = vi.fn();

      const chat = new TestChat({
        transport: chatTransport,
        generateId: () => 'generated-id',
        onToolCall,
        sendAutomaticallyWhen,
      });

      const sendPromise = chat.sendMessage({ text: 'Call a tool' });
      await new Promise((r) => setTimeout(r, 10));
      simulateServerTurn(mockTurn);
      await sendPromise;

      // onToolCall never fired, so the developer never got the chance to
      // execute the tool and provide a result via addToolOutput().
      expect(onToolCall).not.toHaveBeenCalled();

      // sendAutomaticallyWhen IS called (after stream closes), but since
      // onToolCall never fired, no tool result was added to messages.
      // The automatic multi-step loop is broken.
      expect(sendAutomaticallyWhen).toHaveBeenCalled();

      // transport.send was only called once (the initial message).
      // No automatic resubmission happened.
      expect(send).toHaveBeenCalledOnce();
    });
  });
});
