/**
 * Validates that the ChatTransport correctly drives useChat features.
 *
 * The Ably ChatTransport returns a stream of the run's output chunks from
 * sendMessages(), built from the session Tree's `output` / `run` events.
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
import type { ClientSession, Tree } from '../../../src/core/transport/types.js';
import type { VercelInput, VercelOutput, VercelProjection } from '../../../src/vercel/codec/index.js';
import { createChatTransport } from '../../../src/vercel/transport/chat-transport.js';

// ---------------------------------------------------------------------------
// Concrete Chat subclass (mirrors what useChat does internally)
// ---------------------------------------------------------------------------

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

/**
 * Minimal event registry mirroring the Tree/session `on(event, handler)`
 * contract: returns an unsubscribe, dispatches synchronously. Lets the mock
 * runs drive the transport's stream via the same `output` / `run` / `error`
 * events the production stream subscribes to.
 */
interface MockEmitter {
  on: (event: string, handler: (arg: never) => void) => () => void;
  emit: (event: string, arg?: unknown) => void;
}

const makeEmitter = (): MockEmitter => {
  const handlers = new Map<string, Set<(arg: never) => void>>();
  const log: { event: string; arg: unknown }[] = [];
  return {
    on: (event, handler) => {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler);
      // Replay buffered events of this type to the newly-subscribed handler,
      // mirroring how a ReadableStream retains chunks enqueued before a reader
      // attaches (the source the production transport used to read). This lets
      // a test emit a run's chunks without racing the transport's async
      // subscription, and lets a continuation's fresh stream pick up only its
      // own (later, live) events — prior runs' buffered events are filtered out
      // by runId inside the stream builder.
      // CAST: the registry is untyped; the production `on` overloads guarantee
      // each handler receives the payload matching its event.
      for (const entry of log) if (entry.event === event) (handler as (a: unknown) => void)(entry.arg);
      return () => {
        set.delete(handler);
      };
    },
    // CAST: as above — untyped registry, payloads matched by event name.
    emit: (event, arg) => {
      log.push({ event, arg });
      for (const handler of handlers.get(event) ?? []) (handler as (a: unknown) => void)(arg);
    },
  };
};

interface MockRun {
  stream: ReadableStream<AI.UIMessageChunk>;
  /** The triggering input's codec-message-id — the synchronous stream routing key. */
  inputCodecMessageId: string;
  runId: Promise<string>;
  inputEventId: string;
  cancel: ReturnType<typeof vi.fn>;
  /** The optimistic input codec-message-ids the stream may key on (empty in these mocks). */
  optimisticCodecMessageIds: string[];
  /** Build the run's invocation pointer (the transport POSTs this to wake the agent). */
  toInvocation: () => Invocation;
  /** Emit a chunk as a Tree `output` event for this run (drives the consumer stream). */
  enqueue: (chunk: AI.UIMessageChunk) => void;
  /** Emit a terminal `run-end` for this run (closes the consumer stream). */
  close: () => void;
}

const createMockRun = (runId: string, treeEmit: MockEmitter['emit']): MockRun => {
  // The consumer stream routes purely by the triggering input's codec-message-id
  // (the agent mints the run-id separately); key it per run.
  const inputCodecMessageId = `${runId}-input`;
  return {
    // Inert placeholder — the transport builds its own stream from Tree events.
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- inert placeholder stream
    stream: new ReadableStream<AI.UIMessageChunk>({ start: () => {} }),
    inputCodecMessageId,
    runId: Promise.resolve(runId),
    inputEventId: '',
    cancel: vi.fn(),
    optimisticCodecMessageIds: [],
    toInvocation: () => Invocation.fromJSON({ inputEventId: '', sessionName: 'chat-1' }),
    enqueue: (chunk: AI.UIMessageChunk) => {
      treeEmit('output', { runId, inputCodecMessageId, codecMessageId: 'm-1', serial: 's-1', events: [chunk] });
    },
    close: () => {
      treeEmit('run', {
        type: 'end',
        runId,
        clientId: '',
        invocationId: `${runId}-inv`,
        serial: 's-1',
        reason: 'complete',
      });
    },
  };
};

const createMockTree = (treeEmitter: MockEmitter) =>
  ({
    flattenNodes: vi.fn(() => []),
    getSiblingNodes: vi.fn(() => []),
    getSelectedIndex: vi.fn(() => 0),
    select: vi.fn(),
    getRunNode: vi.fn(),
    getNodeByCodecMessageId: vi.fn(),
    on: vi.fn(treeEmitter.on),
  }) as unknown as Tree<VercelOutput, VercelProjection>;

const createMockSession = () => {
  const treeEmitter = makeEmitter();
  const sessionEmitter = makeEmitter();
  const mockRun = createMockRun('run-1', treeEmitter.emit);
  const tree = createMockTree(treeEmitter);

  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const send = vi.fn(() => Promise.resolve(mockRun));

  const view = {
    flattenNodes: vi.fn(() => []),
    getMessages: vi.fn(() => []),
    getNodeByCodecMessageId: vi.fn(),
    sendInput: send,
    regenerate: vi.fn(),
    edit: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-empty-function, unicorn/consistent-function-scoping -- mock returns noop unsubscribe
    on: vi.fn(() => () => {}),
  };

  const session = {
    sendInput: send,
    tree,
    view,
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    cancel: vi.fn(() => Promise.resolve()),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    close: vi.fn(() => Promise.resolve()),
    regenerate: vi.fn(),
    edit: vi.fn(),
    on: vi.fn(sessionEmitter.on),
    getMessages: vi.fn(() => []),
    getAblyMessages: vi.fn(() => []),
    history: vi.fn(),
  } as unknown as ClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>;

  return { session, send, mockRun };
};

const createMultiRunMockSession = () => {
  const treeEmitter = makeEmitter();
  const sessionEmitter = makeEmitter();
  const runA = createMockRun('run-a', treeEmitter.emit);
  const runB = createMockRun('run-b', treeEmitter.emit);
  const send = vi.fn().mockResolvedValueOnce(runA).mockResolvedValueOnce(runB);
  const tree = createMockTree(treeEmitter);

  const view = {
    flattenNodes: vi.fn(() => []),
    getMessages: vi.fn(() => []),
    getNodeByCodecMessageId: vi.fn(),
    sendInput: send,
    regenerate: vi.fn(),
    edit: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-empty-function, unicorn/consistent-function-scoping -- mock returns noop unsubscribe
    on: vi.fn(() => () => {}),
  };

  const session = {
    sendInput: send,
    tree,
    view,
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    cancel: vi.fn(() => Promise.resolve()),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    close: vi.fn(() => Promise.resolve()),
    regenerate: vi.fn(),
    edit: vi.fn(),
    on: vi.fn(sessionEmitter.on),
    getMessages: vi.fn(() => []),
    getAblyMessages: vi.fn(() => []),
    history: vi.fn(),
  } as unknown as ClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>;

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
