/**
 * Validates that the ChatTransport correctly drives useChat features.
 *
 * The Ably ChatTransport returns the real run stream from sendMessages().
 * useChat's internal Chat class reads that stream to drive status transitions,
 * callbacks, and automatic resubmission. Since chunks flow through the stream,
 * these features work correctly.
 *
 * This file validates by instantiating a concrete Chat subclass with the
 * Ably ChatTransport and verifying that all useChat features function.
 */

import type * as AI from 'ai';
import { AbstractChat } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Invocation } from '../../../src/core/transport/invocation.js';
import type { ClientSession, RunLifecycleEvent, Tree } from '../../../src/core/transport/types.js';
import type { VercelInput, VercelOutput, VercelProjection } from '../../../src/vercel/codec/index.js';
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
        status: 'ready',
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
// Mock session (same pattern as chat-transport.test.ts)
// ---------------------------------------------------------------------------

interface MockRun {
  runId: string;
  cancel: ReturnType<typeof vi.fn>;
  /** Build the run's invocation pointer (the transport POSTs this to wake the agent). */
  toInvocation: () => Invocation;
  /** Drive a chunk through the session's output feed for this run. */
  enqueue: (chunk: AI.UIMessageChunk) => void;
  /** Fire a run-end through the tree (simulates run end). */
  close: () => void;
}

/**
 * Registries for a mock session's output feed and tree 'run' subscription.
 * The chat-transport narrows the session to {@link ClientSessionOutputFeed}
 * and subscribes to the tree's 'run' event; the mock runs drive these so
 * `enqueue` / `close` feed the chat-transport's own StreamRouter.
 */
interface MockFeed {
  outputHandlers: Set<(event: { runId: string; output: VercelOutput }) => void>;
  runHandlers: Set<(event: RunLifecycleEvent) => void>;
}

const createMockFeed = (): MockFeed => ({
  outputHandlers: new Set(),
  runHandlers: new Set(),
});

const createMockRun = (feed: MockFeed, runId = 'run-1'): MockRun => {
  // Buffer outputs and flush on a macrotask. In the real flow, outputs only
  // arrive after `ai-run-start` resolves the send (so the chat-transport has
  // already created the router stream). Tests drive chunks synchronously
  // right after calling sendMessage — before the `await sendEvent` microtask
  // resolves and the stream exists. Deferring the flush to a macrotask lets
  // the stream be created first, mirroring real ordering.
  // A serial queue of deferred deliveries (outputs and run-end), each fired on
  // its own macrotask so they land after the send's microtask resolves and the
  // router stream exists. Items run in enqueue order.
  type Delivery = { kind: 'output'; chunk: AI.UIMessageChunk } | { kind: 'end' };
  const pending: Delivery[] = [];
  let scheduled = false;
  const drain = (): void => {
    scheduled = false;
    const item = pending.shift();
    if (!item) return;
    if (item.kind === 'output') {
      for (const handler of feed.outputHandlers) handler({ runId, output: item.chunk });
    } else {
      for (const handler of feed.runHandlers) {
        handler({ type: 'ai-run-end', runId, clientId: '', reason: 'complete' });
      }
    }
    schedule();
  };
  const schedule = (): void => {
    if (scheduled || pending.length === 0) return;
    scheduled = true;
    setTimeout(drain, 0);
  };
  return {
    runId,
    cancel: vi.fn(),
    toInvocation: () =>
      Invocation.fromJSON({ runId, invocationId: `${runId}-inv`, inputEventId: '', sessionName: 'chat-1' }),
    enqueue: (chunk: AI.UIMessageChunk) => {
      pending.push({ kind: 'output', chunk });
      schedule();
    },
    close: () => {
      pending.push({ kind: 'end' });
      schedule();
    },
  };
};

const createMockTree = (feed: MockFeed) =>
  ({
    flattenNodes: vi.fn(() => []),
    getSiblingRuns: vi.fn(() => []),
    hasSiblingRuns: vi.fn(() => false),
    getSelectedIndex: vi.fn(() => 0),
    select: vi.fn(),
    getRunNode: vi.fn(),
    getRunByCodecMessageId: vi.fn(),
    on: vi.fn((event: string, handler: (event: RunLifecycleEvent) => void) => {
      if (event === 'run') {
        feed.runHandlers.add(handler);
        return () => feed.runHandlers.delete(handler);
      }
      // eslint-disable-next-line @typescript-eslint/no-empty-function, unicorn/consistent-function-scoping -- noop unsubscribe for unused events
      return () => {};
    }),
  }) as unknown as Tree<VercelProjection>;

/**
 * Build a mock session that exposes the {@link ClientSessionOutputFeed}
 * surface backed by `feed`, so chunks driven via mock runs reach the
 * chat-transport's router.
 * @param feed - The shared output/run registries.
 * @param view - The mock view (carries the send mock).
 * @param tree - The mock tree (carries the 'run' subscription).
 * @returns A session typed as the public ClientSession.
 */
const createMockSessionObject = (
  feed: MockFeed,
  view: unknown,
  tree: Tree<VercelProjection>,
): ClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage> =>
  ({
    tree,
    view,
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    cancel: vi.fn(() => Promise.resolve()),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    close: vi.fn(() => Promise.resolve()),
    regenerate: vi.fn(),
    edit: vi.fn(),
    on: vi.fn(() => noop),
    getMessages: vi.fn(() => []),
    getAblyMessages: vi.fn(() => []),
    history: vi.fn(),
    onOutput: vi.fn((handler: (event: { runId: string; output: VercelOutput }) => void) => {
      feed.outputHandlers.add(handler);
      return () => feed.outputHandlers.delete(handler);
    }),
    // eslint-disable-next-line @typescript-eslint/no-empty-function, unicorn/consistent-function-scoping -- run errors are not exercised here
    onRunError: vi.fn(() => () => {}),
  }) as unknown as ClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>;

const createMockSession = () => {
  const feed = createMockFeed();
  const tree = createMockTree(feed);
  const mockRun = createMockRun(feed);

  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const send = vi.fn(() => Promise.resolve(mockRun));

  const view = {
    flattenNodes: vi.fn(() => []),
    getMessages: vi.fn(() => []),
    getRunByCodecMessageId: vi.fn(),
    sendInput: send,
    regenerate: vi.fn(),
    edit: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-empty-function, unicorn/consistent-function-scoping -- mock returns noop unsubscribe
    on: vi.fn(() => () => {}),
  };

  const session = createMockSessionObject(feed, view, tree);

  return { session, send, mockRun };
};

const createMultiRunMockSession = () => {
  const feed = createMockFeed();
  const tree = createMockTree(feed);
  const runA = createMockRun(feed, 'run-a');
  const runB = createMockRun(feed, 'run-b');
  const send = vi.fn().mockResolvedValueOnce(runA).mockResolvedValueOnce(runB);

  const view = {
    flattenNodes: vi.fn(() => []),
    getMessages: vi.fn(() => []),
    getRunByCodecMessageId: vi.fn(),
    sendInput: send,
    regenerate: vi.fn(),
    edit: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-empty-function, unicorn/consistent-function-scoping -- mock returns noop unsubscribe
    on: vi.fn(() => () => {}),
  };

  const session = createMockSessionObject(feed, view, tree);

  return { session, send, runA, runB };
};

/**
 * Enqueue a complete text response into a mock run stream.
 * Sequence: start → text-start → text-delta(s) → text-end → finish → close
 * @param run
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

const enqueueTextResponse = (run: MockRun, messageId: string, textId: string, deltas: string[]): void => {
  run.enqueue({ type: 'start', messageId });
  run.enqueue({ type: 'text-start', id: textId });
  for (const delta of deltas) {
    run.enqueue({ type: 'text-delta', id: textId, delta });
  }
  run.enqueue({ type: 'text-end', id: textId });
  run.enqueue({ type: 'finish', finishReason: 'stop' });
  run.close();
};

// ---------------------------------------------------------------------------
// Helper: simulate a server run producing chunks through the mock session
// ---------------------------------------------------------------------------

/**
 * Enqueue a realistic chunk sequence into the mock run stream:
 * start -> start-step -> text -> tool-input -> data -> finish -> close
 * @param run - The mock run to enqueue chunks into.
 */
const simulateServerRun = (run: MockRun): void => {
  run.enqueue({ type: 'start', messageId: 'assistant-1' });
  run.enqueue({ type: 'start-step' });
  run.enqueue({ type: 'text-start', id: 'text-1' });
  run.enqueue({ type: 'text-delta', id: 'text-1', delta: 'Hello' });
  run.enqueue({ type: 'text-end', id: 'text-1' });
  run.enqueue({
    type: 'tool-input-start',
    toolCallId: 'tool-1',
    toolName: 'get_weather',
    dynamic: true,
  });
  run.enqueue({ type: 'tool-input-delta', toolCallId: 'tool-1', inputTextDelta: '{"city":' });
  run.enqueue({ type: 'tool-input-delta', toolCallId: 'tool-1', inputTextDelta: '"London"}' });
  run.enqueue({
    type: 'tool-input-available',
    toolCallId: 'tool-1',
    toolName: 'get_weather',
    input: { city: 'London' },
    dynamic: true,
  });
  run.enqueue({ type: 'data-custom', data: { value: 42 }, id: 'data-1' });
  run.enqueue({ type: 'finish-step' });
  run.enqueue({ type: 'finish', finishReason: 'tool-calls' });
  run.close();
};

/**
 * Enqueue a chunk sequence that leaves the tool in `approval-requested` state:
 * start -> start-step -> tool-input-start -> tool-input-delta -> tool-input-available -> tool-approval-request -> finish -> close
 * @param run - The mock run to enqueue chunks into.
 */
const simulateApprovalRequestRun = (run: MockRun): void => {
  run.enqueue({ type: 'start', messageId: 'assistant-1' });
  run.enqueue({ type: 'start-step' });
  run.enqueue({
    type: 'tool-input-start',
    toolCallId: 'tool-1',
    toolName: 'get_weather',
    dynamic: true,
  });
  run.enqueue({ type: 'tool-input-delta', toolCallId: 'tool-1', inputTextDelta: '{"city":"London"}' });
  run.enqueue({
    type: 'tool-input-available',
    toolCallId: 'tool-1',
    toolName: 'get_weather',
    input: { city: 'London' },
    dynamic: true,
  });
  run.enqueue({ type: 'tool-approval-request', approvalId: 'approval-1', toolCallId: 'tool-1' });
  run.enqueue({ type: 'finish', finishReason: 'tool-calls' });
  run.close();
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChatTransport useChat integration — features work with the real stream', () => {
  // The transport POSTs the invocation to wake the agent (defaulting to
  // globalThis.fetch). Stub it so the POST succeeds (200) and the run stream
  // is left to flow — otherwise a failed POST would error the useChat stream.
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    const fetchMock = vi.fn(() => Promise.resolve(new Response(undefined, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('status transitions', () => {
    it('transitions through streaming on its way to ready', async () => {
      const { session, mockRun } = createMockSession();
      const chatTransport = createChatTransport(session);

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

      // Simulate: server produces a full run with text + tool call
      const sendPromise = chat.sendMessage({ text: 'Hello' });
      // Let the stream be consumed before closing
      await new Promise((r) => setTimeout(r, 10));
      simulateServerRun(mockRun);
      await sendPromise;

      // With the real stream: submitted -> streaming -> ready
      expect(statusLog).toContain('streaming');
      expect(statusLog).toEqual(expect.arrayContaining(['submitted', 'streaming', 'ready']));
    });
  });

  describe('onToolCall', () => {
    it('fires when the server streams a tool call', async () => {
      const { session, mockRun } = createMockSession();
      const chatTransport = createChatTransport(session);

      const onToolCall = vi.fn();
      const chat = new TestChat({
        transport: chatTransport,
        generateId: () => 'generated-id',
        onToolCall,
      });

      const sendPromise = chat.sendMessage({ text: 'What is the weather?' });
      await new Promise((r) => setTimeout(r, 10));
      simulateServerRun(mockRun); // includes tool-input-available
      await sendPromise;

      // The tool call was streamed through the real stream -> useChat saw it.
      expect(onToolCall).toHaveBeenCalledOnce();
    });
  });

  describe('onData', () => {
    it('fires when the server streams a data-* chunk', async () => {
      const { session, mockRun } = createMockSession();
      const chatTransport = createChatTransport(session);

      const onData = vi.fn();
      const chat = new TestChat({
        transport: chatTransport,
        generateId: () => 'generated-id',
        onData,
      });

      const sendPromise = chat.sendMessage({ text: 'Give me data' });
      await new Promise((r) => setTimeout(r, 10));
      simulateServerRun(mockRun); // includes data-custom chunk
      await sendPromise;

      expect(onData).toHaveBeenCalled();
    });
  });

  describe('onFinish', () => {
    it('fires with real content and finishReason', async () => {
      const { session, mockRun } = createMockSession();
      const chatTransport = createChatTransport(session);

      const onFinish = vi.fn();
      const chat = new TestChat({
        transport: chatTransport,
        generateId: () => 'generated-id',
        onFinish,
      });

      const sendPromise = chat.sendMessage({ text: 'Hello' });
      await new Promise((r) => setTimeout(r, 10));
      simulateServerRun(mockRun); // includes finish with finishReason: 'tool-calls'
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
      const { session, mockRun } = createMockSession();
      const chatTransport = createChatTransport(session);

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
      simulateServerRun(mockRun);
      await sendPromise;

      // onToolCall fires because the real stream carries the tool-input-available chunk.
      expect(onToolCall).toHaveBeenCalledOnce();

      // sendAutomaticallyWhen is called after the stream closes.
      expect(sendAutomaticallyWhen).toHaveBeenCalled();
    });

    it('triggers automatic resubmission when it returns true', async () => {
      const { session, send, runA, runB } = createMultiRunMockSession();
      const chatTransport = createChatTransport(session);

      // Returns true only on the first call so the resubmit loop does not run indefinitely.
      const sendAutomaticallyWhen = vi.fn().mockReturnValueOnce(true);

      const chat = new TestChat({
        transport: chatTransport,
        generateId: () => 'generated-id',
        sendAutomaticallyWhen,
      });

      // sendMessage only resolves after both the original and auto-resubmit runs complete,
      // so we must feed both runs before awaiting the promise.
      const sendPromise = chat.sendMessage({ text: 'Call a tool' });
      simulateServerRun(runA);

      // Wait for shouldSendAutomatically() to resolve and makeRequest to fire the second send.
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledTimes(2);
      });
      expect(sendAutomaticallyWhen).toHaveBeenCalledOnce();

      // Feed the second run so sendPromise can resolve.
      enqueueTextResponse(runB, 'assistant-2', 'text-2', ['Auto-resubmit response.']);
      await sendPromise;
    });
  });

  // -------------------------------------------------------------------------
  // addToolOutput
  // -------------------------------------------------------------------------

  describe('addToolOutput', () => {
    it('calls sendAutomaticallyWhen after tool output is added', async () => {
      const { session, mockRun } = createMockSession();
      const chatTransport = createChatTransport(session);

      const sendAutomaticallyWhen = vi.fn(() => false);

      const chat = new TestChat({
        transport: chatTransport,
        generateId: () => 'generated-id',
        sendAutomaticallyWhen,
      });

      const sendPromise = chat.sendMessage({ text: 'Call a tool' });
      simulateServerRun(mockRun); // produces tool-1 in input-available state
      await sendPromise;

      sendAutomaticallyWhen.mockClear();

      await chat.addToolOutput({ tool: 'get_weather', toolCallId: 'tool-1', output: { temperature: 22 } });

      expect(sendAutomaticallyWhen).toHaveBeenCalled();
    });

    it('triggers automatic resubmission when sendAutomaticallyWhen returns true', async () => {
      const { session, send, runA, runB } = createMultiRunMockSession();
      const chatTransport = createChatTransport(session);

      // Returns false after the initial stream close so only addToolOutput triggers resubmission.
      const sendAutomaticallyWhen = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);

      const chat = new TestChat({
        transport: chatTransport,
        generateId: () => 'generated-id',
        sendAutomaticallyWhen,
      });

      const sendPromise = chat.sendMessage({ text: 'Call a tool' });
      simulateServerRun(runA);
      await sendPromise;

      expect(send).toHaveBeenCalledTimes(1);

      await chat.addToolOutput({ tool: 'get_weather', toolCallId: 'tool-1', output: { temperature: 22 } });

      // addToolOutput triggered sendAutomaticallyWhen → true → makeRequest → second send.
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledTimes(2);
      });

      enqueueTextResponse(runB, 'assistant-2', 'text-2', ['The weather is 22°C.']);
    });

    it('does not resubmit when sendAutomaticallyWhen returns false', async () => {
      const { session, send, mockRun } = createMockSession();
      const chatTransport = createChatTransport(session);

      const sendAutomaticallyWhen = vi.fn(() => false);

      const chat = new TestChat({
        transport: chatTransport,
        generateId: () => 'generated-id',
        sendAutomaticallyWhen,
      });

      const sendPromise = chat.sendMessage({ text: 'Call a tool' });
      simulateServerRun(mockRun);
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
      const { session, mockRun } = createMockSession();
      const chatTransport = createChatTransport(session);

      const sendAutomaticallyWhen = vi.fn(() => false);

      const chat = new TestChat({
        transport: chatTransport,
        generateId: () => 'generated-id',
        sendAutomaticallyWhen,
      });

      const sendPromise = chat.sendMessage({ text: 'Approve the tool' });
      simulateApprovalRequestRun(mockRun);
      await sendPromise;

      sendAutomaticallyWhen.mockClear();

      await chat.addToolApprovalResponse({ id: 'approval-1', approved: true });

      expect(sendAutomaticallyWhen).toHaveBeenCalled();
    });

    it('triggers automatic resubmission when sendAutomaticallyWhen returns true', async () => {
      const { session, send, runA, runB } = createMultiRunMockSession();
      const chatTransport = createChatTransport(session);

      const sendAutomaticallyWhen = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);

      const chat = new TestChat({
        transport: chatTransport,
        generateId: () => 'generated-id',
        sendAutomaticallyWhen,
      });

      const sendPromise = chat.sendMessage({ text: 'Approve the tool' });
      simulateApprovalRequestRun(runA);
      await sendPromise;

      expect(send).toHaveBeenCalledTimes(1);

      await chat.addToolApprovalResponse({ id: 'approval-1', approved: true });

      // addToolApprovalResponse triggered sendAutomaticallyWhen → true → makeRequest → second send.
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledTimes(2);
      });

      enqueueTextResponse(runB, 'assistant-2', 'text-2', ['Tool approved and executed.']);
    });

    it('does not resubmit when sendAutomaticallyWhen returns false', async () => {
      const { session, send, mockRun } = createMockSession();
      const chatTransport = createChatTransport(session);

      const sendAutomaticallyWhen = vi.fn(() => false);

      const chat = new TestChat({
        transport: chatTransport,
        generateId: () => 'generated-id',
        sendAutomaticallyWhen,
      });

      const sendPromise = chat.sendMessage({ text: 'Deny the tool' });
      simulateApprovalRequestRun(mockRun);
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
      const { session, runA, runB } = createMultiRunMockSession();
      const chatTransport = createChatTransport(session);

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
      enqueueTextResponse(runA, 'assistant-a', 'text-a', ['Response ', 'A.']);
      await p1;

      // --- Response B ---
      const p2 = chat.sendMessage({ text: 'Second' });
      await new Promise((r) => setTimeout(r, 10));
      enqueueTextResponse(runB, 'assistant-b', 'text-b', ['Response ', 'B.']);
      await p2;

      // Four messages in the correct order
      const msgs = chat.messages;
      expect(msgs).toHaveLength(4);
      expect(msgs[0]?.role).toBe('user');
      expect(msgs[1]?.role).toBe('assistant');
      expect(msgs[2]?.role).toBe('user');
      expect(msgs[3]?.role).toBe('assistant');

      expect(msgs[1]?.id).toBe('assistant-a');
      expect(getAssistantText(msgs[1] ?? { id: '', role: 'assistant', parts: [] })).toBe('Response A.');
      expect(msgs[3]?.id).toBe('assistant-b');
      expect(getAssistantText(msgs[3] ?? { id: '', role: 'assistant', parts: [] })).toBe('Response B.');

      // onFinish fires twice with the correct messages
      expect(onFinish).toHaveBeenCalledTimes(2);

      // Status transitions: submitted → streaming (repeated per chunk) → ready (twice)
      // Deduplicate consecutive duplicates to check the logical transitions.
      const deduped = statusLog.filter((s, i) => i === 0 || s !== statusLog[i - 1]);
      expect(deduped).toEqual(['submitted', 'streaming', 'ready', 'submitted', 'streaming', 'ready']);
    });

    it('concurrent: serialized sendMessages prevents dual streams but cannot fix activeResponse overwrite', async () => {
      const { session, runA, runB } = createMultiRunMockSession();
      const chatTransport = createChatTransport(session);

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

        // Let the first session.send resolve
        await new Promise((r) => setTimeout(r, 10));
        enqueueTextResponse(runA, 'assistant-a', 'text-a', ['Response ', 'A.']);

        // Let the queue advance
        await new Promise((r) => setTimeout(r, 10));
        enqueueTextResponse(runB, 'assistant-b', 'text-b', ['Response ', 'B.']);

        await Promise.allSettled([p1, p2]);

        // All four messages present, ordering still wrong.
        const msgs = chat.messages;
        expect(msgs).toHaveLength(4);
        expect(msgs.map((m) => m.role)).toEqual(['user', 'user', 'assistant', 'assistant']);

        // Content correct for both responses.
        expect(getAssistantText(msgs[2] ?? { id: '', role: 'assistant', parts: [] })).toBe('Response A.');
        expect(getAssistantText(msgs[3] ?? { id: '', role: 'assistant', parts: [] })).toBe('Response B.');

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
