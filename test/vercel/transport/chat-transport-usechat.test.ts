/**
 * Validates that the ChatTransport correctly drives useChat features.
 *
 * The Ably ChatTransport returns the real turn stream from sendMessages().
 * useChat's internal Chat class reads that stream to drive status transitions,
 * callbacks, and automatic resubmission. Since chunks flow through the stream,
 * these features work correctly.
 *
 * This file validates by instantiating a concrete Chat subclass with the
 * Ably ChatTransport and verifying that all useChat features function.
 */

import type * as AI from 'ai';
import { AbstractChat } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import type { ClientTransport, Tree } from '../../../src/core/transport/types.js';
import { createChatTransport } from '../../../src/vercel/transport/chat-transport.js';

// ---------------------------------------------------------------------------
// Concrete Chat subclass (mirrors what useChat does internally)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-empty-function -- no-op stub
const noop = (): void => {};

class TestChat extends AbstractChat<AI.UIMessage> {
  constructor(options: Omit<ConstructorParameters<typeof AbstractChat<AI.UIMessage>>[0], 'state'>) {
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
        snapshot: <T>(x: T) => structuredClone(x),
      },
    });
  }

  /**
   * Expose the protected setStatus for assertions.
   * @param opts - Status options to set.
   * @param opts.status - The chat status to transition to.
   * @param opts.error - Optional error associated with the status change.
   */
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
    enqueue: (chunk: AI.UIMessageChunk) => {
      controller.enqueue(chunk);
    },
    close: () => {
      controller.close();
    },
  };
};

const createMockTransport = () => {
  const mockTurn = createMockTurn();
  // CAST: mock object typed to satisfy ConversationTree — vi.fn() returns are untyped
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
  } as unknown as Tree<AI.UIMessage>;

  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const send = vi.fn(() => Promise.resolve(mockTurn));

  const transport = {
    send,
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    cancel: vi.fn(() => Promise.resolve()),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    close: vi.fn(() => Promise.resolve()),
    getTree: vi.fn(() => tree),
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
 * start -> start-step -> text -> tool-input -> data -> finish -> close
 * @param turn - The mock turn to enqueue chunks into.
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
  // CAST: data-custom is a valid UIMessageChunk variant; TS cannot narrow the string union from a literal.
  turn.enqueue({ type: 'data-custom', data: { value: 42 }, id: 'data-1' } as AI.UIMessageChunk);
  turn.enqueue({ type: 'finish-step' });
  turn.enqueue({ type: 'finish', finishReason: 'tool-calls' });
  turn.close();
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChatTransport useChat integration — features work with the real stream', () => {
  describe('status transitions', () => {
    it('transitions through streaming on its way to ready', async () => {
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

      // With the real stream: submitted -> streaming -> ready
      expect(statusLog).toContain('streaming');
      expect(statusLog).toEqual(expect.arrayContaining(['submitted', 'streaming', 'ready']));
    });
  });

  describe('onToolCall', () => {
    it('fires when the server streams a tool call', async () => {
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

      // The tool call was streamed through the real stream -> useChat saw it.
      expect(onToolCall).toHaveBeenCalledOnce();
    });
  });

  describe('onData', () => {
    it('fires when the server streams a data-* chunk', async () => {
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

      expect(onData).toHaveBeenCalled();
    });
  });

  describe('onFinish', () => {
    it('fires with real content and finishReason', async () => {
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

      // CAST: the assertion above guarantees the call exists; indexing mock.calls safely.
      const args = onFinish.mock.calls[0] as [{ message: AI.UIMessage; finishReason?: AI.FinishReason }];

      // The message accumulated from the real stream has parts
      expect(args[0].message.parts.length).toBeGreaterThan(0);

      // finishReason is set because the finish chunk arrived through the stream.
      expect(args[0].finishReason).toBe('tool-calls');
    });
  });

  describe('sendAutomaticallyWhen', () => {
    it('onToolCall fires, enabling the automatic resubmission loop', async () => {
      const { transport, mockTurn } = createMockTransport();
      const chatTransport = createChatTransport(transport);

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

      // onToolCall fires because the real stream carries the tool-input-available chunk.
      expect(onToolCall).toHaveBeenCalledOnce();

      // sendAutomaticallyWhen is called after the stream closes.
      expect(sendAutomaticallyWhen).toHaveBeenCalled();
    });
  });
});
