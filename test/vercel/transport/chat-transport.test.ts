import type * as AI from 'ai';
import { describe, expect, it, vi } from 'vitest';

import type { ClientTransport, ConversationNode, ConversationTree, SendOptions } from '../../../src/core/transport/types.js';
import { ErrorCode } from '../../../src/errors.js';
import type { ChatTransportOptions } from '../../../src/vercel/transport/chat-transport.js';
import { createChatTransport } from '../../../src/vercel/transport/chat-transport.js';
import { toBeErrorInfo } from '../../helper/expectations.js';

expect.extend({ toBeErrorInfo });

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-empty-function -- no-op unsubscribe stub for mock transport
const noop = (): void => {};

const makeMessage = (id: string, role: AI.UIMessage['role'] = 'user'): AI.UIMessage => ({
  id,
  role,
  parts: [],
});

interface MockTurn {
  stream: ReadableStream<AI.UIMessageChunk>;
  turnId: string;
  cancel: ReturnType<typeof vi.fn>;
  /** Resolve the stream by closing it. */
  close: () => void;
}

const createMockTurn = (): MockTurn => {
  let controller!: ReadableStreamDefaultController<AI.UIMessageChunk>;
  const stream = new ReadableStream<AI.UIMessageChunk>({
    start: (c) => {
      controller = c;
    },
  });
  const cancel = vi.fn();
  return {
    stream,
    turnId: 'turn-1',
    cancel,
    close: () => { controller.close(); },
  };
};

interface MockTransport {
  transport: ClientTransport<AI.UIMessageChunk, AI.UIMessage>;
  send: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  getTree: ReturnType<typeof vi.fn>;
  getMessageHeaders: ReturnType<typeof vi.fn>;
  mockTurn: MockTurn;
  tree: {
    getNodeByKey: ReturnType<typeof vi.fn>;
  };
}

const createMockTransport = (): MockTransport => {
  const mockTurn = createMockTurn();
  const tree = {
    getNodeByKey: vi.fn(),
    // Stub remaining ConversationTree methods
    flatten: vi.fn(() => []),
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
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const cancel = vi.fn(() => Promise.resolve());
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const close = vi.fn(() => Promise.resolve());
  const getTree = vi.fn(() => tree as unknown as ConversationTree<AI.UIMessage>);
  const getMessageHeaders = vi.fn();

  const transport = {
    send,
    cancel,
    close,
    getTree,
    getMessageHeaders,
    // Stub remaining ClientTransport methods
    regenerate: vi.fn(),
    edit: vi.fn(),
    waitForTurn: vi.fn(),
    on: vi.fn(() => noop),
    getActiveTurnIds: vi.fn(() => new Map()),
    getMessages: vi.fn(() => []),
    getInputMessages: vi.fn(() => []),
    getAblyMessages: vi.fn(() => []),
    history: vi.fn(),
  } as unknown as ClientTransport<AI.UIMessageChunk, AI.UIMessage>;

  return { transport, send, cancel, close, getTree, getMessageHeaders, mockTurn, tree };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createChatTransport', () => {
  describe('sendMessages — submit-message', () => {
    it('sends the last message and passes history in body', async () => {
      const { transport, send, mockTurn } = createMockTransport();
      const chat = createChatTransport(transport);

      const m1 = makeMessage('1');
      const m2 = makeMessage('2');
      const m3 = makeMessage('3');

      const streamPromise = chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [m1, m2, m3],
        abortSignal: undefined,
      });

      // Close the turn stream so the returned stream resolves
      mockTurn.close();
      await streamPromise;

      expect(send).toHaveBeenCalledOnce();
      const [msgs, opts] = send.mock.calls[0] as [AI.UIMessage[], SendOptions];
      expect(msgs).toEqual([m3]);
      expect(opts.body).toMatchObject({
        id: 'chat-1',
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
      const { transport } = createMockTransport();
      const chat = createChatTransport(transport);

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
      const { transport, send, mockTurn } = createMockTransport();
      const chat = createChatTransport(transport);

      const m1 = makeMessage('1');
      const m2 = makeMessage('2', 'assistant');

      const streamPromise = chat.sendMessages({
        trigger: 'regenerate-message',
        chatId: 'chat-1',
        messageId: 'm2-id',
        messages: [m1, m2],
        abortSignal: undefined,
      });

      mockTurn.close();
      await streamPromise;

      expect(send).toHaveBeenCalledOnce();
      const [msgs] = send.mock.calls[0] as [AI.UIMessage[]];
      expect(msgs).toEqual([]);
    });

    it('resolves fork metadata from the conversation tree', async () => {
      const { transport, send, tree, mockTurn } = createMockTransport();

      const node: Partial<ConversationNode<AI.UIMessage>> = {
        msgId: 'wire-msg-id',
        parentId: 'wire-parent-id',
      };
      tree.getNodeByKey.mockReturnValue(node);

      const chat = createChatTransport(transport);

      const streamPromise = chat.sendMessages({
        trigger: 'regenerate-message',
        chatId: 'chat-1',
        messageId: 'ui-message-id',
        messages: [makeMessage('1')],
        abortSignal: undefined,
      });

      mockTurn.close();
      await streamPromise;

      expect(tree.getNodeByKey).toHaveBeenCalledWith('ui-message-id');
      const [, opts] = send.mock.calls[0] as [AI.UIMessage[], SendOptions];
      expect(opts.forkOf).toBe('wire-msg-id');
      expect(opts.parent).toBe('wire-parent-id');
    });

    it('falls back to raw messageId when node not found in tree', async () => {
      const { transport, send, tree, mockTurn } = createMockTransport();
      // eslint-disable-next-line unicorn/no-useless-undefined -- mockReturnValue requires an argument
      tree.getNodeByKey.mockReturnValue(undefined);

      const chat = createChatTransport(transport);

      const streamPromise = chat.sendMessages({
        trigger: 'regenerate-message',
        chatId: 'chat-1',
        messageId: 'unknown-id',
        messages: [makeMessage('1')],
        abortSignal: undefined,
      });

      mockTurn.close();
      await streamPromise;

      const [, opts] = send.mock.calls[0] as [AI.UIMessage[], SendOptions];
      expect(opts.forkOf).toBe('unknown-id');
      expect(opts.parent).toBeUndefined();
    });
  });

  describe('empty stream return', () => {
    it('returns a stream with no chunks that closes when the turn stream ends', async () => {
      const { transport, mockTurn } = createMockTransport();
      const chat = createChatTransport(transport);

      const stream = await chat.sendMessages({
        trigger: 'regenerate-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      });

      // Close the turn stream
      mockTurn.close();

      // Read the returned stream — should produce no chunks and close
      const reader = stream.getReader();
      const { done, value } = await reader.read();
      expect(done).toBe(true);
      expect(value).toBeUndefined();
    });
  });

  describe('abort signal', () => {
    it('wires to transport.cancel({ all: true })', async () => {
      const { transport, cancel, mockTurn } = createMockTransport();
      const chat = createChatTransport(transport);
      const abortController = new AbortController();

      // sendMessages must resolve before the abort listener is registered
      const stream = await chat.sendMessages({
        trigger: 'regenerate-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [],
        abortSignal: abortController.signal,
      });

      // Abort — the listener calls `void transport.cancel()` which is fire-and-forget
      abortController.abort();

      expect(cancel).toHaveBeenCalledWith({ all: true });

      // Clean up
      mockTurn.close();
      const reader = stream.getReader();
      await reader.read();
    });
  });

  describe('prepareSendMessagesRequest hook', () => {
    it('uses the hook to customize body and headers', async () => {
      const { transport, send, mockTurn } = createMockTransport();

      const hook = vi.fn().mockReturnValue({
        body: { custom: 'body' },
        headers: { 'X-Custom': 'header' },
      });

      const chatOptions: ChatTransportOptions = {
        prepareSendMessagesRequest: hook,
      };

      const chat = createChatTransport(transport, chatOptions);
      const m1 = makeMessage('1');

      const streamPromise = chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [m1],
        abortSignal: undefined,
      });

      mockTurn.close();
      await streamPromise;

      // Verify the hook was called with correct context
      expect(hook).toHaveBeenCalledWith({
        id: 'chat-1',
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
    it('includes history with headers from transport.getMessageHeaders', async () => {
      const { transport, send, getMessageHeaders, mockTurn } = createMockTransport();

      const m1 = makeMessage('1');
      const m2 = makeMessage('2');
      getMessageHeaders.mockReturnValueOnce({ 'x-ably-msg-id': 'h1' });
      getMessageHeaders.mockReturnValueOnce({ 'x-ably-msg-id': 'h2' });

      const chat = createChatTransport(transport);

      const streamPromise = chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [m1, m2, makeMessage('3')],
        abortSignal: undefined,
      });

      mockTurn.close();
      await streamPromise;

      // getMessageHeaders should be called for each history message
      expect(getMessageHeaders).toHaveBeenCalledTimes(2);
      expect(getMessageHeaders).toHaveBeenCalledWith(m1);
      expect(getMessageHeaders).toHaveBeenCalledWith(m2);

      const [, opts] = send.mock.calls[0] as [AI.UIMessage[], SendOptions];
      // CAST: body is always set by the adapter; narrowing to non-undefined.
      // eslint-disable-next-line @typescript-eslint/non-nullable-type-assertion-style -- prefer `as` over `!` per TYPES.md
      const body = opts.body as Record<string, unknown>;
      const bodyHistory = body.history as {
        message: AI.UIMessage;
        headers: Record<string, string>;
      }[];
      expect(bodyHistory.at(0)?.headers).toEqual({ 'x-ably-msg-id': 'h1' });
      expect(bodyHistory.at(1)?.headers).toEqual({ 'x-ably-msg-id': 'h2' });
    });
  });

  describe('reconnectToStream', () => {
    it('returns null', async () => {
      const { transport } = createMockTransport();
      const chat = createChatTransport(transport);

      const result = await chat.reconnectToStream({ chatId: 'chat-1' });
      expect(result).toBeNull();
    });
  });

  describe('close', () => {
    it('delegates to transport.close with options', async () => {
      const { transport, close } = createMockTransport();
      const chat = createChatTransport(transport);

      await chat.close({ cancel: { all: true } });

      expect(close).toHaveBeenCalledWith({ cancel: { all: true } });
    });

    it('delegates to transport.close without options', async () => {
      const { transport, close } = createMockTransport();
      const chat = createChatTransport(transport);

      await chat.close();

      expect(close).toHaveBeenCalledWith(undefined);
    });
  });
});
