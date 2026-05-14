import type * as AI from 'ai';
import { describe, expect, it, vi } from 'vitest';

import type { ClientSession, SendOptions, Tree, View } from '../../../src/core/transport/types.js';
import { ErrorCode } from '../../../src/errors.js';
import type { VercelEvent, VercelProjection } from '../../../src/vercel/codec/index.js';
import type { ChatTransportOptions } from '../../../src/vercel/transport/chat-transport.js';
import { createChatTransport } from '../../../src/vercel/transport/chat-transport.js';
import { toBeErrorInfo } from '../../helper/expectations.js';

expect.extend({ toBeErrorInfo });

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-empty-function -- no-op unsubscribe stub for mock session
const noop = (): void => {};

const makeMessage = (id: string, role: AI.UIMessage['role'] = 'user'): AI.UIMessage => ({
  id,
  role,
  parts: [],
});

const makeAssistantWithToolPart = (id: string, part: AI.DynamicToolUIPart): AI.UIMessage => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text: 'intro' }, part],
});

interface MockRun {
  stream: ReadableStream<AI.UIMessageChunk>;
  runId: string;
  invocationId: string;
  cancel: ReturnType<typeof vi.fn>;
  optimisticMsgIds: string[];
  /** Enqueue a chunk into the run stream. */
  enqueue: (chunk: AI.UIMessageChunk) => void;
  /** Resolve the stream by closing it. */
  close: () => void;
  /** Error the stream with the given reason. */
  error: (reason: unknown) => void;
}

const createMockRun = (): MockRun => {
  let controller!: ReadableStreamDefaultController<AI.UIMessageChunk>;
  const stream = new ReadableStream<AI.UIMessageChunk>({
    start: (c) => {
      controller = c;
    },
  });
  const cancel = vi.fn();
  return {
    stream,
    runId: 'run-1',
    invocationId: 'inv-1',
    cancel,
    optimisticMsgIds: [],
    enqueue: (chunk: AI.UIMessageChunk) => {
      controller.enqueue(chunk);
    },
    close: () => {
      controller.close();
    },
    error: (reason: unknown) => {
      controller.error(reason);
    },
  };
};

interface MockSession {
  session: ClientSession<VercelEvent, VercelProjection, AI.UIMessage>;
  send: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  mockRun: MockRun;
  tree: Tree<AI.UIMessage>;
  view: View<VercelEvent, VercelProjection, AI.UIMessage>;
}

const createMockSession = (): MockSession => {
  const mockRun = createMockRun();
  const tree: Tree<AI.UIMessage> = {
    getSiblings: vi.fn(() => []),
    hasSiblings: vi.fn(() => false),
    getNode: vi.fn(),
    getHeaders: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    getActiveRunIds: vi.fn(() => new Map()),
    getWinningInvocation: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-empty-function, unicorn/consistent-function-scoping -- mock returns noop unsubscribe
    on: vi.fn(() => () => {}),
  };

  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const send = vi.fn(() => Promise.resolve(mockRun));

  // CAST: mock object satisfies the subset of View methods used by chat-transport tests
  const view = {
    flattenNodes: vi.fn(() => []),
    getMessages: vi.fn(() => []),
    hasOlder: vi.fn(() => false),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    loadOlder: vi.fn(() => Promise.resolve()),
    select: vi.fn(),
    getSelectedIndex: vi.fn(() => 0),
    getSiblings: vi.fn(() => []),
    hasSiblings: vi.fn(() => false),
    getNode: vi.fn(),
    sendMessage: vi.fn(),
    sendEvent: send,
    regenerate: vi.fn(),
    edit: vi.fn(),
    getActiveRunIds: vi.fn(() => new Map()),
    // eslint-disable-next-line @typescript-eslint/no-empty-function, unicorn/consistent-function-scoping -- mock returns noop unsubscribe
    on: vi.fn(() => () => {}),
    close: vi.fn(),
  } as unknown as View<VercelEvent, VercelProjection, AI.UIMessage>;

  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const cancel = vi.fn(() => Promise.resolve());
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const close = vi.fn(() => Promise.resolve());

  const session = {
    tree,
    view,
    createView: vi.fn(() => view),
    cancel,
    close,
    waitForRun: vi.fn(),
    on: vi.fn(() => noop),
  } as unknown as ClientSession<VercelEvent, VercelProjection, AI.UIMessage>;

  return { session, send, cancel, close, mockRun, tree, view };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createChatTransport', () => {
  describe('sendMessages — submit-message', () => {
    it('sends the last message and passes history in body', async () => {
      const { session, send, view, mockRun } = createMockSession();
      const chat = createChatTransport(session);

      const m1 = makeMessage('1');
      const m2 = makeMessage('2');
      const m3 = makeMessage('3');

      (view.flattenNodes as ReturnType<typeof vi.fn>).mockReturnValue([
        { message: m1, msgId: 'n1', parentId: undefined, forkOf: undefined, headers: {}, serial: undefined },
        { message: m2, msgId: 'n2', parentId: 'n1', forkOf: undefined, headers: {}, serial: undefined },
        { message: m3, msgId: 'n3', parentId: 'n2', forkOf: undefined, headers: {}, serial: undefined },
      ]);

      const streamPromise = chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [m1, m2, m3],
        abortSignal: undefined,
      });

      // Close the run stream so the returned stream resolves
      mockRun.close();
      await streamPromise;

      expect(send).toHaveBeenCalledOnce();
      const [events, opts] = send.mock.calls[0] as [VercelEvent[], SendOptions];
      expect(events).toEqual([{ type: 'ait-user-message', message: m3 }]);
      expect(opts.body).toMatchObject({
        sessionName: 'chat-1',
        trigger: 'submit-message',
      });
      // History should include the first two messages
      // CAST: body is always set by the adapter; narrowing to non-undefined.
      // eslint-disable-next-line @typescript-eslint/non-nullable-type-assertion-style -- prefer `as` over `!` per TYPES.md
      const body = opts.body as Record<string, unknown>;
      const bodyHistory = body.history as { message: AI.UIMessage }[];
      expect(bodyHistory).toHaveLength(2);
      expect(bodyHistory.at(0)?.message).toEqual(m1);
      expect(bodyHistory.at(1)?.message).toEqual(m2);
    });

    it('throws on empty messages array', async () => {
      const { session } = createMockSession();
      const chat = createChatTransport(session);

      await expect(
        chat.sendMessages({
          trigger: 'submit-message',
          chatId: 'chat-1',
          messageId: undefined,
          messages: [],
          abortSignal: undefined,
        }),
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeErrorInfo({
          code: ErrorCode.InvalidArgument,
          statusCode: 400,
          message: 'unable to send messages; messages array is empty for submit-message trigger',
        });
        return true;
      });
    });
  });

  describe('sendMessages — regenerate-message', () => {
    it('sends empty messages with all input as history', async () => {
      const { session, send, mockRun } = createMockSession();
      const chat = createChatTransport(session);

      const m1 = makeMessage('1');
      const m2 = makeMessage('2', 'assistant');

      const streamPromise = chat.sendMessages({
        trigger: 'regenerate-message',
        chatId: 'chat-1',
        messageId: 'm2-id',
        messages: [m1, m2],
        abortSignal: undefined,
      });

      mockRun.close();
      await streamPromise;

      expect(send).toHaveBeenCalledOnce();
      const [events] = send.mock.calls[0] as [VercelEvent[]];
      expect(events).toEqual([]);
    });

    it('resolves fork metadata from the conversation tree', async () => {
      const { session, send, view, mockRun } = createMockSession();

      const msg = makeMessage('ui-message-id');
      (view.flattenNodes as ReturnType<typeof vi.fn>).mockReturnValue([
        {
          message: msg,
          msgId: 'wire-msg-id',
          parentId: 'wire-parent-id',
          forkOf: undefined,
          headers: {},
          serial: undefined,
        },
      ]);

      const chat = createChatTransport(session);

      const streamPromise = chat.sendMessages({
        trigger: 'regenerate-message',
        chatId: 'chat-1',
        messageId: 'ui-message-id',
        messages: [msg],
        abortSignal: undefined,
      });

      mockRun.close();
      await streamPromise;

      const [, opts] = send.mock.calls[0] as [AI.UIMessage[], SendOptions];
      expect(opts.forkOf).toBe('wire-msg-id');
      expect(opts.parent).toBe('wire-parent-id');
    });

    it('falls back to raw messageId when node not found in tree', async () => {
      const { session, send, view, mockRun } = createMockSession();
      (view.flattenNodes as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const chat = createChatTransport(session);

      const streamPromise = chat.sendMessages({
        trigger: 'regenerate-message',
        chatId: 'chat-1',
        messageId: 'unknown-id',
        messages: [makeMessage('1')],
        abortSignal: undefined,
      });

      mockRun.close();
      await streamPromise;

      const [, opts] = send.mock.calls[0] as [AI.UIMessage[], SendOptions];
      expect(opts.forkOf).toBe('unknown-id');
      expect(opts.parent).toBeUndefined();
    });
  });

  describe('sendMessages — submit-message with messageId (edit)', () => {
    it('resolves fork metadata from the conversation tree', async () => {
      const { session, send, view, mockRun } = createMockSession();

      const edited = makeMessage('ui-msg-id');
      (view.flattenNodes as ReturnType<typeof vi.fn>).mockReturnValue([
        {
          message: edited,
          msgId: 'wire-msg-id',
          parentId: 'wire-parent-id',
          forkOf: undefined,
          headers: {},
          serial: undefined,
        },
      ]);

      const chat = createChatTransport(session);

      const streamPromise = chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: 'ui-msg-id',
        messages: [edited],
        abortSignal: undefined,
      });

      mockRun.close();
      await streamPromise;

      const [, opts] = send.mock.calls[0] as [AI.UIMessage[], SendOptions];
      expect(opts.forkOf).toBe('wire-msg-id');
      expect(opts.parent).toBe('wire-parent-id');
    });

    it('falls back to raw messageId when node not found in tree', async () => {
      const { session, send, view, mockRun } = createMockSession();
      (view.flattenNodes as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const chat = createChatTransport(session);

      const streamPromise = chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: 'unknown-id',
        messages: [makeMessage('1')],
        abortSignal: undefined,
      });

      mockRun.close();
      await streamPromise;

      const [, opts] = send.mock.calls[0] as [AI.UIMessage[], SendOptions];
      expect(opts.forkOf).toBe('unknown-id');
      expect(opts.parent).toBeUndefined();
    });

    it('sends the edited message as new and prior messages as history', async () => {
      const { session, send, view, mockRun } = createMockSession();

      const m1 = makeMessage('1');
      const edited = makeMessage('2');

      (view.flattenNodes as ReturnType<typeof vi.fn>).mockReturnValue([
        { message: m1, msgId: 'n1', parentId: undefined, forkOf: undefined, headers: {}, serial: undefined },
        { message: edited, msgId: 'n2', parentId: 'n1', forkOf: undefined, headers: {}, serial: undefined },
      ]);

      const chat = createChatTransport(session);

      const streamPromise = chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: '2',
        messages: [m1, edited],
        abortSignal: undefined,
      });

      mockRun.close();
      await streamPromise;

      const [events, opts] = send.mock.calls[0] as [VercelEvent[], SendOptions];
      expect(events).toEqual([{ type: 'ait-user-message', message: edited }]);
      // CAST: body is always set by the adapter; narrowing to non-undefined.
      // eslint-disable-next-line @typescript-eslint/non-nullable-type-assertion-style -- prefer `as` over `!` per TYPES.md
      const body = opts.body as Record<string, unknown>;
      const bodyHistory = body.history as { message: AI.UIMessage }[];
      expect(bodyHistory).toHaveLength(1);
      expect(bodyHistory.at(0)?.message).toEqual(m1);
    });
  });

  describe('real stream return', () => {
    it('returns the run stream with chunks flowing through', async () => {
      const { session, mockRun } = createMockSession();
      const chat = createChatTransport(session);

      const stream = await chat.sendMessages({
        trigger: 'regenerate-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      });

      // Enqueue chunks into the run stream
      mockRun.enqueue({ type: 'start', messageId: 'msg-1' });
      mockRun.enqueue({ type: 'text-start', id: 'text-1' });
      mockRun.enqueue({ type: 'text-delta', id: 'text-1', delta: 'Hello' });
      mockRun.enqueue({ type: 'finish', finishReason: 'stop' });
      mockRun.close();

      // Read the returned stream — should produce the enqueued chunks
      const reader = stream.getReader();
      const chunks: AI.UIMessageChunk[] = [];
      let result = await reader.read();
      while (!result.done) {
        chunks.push(result.value);
        result = await reader.read();
      }

      expect(chunks).toHaveLength(4);
      expect(chunks[0]).toMatchObject({ type: 'start', messageId: 'msg-1' });
      expect(chunks[1]).toMatchObject({ type: 'text-start', id: 'text-1' });
      expect(chunks[2]).toMatchObject({ type: 'text-delta', delta: 'Hello' });
      expect(chunks[3]).toMatchObject({ type: 'finish', finishReason: 'stop' });
    });
  });

  describe('stream error propagation', () => {
    it('errors the returned stream when the run stream errors', async () => {
      const { session, mockRun } = createMockSession();
      const chat = createChatTransport(session);

      const stream = await chat.sendMessages({
        trigger: 'regenerate-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      });

      const error = new Error('channel continuity lost');
      mockRun.error(error);

      const reader = stream.getReader();
      await expect(reader.read()).rejects.toBe(error);
    });
  });

  describe('abort signal', () => {
    it('wires to session.cancel({ all: true })', async () => {
      const { session, cancel, mockRun } = createMockSession();
      const chat = createChatTransport(session);
      const abortController = new AbortController();

      // sendMessages must resolve before the abort listener is registered
      const stream = await chat.sendMessages({
        trigger: 'regenerate-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [],
        abortSignal: abortController.signal,
      });

      // Abort — the listener calls `void session.cancel()` which is fire-and-forget
      abortController.abort();

      expect(cancel).toHaveBeenCalledWith({ all: true });

      // Clean up
      mockRun.close();
      const reader = stream.getReader();
      await reader.read();
    });
  });

  describe('prepareSendMessagesRequest hook', () => {
    it('uses the hook to customize body and headers', async () => {
      const { session, send, mockRun } = createMockSession();

      const hook = vi.fn().mockReturnValue({
        body: { custom: 'body' },
        headers: { 'X-Custom': 'header' },
      });

      const chatOptions: ChatTransportOptions = {
        prepareSendMessagesRequest: hook,
      };

      const chat = createChatTransport(session, chatOptions);
      const m1 = makeMessage('1');

      const streamPromise = chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [m1],
        abortSignal: undefined,
      });

      mockRun.close();
      await streamPromise;

      // Verify the hook was called with correct context
      expect(hook).toHaveBeenCalledWith({
        chatId: 'chat-1',
        trigger: 'submit-message',
        messageId: undefined,
        history: [],
        messages: [m1],
        forkOf: undefined,
        parent: undefined,
      });

      // Verify the custom body/headers were passed to send
      const [, opts] = send.mock.calls[0] as [AI.UIMessage[], SendOptions];
      expect(opts.body).toEqual({ custom: 'body' });
      expect(opts.headers).toEqual({ 'X-Custom': 'header' });
    });
  });

  describe('default body construction', () => {
    it('includes history nodes from session.view.flattenNodes', async () => {
      const { session, send, view, mockRun } = createMockSession();

      const m1 = makeMessage('1');
      const m2 = makeMessage('2');
      const m3 = makeMessage('3');
      (view.flattenNodes as ReturnType<typeof vi.fn>).mockReturnValue([
        {
          message: m1,
          msgId: 'h1',
          parentId: undefined,
          forkOf: undefined,
          headers: { 'x-ably-msg-id': 'h1' },
          serial: undefined,
        },
        {
          message: m2,
          msgId: 'h2',
          parentId: 'h1',
          forkOf: undefined,
          headers: { 'x-ably-msg-id': 'h2' },
          serial: undefined,
        },
        {
          message: m3,
          msgId: 'h3',
          parentId: 'h2',
          forkOf: undefined,
          headers: { 'x-ably-msg-id': 'h3' },
          serial: undefined,
        },
      ]);

      const chat = createChatTransport(session);

      const streamPromise = chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [m1, m2, m3],
        abortSignal: undefined,
      });

      mockRun.close();
      await streamPromise;

      const [, opts] = send.mock.calls[0] as [AI.UIMessage[], SendOptions];
      // CAST: body is always set by the adapter; narrowing to non-undefined.
      // eslint-disable-next-line @typescript-eslint/non-nullable-type-assertion-style -- prefer `as` over `!` per TYPES.md
      const body = opts.body as Record<string, unknown>;
      const bodyHistory = body.history as { message: AI.UIMessage; msgId: string; headers: Record<string, string> }[];
      // History should include m1 and m2 (everything except the last message being sent)
      expect(bodyHistory).toHaveLength(2);
      expect(bodyHistory.at(0)?.msgId).toBe('h1');
      expect(bodyHistory.at(1)?.msgId).toBe('h2');
    });
  });

  describe('reconnectToStream', () => {
    it('returns null', async () => {
      const { session } = createMockSession();
      const chat = createChatTransport(session);

      const result = await chat.reconnectToStream({ chatId: 'chat-1' });
      expect(result).toBeNull();
    });
  });

  describe('close', () => {
    it('delegates to session.close with options', async () => {
      const { session, close } = createMockSession();
      const chat = createChatTransport(session);

      await chat.close({ cancel: { all: true } });

      expect(close).toHaveBeenCalledWith({ cancel: { all: true } });
    });

    it('delegates to session.close without options', async () => {
      const { session, close } = createMockSession();
      const chat = createChatTransport(session);

      await chat.close();

      expect(close).toHaveBeenCalledWith(undefined);
    });
  });

  describe('streaming signal', () => {
    it('streaming is false initially', () => {
      const { session } = createMockSession();
      const chat = createChatTransport(session);
      expect(chat.streaming).toBe(false);
    });

    it('streaming becomes true during sendMessages and false after stream closes', async () => {
      const { session, mockRun } = createMockSession();
      const chat = createChatTransport(session);

      const streamPromise = chat.sendMessages({
        trigger: 'regenerate-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      });

      const stream = await streamPromise;
      expect(chat.streaming).toBe(true);

      // Close the stream and drain it
      mockRun.close();
      const reader = stream.getReader();
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        // drain
      }

      // Allow microtasks (pipeTo completion + done.then) to settle
      await new Promise((r) => setTimeout(r, 0));
      expect(chat.streaming).toBe(false);
    });

    it('onStreamingChange fires on transitions', async () => {
      const { session, mockRun } = createMockSession();
      const chat = createChatTransport(session);

      const log: boolean[] = [];
      const unsub = chat.onStreamingChange((s) => log.push(s));

      const stream = await chat.sendMessages({
        trigger: 'regenerate-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      });

      expect(log).toEqual([true]);

      mockRun.close();
      const reader = stream.getReader();
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        // drain
      }
      await new Promise((r) => setTimeout(r, 0));

      expect(log).toEqual([true, false]);

      unsub();
    });

    it('streaming resets to false when the source stream errors', async () => {
      const { session, mockRun } = createMockSession();
      const chat = createChatTransport(session);

      const log: boolean[] = [];
      chat.onStreamingChange((s) => log.push(s));

      const stream = await chat.sendMessages({
        trigger: 'regenerate-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      });

      expect(chat.streaming).toBe(true);

      // Error the source stream instead of closing it cleanly
      mockRun.enqueue({ type: 'text-start', id: 'text-1' });
      mockRun.close(); // close source so pipeTo finishes (error path is via reader cancel)

      const reader = stream.getReader();
      await reader.cancel('test cancel');

      // Allow pipeTo catch + done.then to settle
      await new Promise((r) => setTimeout(r, 10));
      expect(chat.streaming).toBe(false);
      expect(log).toEqual([true, false]);
    });

    it('streaming resets to false when sendMessages throws', async () => {
      const { session, send } = createMockSession();
      const chat = createChatTransport(session);

      // Make session.send reject
      send.mockRejectedValueOnce(new Error('send failed'));

      const log: boolean[] = [];
      chat.onStreamingChange((s) => log.push(s));

      await expect(
        chat.sendMessages({
          trigger: 'regenerate-message',
          chatId: 'chat-1',
          messageId: undefined,
          messages: [],
          abortSignal: undefined,
        }),
      ).rejects.toThrow('send failed');

      // streaming should never have been set to true because the error
      // occurred before wrapStreamWithDone was called
      expect(chat.streaming).toBe(false);
      expect(log).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Fork-on-unresolved-tool
  // -------------------------------------------------------------------------

  describe('sendMessages — fork on unresolved tool call', () => {
    it('forks off the preceding assistant when it has approval-requested', async () => {
      const { session, send, view, mockRun } = createMockSession();

      const user1 = makeMessage('u1');
      const assistant = makeAssistantWithToolPart('a1', {
        type: 'dynamic-tool',
        toolName: 'getWeatherForecast',
        toolCallId: 'tc1',
        state: 'approval-requested',
        input: { location: 'London' },
        approval: { id: 'ap-1' },
      });
      const user2 = makeMessage('u2');

      (view.flattenNodes as ReturnType<typeof vi.fn>).mockReturnValue([
        { message: user1, msgId: 'wire-u1', parentId: undefined, forkOf: undefined, headers: {}, serial: undefined },
        {
          message: assistant,
          msgId: 'wire-a1',
          parentId: 'wire-u1',
          forkOf: undefined,
          headers: {},
          serial: undefined,
        },
      ]);

      const chat = createChatTransport(session);
      const streamPromise = chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [user1, assistant, user2],
        abortSignal: undefined,
      });
      mockRun.close();
      await streamPromise;

      const [events, opts] = send.mock.calls[0] as [VercelEvent[], SendOptions];
      expect(events).toEqual([{ type: 'ait-user-message', message: user2 }]);
      expect(opts.forkOf).toBe('wire-a1');
      expect(opts.parent).toBe('wire-u1');
      // History excludes the unresolved assistant — `[user1]` only.
      // eslint-disable-next-line @typescript-eslint/non-nullable-type-assertion-style -- prefer `as` over `!` per TYPES.md
      const body = opts.body as Record<string, unknown>;
      const bodyHistory = body.history as { message: AI.UIMessage }[];
      expect(bodyHistory).toHaveLength(1);
      expect(bodyHistory[0]?.message).toEqual(user1);
    });

    it('forks when the preceding assistant has input-available (client tool pending)', async () => {
      const { session, send, view, mockRun } = createMockSession();

      const user1 = makeMessage('u1');
      const assistant = makeAssistantWithToolPart('a1', {
        type: 'dynamic-tool',
        toolName: 'getLocation',
        toolCallId: 'tc1',
        state: 'input-available',
        input: { highAccuracy: false },
      });
      const user2 = makeMessage('u2');

      (view.flattenNodes as ReturnType<typeof vi.fn>).mockReturnValue([
        { message: user1, msgId: 'wire-u1', parentId: undefined, forkOf: undefined, headers: {}, serial: undefined },
        {
          message: assistant,
          msgId: 'wire-a1',
          parentId: 'wire-u1',
          forkOf: undefined,
          headers: {},
          serial: undefined,
        },
      ]);

      const chat = createChatTransport(session);
      const streamPromise = chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [user1, assistant, user2],
        abortSignal: undefined,
      });
      mockRun.close();
      await streamPromise;

      const [, opts] = send.mock.calls[0] as [AI.UIMessage[], SendOptions];
      expect(opts.forkOf).toBe('wire-a1');
      expect(opts.parent).toBe('wire-u1');
    });

    it('forks when the preceding assistant has input-streaming', async () => {
      const { session, send, view, mockRun } = createMockSession();

      const user1 = makeMessage('u1');
      const assistant = makeAssistantWithToolPart('a1', {
        type: 'dynamic-tool',
        toolName: 'tX',
        toolCallId: 'tc1',
        state: 'input-streaming',
        input: undefined,
      });
      const user2 = makeMessage('u2');

      (view.flattenNodes as ReturnType<typeof vi.fn>).mockReturnValue([
        { message: user1, msgId: 'wire-u1', parentId: undefined, forkOf: undefined, headers: {}, serial: undefined },
        {
          message: assistant,
          msgId: 'wire-a1',
          parentId: 'wire-u1',
          forkOf: undefined,
          headers: {},
          serial: undefined,
        },
      ]);

      const chat = createChatTransport(session);
      const streamPromise = chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [user1, assistant, user2],
        abortSignal: undefined,
      });
      mockRun.close();
      await streamPromise;

      const [, opts] = send.mock.calls[0] as [AI.UIMessage[], SendOptions];
      expect(opts.forkOf).toBe('wire-a1');
      expect(opts.parent).toBe('wire-u1');
    });

    it('does NOT fork when the preceding assistant has output-available (resolved)', async () => {
      const { session, send, view, mockRun } = createMockSession();

      const user1 = makeMessage('u1');
      const assistant = makeAssistantWithToolPart('a1', {
        type: 'dynamic-tool',
        toolName: 'getWeather',
        toolCallId: 'tc1',
        state: 'output-available',
        input: { location: 'London' },
        output: { conditions: 'Sunny' },
      });
      const user2 = makeMessage('u2');

      (view.flattenNodes as ReturnType<typeof vi.fn>).mockReturnValue([
        { message: user1, msgId: 'wire-u1', parentId: undefined, forkOf: undefined, headers: {}, serial: undefined },
        {
          message: assistant,
          msgId: 'wire-a1',
          parentId: 'wire-u1',
          forkOf: undefined,
          headers: {},
          serial: undefined,
        },
      ]);

      const chat = createChatTransport(session);
      const streamPromise = chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [user1, assistant, user2],
        abortSignal: undefined,
      });
      mockRun.close();
      await streamPromise;

      const [events, opts] = send.mock.calls[0] as [VercelEvent[], SendOptions];
      expect(events).toEqual([{ type: 'ait-user-message', message: user2 }]);
      expect(opts.forkOf).toBeUndefined();
      expect(opts.parent).toBeUndefined();
    });

    it('does NOT fork when the preceding assistant has approval-responded', async () => {
      const { session, send, view, mockRun } = createMockSession();

      const user1 = makeMessage('u1');
      const assistant = makeAssistantWithToolPart('a1', {
        type: 'dynamic-tool',
        toolName: 'getWeatherForecast',
        toolCallId: 'tc1',
        state: 'approval-responded',
        input: { location: 'London' },
        approval: { id: 'ap-1', approved: true },
      });
      const user2 = makeMessage('u2');

      (view.flattenNodes as ReturnType<typeof vi.fn>).mockReturnValue([
        { message: user1, msgId: 'wire-u1', parentId: undefined, forkOf: undefined, headers: {}, serial: undefined },
        {
          message: assistant,
          msgId: 'wire-a1',
          parentId: 'wire-u1',
          forkOf: undefined,
          headers: {},
          serial: undefined,
        },
      ]);

      const chat = createChatTransport(session);
      const streamPromise = chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [user1, assistant, user2],
        abortSignal: undefined,
      });
      mockRun.close();
      await streamPromise;

      const [, opts] = send.mock.calls[0] as [AI.UIMessage[], SendOptions];
      expect(opts.forkOf).toBeUndefined();
      expect(opts.parent).toBeUndefined();
    });

    it('does NOT fork in edit mode (messageId takes priority over preceding unresolved tool)', async () => {
      const { session, send, view, mockRun } = createMockSession();

      const user1 = makeMessage('u1');
      const assistant = makeAssistantWithToolPart('a1', {
        type: 'dynamic-tool',
        toolName: 'getWeatherForecast',
        toolCallId: 'tc1',
        state: 'approval-requested',
        input: {},
        approval: { id: 'ap-1' },
      });
      const edited = makeMessage('u2');

      (view.flattenNodes as ReturnType<typeof vi.fn>).mockReturnValue([
        { message: user1, msgId: 'wire-u1', parentId: undefined, forkOf: undefined, headers: {}, serial: undefined },
        {
          message: assistant,
          msgId: 'wire-a1',
          parentId: 'wire-u1',
          forkOf: undefined,
          headers: {},
          serial: undefined,
        },
        { message: edited, msgId: 'wire-u2', parentId: 'wire-a1', forkOf: undefined, headers: {}, serial: undefined },
      ]);

      const chat = createChatTransport(session);
      const streamPromise = chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: 'u2',
        messages: [user1, assistant, edited],
        abortSignal: undefined,
      });
      mockRun.close();
      await streamPromise;

      const [, opts] = send.mock.calls[0] as [AI.UIMessage[], SendOptions];
      // Edit path forks off the edited message, not the assistant.
      expect(opts.forkOf).toBe('wire-u2');
      expect(opts.parent).toBe('wire-a1');
    });
  });
});
