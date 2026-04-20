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

const createMockTurn = (turnId = 'turn-1'): MockTurn => {
  let controller!: ReadableStreamDefaultController<AI.UIMessageChunk>;
  const stream = new ReadableStream<AI.UIMessageChunk>({
    start: (c) => {
      controller = c;
    },
  });
  return {
    stream,
    turnId,
    cancel: vi.fn(),
    enqueue: (chunk: AI.UIMessageChunk) => {
      controller.enqueue(chunk);
    },
    close: () => {
      controller.close();
    },
  };
};

const createMockTree = () =>
  ({
    flattenNodes: vi.fn(() => []),
    getSiblings: vi.fn(() => []),
    hasSiblings: vi.fn(() => false),
    getSelectedIndex: vi.fn(() => 0),
    select: vi.fn(),
    getNode: vi.fn(),
    getHeaders: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
  }) as unknown as Tree<AI.UIMessage>;

const createMockTransport = () => {
  const mockTurn = createMockTurn();
  const tree = createMockTree();

  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const send = vi.fn(() => Promise.resolve(mockTurn));

  const view = {
    flattenNodes: vi.fn(() => []),
    send,
    regenerate: vi.fn(),
    edit: vi.fn(),
    getActiveTurnIds: vi.fn(() => new Map()),
    // eslint-disable-next-line @typescript-eslint/no-empty-function, unicorn/consistent-function-scoping -- mock returns noop unsubscribe
    on: vi.fn(() => () => {}),
  };

  const transport = {
    send,
    tree,
    view,
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    cancel: vi.fn(() => Promise.resolve()),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    close: vi.fn(() => Promise.resolve()),
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

const createMultiTurnMockTransport = () => {
  const turnA = createMockTurn('turn-a');
  const turnB = createMockTurn('turn-b');
  const send = vi.fn().mockResolvedValueOnce(turnA).mockResolvedValueOnce(turnB);
  const tree = createMockTree();

  const view = {
    flattenNodes: vi.fn(() => []),
    send,
    regenerate: vi.fn(),
    edit: vi.fn(),
    getActiveTurnIds: vi.fn(() => new Map()),
    // eslint-disable-next-line @typescript-eslint/no-empty-function, unicorn/consistent-function-scoping -- mock returns noop unsubscribe
    on: vi.fn(() => () => {}),
  };

  const transport = {
    send,
    tree,
    view,
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    cancel: vi.fn(() => Promise.resolve()),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    close: vi.fn(() => Promise.resolve()),
    regenerate: vi.fn(),
    edit: vi.fn(),
    waitForTurn: vi.fn(),
    on: vi.fn(() => noop),
    getActiveTurnIds: vi.fn(() => new Map()),
    getMessages: vi.fn(() => []),
    getAblyMessages: vi.fn(() => []),
    history: vi.fn(),
  } as unknown as ClientTransport<AI.UIMessageChunk, AI.UIMessage>;

  return { transport, send, turnA, turnB };
};

/**
 * Enqueue a complete text response into a mock turn stream.
 * Sequence: start → text-start → text-delta(s) → text-end → finish → close
 * @param turn
 * @param messageId
 * @param textId
 * @param deltas
 */
/**
 * Extract the concatenated text from an assistant message's parts.
 * @param msg - The assistant message to extract text from.
 * @returns Concatenated text content.
 */
const getAssistantText = (msg: AI.UIMessage): string =>
  msg.parts
    .filter((p): p is AI.TextUIPart => p.type === 'text')
    .map((p) => p.text)
    .join('');

const enqueueTextResponse = (turn: MockTurn, messageId: string, textId: string, deltas: string[]): void => {
  turn.enqueue({ type: 'start', messageId });
  turn.enqueue({ type: 'text-start', id: textId });
  for (const delta of deltas) {
    turn.enqueue({ type: 'text-delta', id: textId, delta });
  }
  turn.enqueue({ type: 'text-end', id: textId });
  turn.enqueue({ type: 'finish', finishReason: 'stop' });
  turn.close();
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

/**
 * Enqueue a chunk sequence that leaves the tool in `approval-requested` state:
 * start -> start-step -> tool-input-start -> tool-input-delta -> tool-input-available -> tool-approval-request -> finish -> close
 * @param turn - The mock turn to enqueue chunks into.
 */
const simulateApprovalRequestTurn = (turn: MockTurn): void => {
  turn.enqueue({ type: 'start', messageId: 'assistant-1' });
  turn.enqueue({ type: 'start-step' });
  turn.enqueue({
    type: 'tool-input-start',
    toolCallId: 'tool-1',
    toolName: 'get_weather',
    dynamic: true,
  });
  turn.enqueue({ type: 'tool-input-delta', toolCallId: 'tool-1', inputTextDelta: '{"city":"London"}' });
  turn.enqueue({
    type: 'tool-input-available',
    toolCallId: 'tool-1',
    toolName: 'get_weather',
    input: { city: 'London' },
    dynamic: true,
  });
  turn.enqueue({ type: 'tool-approval-request', approvalId: 'approval-1', toolCallId: 'tool-1' });
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

    it('triggers automatic resubmission when it returns true', async () => {
      const { transport, send, turnA, turnB } = createMultiTurnMockTransport();
      const chatTransport = createChatTransport(transport);

      // Returns true only on the first call so the resubmit loop does not run indefinitely.
      const sendAutomaticallyWhen = vi.fn().mockReturnValueOnce(true);

      const chat = new TestChat({
        transport: chatTransport,
        generateId: () => 'generated-id',
        sendAutomaticallyWhen,
      });

      // sendMessage only resolves after both the original and auto-resubmit turns complete,
      // so we must feed both turns before awaiting the promise.
      const sendPromise = chat.sendMessage({ text: 'Call a tool' });
      simulateServerTurn(turnA);

      // Wait for shouldSendAutomatically() to resolve and makeRequest to fire the second send.
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledTimes(2);
      });
      expect(sendAutomaticallyWhen).toHaveBeenCalledOnce();

      // Feed the second turn so sendPromise can resolve.
      enqueueTextResponse(turnB, 'assistant-2', 'text-2', ['Auto-resubmit response.']);
      await sendPromise;
    });
  });

  // -------------------------------------------------------------------------
  // addToolOutput
  // -------------------------------------------------------------------------

  describe('addToolOutput', () => {
    it('calls sendAutomaticallyWhen after tool output is added', async () => {
      const { transport, mockTurn } = createMockTransport();
      const chatTransport = createChatTransport(transport);

      const sendAutomaticallyWhen = vi.fn(() => false);

      const chat = new TestChat({
        transport: chatTransport,
        generateId: () => 'generated-id',
        sendAutomaticallyWhen,
      });

      const sendPromise = chat.sendMessage({ text: 'Call a tool' });
      simulateServerTurn(mockTurn); // produces tool-1 in input-available state
      await sendPromise;

      sendAutomaticallyWhen.mockClear();

      await chat.addToolOutput({ tool: 'get_weather', toolCallId: 'tool-1', output: { temperature: 22 } });

      expect(sendAutomaticallyWhen).toHaveBeenCalled();
    });

    it('triggers automatic resubmission when sendAutomaticallyWhen returns true', async () => {
      const { transport, send, turnA, turnB } = createMultiTurnMockTransport();
      const chatTransport = createChatTransport(transport);

      // Returns false after the initial stream close so only addToolOutput triggers resubmission.
      const sendAutomaticallyWhen = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);

      const chat = new TestChat({
        transport: chatTransport,
        generateId: () => 'generated-id',
        sendAutomaticallyWhen,
      });

      const sendPromise = chat.sendMessage({ text: 'Call a tool' });
      simulateServerTurn(turnA);
      await sendPromise;

      expect(send).toHaveBeenCalledTimes(1);

      await chat.addToolOutput({ tool: 'get_weather', toolCallId: 'tool-1', output: { temperature: 22 } });

      // addToolOutput triggered sendAutomaticallyWhen → true → makeRequest → second send.
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledTimes(2);
      });

      enqueueTextResponse(turnB, 'assistant-2', 'text-2', ['The weather is 22°C.']);
    });

    it('does not resubmit when sendAutomaticallyWhen returns false', async () => {
      const { transport, send, mockTurn } = createMockTransport();
      const chatTransport = createChatTransport(transport);

      const sendAutomaticallyWhen = vi.fn(() => false);

      const chat = new TestChat({
        transport: chatTransport,
        generateId: () => 'generated-id',
        sendAutomaticallyWhen,
      });

      const sendPromise = chat.sendMessage({ text: 'Call a tool' });
      simulateServerTurn(mockTurn);
      await sendPromise;

      await chat.addToolOutput({ tool: 'get_weather', toolCallId: 'tool-1', output: { temperature: 22 } });

      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // addToolApprovalResponse
  // -------------------------------------------------------------------------

  describe('addToolApprovalResponse', () => {
    it('calls sendAutomaticallyWhen after approval response is added', async () => {
      const { transport, mockTurn } = createMockTransport();
      const chatTransport = createChatTransport(transport);

      const sendAutomaticallyWhen = vi.fn(() => false);

      const chat = new TestChat({
        transport: chatTransport,
        generateId: () => 'generated-id',
        sendAutomaticallyWhen,
      });

      const sendPromise = chat.sendMessage({ text: 'Approve the tool' });
      simulateApprovalRequestTurn(mockTurn);
      await sendPromise;

      sendAutomaticallyWhen.mockClear();

      await chat.addToolApprovalResponse({ id: 'approval-1', approved: true });

      expect(sendAutomaticallyWhen).toHaveBeenCalled();
    });

    it('triggers automatic resubmission when sendAutomaticallyWhen returns true', async () => {
      const { transport, send, turnA, turnB } = createMultiTurnMockTransport();
      const chatTransport = createChatTransport(transport);

      const sendAutomaticallyWhen = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);

      const chat = new TestChat({
        transport: chatTransport,
        generateId: () => 'generated-id',
        sendAutomaticallyWhen,
      });

      const sendPromise = chat.sendMessage({ text: 'Approve the tool' });
      simulateApprovalRequestTurn(turnA);
      await sendPromise;

      expect(send).toHaveBeenCalledTimes(1);

      await chat.addToolApprovalResponse({ id: 'approval-1', approved: true });

      // addToolApprovalResponse triggered sendAutomaticallyWhen → true → makeRequest → second send.
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledTimes(2);
      });

      enqueueTextResponse(turnB, 'assistant-2', 'text-2', ['Tool approved and executed.']);
    });

    it('does not resubmit when sendAutomaticallyWhen returns false', async () => {
      const { transport, send, mockTurn } = createMockTransport();
      const chatTransport = createChatTransport(transport);

      const sendAutomaticallyWhen = vi.fn(() => false);

      const chat = new TestChat({
        transport: chatTransport,
        generateId: () => 'generated-id',
        sendAutomaticallyWhen,
      });

      const sendPromise = chat.sendMessage({ text: 'Deny the tool' });
      simulateApprovalRequestTurn(mockTurn);
      await sendPromise;

      await chat.addToolApprovalResponse({ id: 'approval-1', approved: false, reason: 'Not authorized' });

      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Multiple streaming responses
  // -------------------------------------------------------------------------
  // These tests verify how useChat behaves when the transport delivers two
  // separate assistant responses. Test 1 (sequential) shows the happy path.
  // Test 2 (concurrent) shows the broken behavior caused by useChat's single
  // activeResponse slot.
  // -------------------------------------------------------------------------

  describe('multiple streaming responses', () => {
    it('sequential: two responses produce four correctly ordered messages', async () => {
      const { transport, turnA, turnB } = createMultiTurnMockTransport();
      const chatTransport = createChatTransport(transport);

      let idCounter = 0;
      const onFinish = vi.fn();
      const statusLog: AI.ChatStatus[] = [];

      const chat = new TestChat({
        transport: chatTransport,
        generateId: () => `generated-${String(idCounter++)}`,
        onFinish,
      });

      const origSetStatus = chat.setStatus.bind(chat);
      chat.setStatus = (opts: { status: AI.ChatStatus; error?: Error }) => {
        statusLog.push(opts.status);
        origSetStatus(opts);
      };

      // --- Response A ---
      const p1 = chat.sendMessage({ text: 'First' });
      await new Promise((r) => setTimeout(r, 10));
      enqueueTextResponse(turnA, 'assistant-a', 'text-a', ['Response ', 'A.']);
      await p1;

      // --- Response B ---
      const p2 = chat.sendMessage({ text: 'Second' });
      await new Promise((r) => setTimeout(r, 10));
      enqueueTextResponse(turnB, 'assistant-b', 'text-b', ['Response ', 'B.']);
      await p2;

      // Four messages in the correct order
      const msgs = chat.messages;
      expect(msgs).toHaveLength(4);
      expect(msgs[0]?.role).toBe('user');
      expect(msgs[1]?.role).toBe('assistant');
      expect(msgs[2]?.role).toBe('user');
      expect(msgs[3]?.role).toBe('assistant');

      expect(msgs[1]?.id).toBe('assistant-a');
      expect(getAssistantText(msgs[1] ?? ({ id: '', role: 'assistant', parts: [] } as AI.UIMessage))).toBe(
        'Response A.',
      );
      expect(msgs[3]?.id).toBe('assistant-b');
      expect(getAssistantText(msgs[3] ?? ({ id: '', role: 'assistant', parts: [] } as AI.UIMessage))).toBe(
        'Response B.',
      );

      // onFinish fires twice with the correct messages
      expect(onFinish).toHaveBeenCalledTimes(2);

      // Status transitions: submitted → streaming (repeated per chunk) → ready (twice)
      // Deduplicate consecutive duplicates to check the logical transitions.
      const deduped = statusLog.filter((s, i) => i === 0 || s !== statusLog[i - 1]);
      expect(deduped).toEqual(['submitted', 'streaming', 'ready', 'submitted', 'streaming', 'ready']);
    });

    it('concurrent: serialized sendMessages prevents dual streams but cannot fix activeResponse overwrite', async () => {
      const { transport, turnA, turnB } = createMultiTurnMockTransport();
      const chatTransport = createChatTransport(transport);

      let idCounter = 0;
      const onFinish = vi.fn();
      const consoleErrors: unknown[] = [];
      const origConsoleError = console.error;
      console.error = (...args: unknown[]) => consoleErrors.push(...args);

      const chat = new TestChat({
        transport: chatTransport,
        generateId: () => `generated-${String(idCounter++)}`,
        onFinish,
      });

      try {
        // Fire both sendMessage calls without awaiting.
        //
        // AbstractChat.sendMessage pushes the user message AND creates
        // activeResponse BEFORE calling sendMessages. The overwrite at
        // chat.ts:668 (this.activeResponse = activeResponse) happens
        // before the transport has any opportunity to intervene. This is
        // a useChat limitation that can only be fixed by preventing
        // concurrent sendMessage calls at the UI level (disabling the
        // send button while status !== 'ready').
        const p1 = chat.sendMessage({ text: 'First' });
        const p2 = chat.sendMessage({ text: 'Second' });

        // Let the first transport.send resolve
        await new Promise((r) => setTimeout(r, 10));
        enqueueTextResponse(turnA, 'assistant-a', 'text-a', ['Response ', 'A.']);

        // Let the queue advance
        await new Promise((r) => setTimeout(r, 10));
        enqueueTextResponse(turnB, 'assistant-b', 'text-b', ['Response ', 'B.']);

        await Promise.allSettled([p1, p2]);

        // All four messages present, ordering still wrong.
        const msgs = chat.messages;
        expect(msgs).toHaveLength(4);
        expect(msgs.map((m) => m.role)).toEqual(['user', 'user', 'assistant', 'assistant']);

        // Content correct for both responses.
        expect(getAssistantText(msgs[2] ?? ({ id: '', role: 'assistant', parts: [] } as AI.UIMessage))).toBe(
          'Response A.',
        );
        expect(getAssistantText(msgs[3] ?? ({ id: '', role: 'assistant', parts: [] } as AI.UIMessage))).toBe(
          'Response B.',
        );

        // onFinish still fires once — the activeResponse overwrite happens
        // before sendMessages, so our queue can't prevent it.
        expect(onFinish).toHaveBeenCalledTimes(1);
        expect(consoleErrors).toHaveLength(1);
      } finally {
        console.error = origConsoleError;
      }
    });
  });
});
