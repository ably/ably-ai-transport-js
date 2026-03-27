import type * as AI from 'ai';
import { describe, expect, it, vi } from 'vitest';

import type { ClientTransport, SendOptions,Tree } from '../../../src/core/transport/types.js';
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
  mockTurn: MockTurn;
  tree: Tree<AI.UIMessage>;
}

const createMockTransport = (): MockTransport => {
  const mockTurn = createMockTurn();
  const tree: Tree<AI.UIMessage> = {
    flattenNodes: vi.fn(() => []),
    getSiblings: vi.fn(() => []),
    hasSiblings: vi.fn(() => false),
    getSelectedIndex: vi.fn(() => 0),
    select: vi.fn(),
    getNode: vi.fn(),
    getHeaders: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    getActiveTurnIds: vi.fn(() => new Map()),
    // eslint-disable-next-line @typescript-eslint/no-empty-function, unicorn/consistent-function-scoping -- mock returns noop unsubscribe
    on: vi.fn(() => () => {}),
  };

  const view = {
    flattenNodes: vi.fn(() => []),
    hasOlder: vi.fn(() => false),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    loadOlder: vi.fn(() => Promise.resolve()),
    getActiveTurnIds: vi.fn(() => new Map()),
    // eslint-disable-next-line @typescript-eslint/no-empty-function, unicorn/consistent-function-scoping -- mock returns noop unsubscribe
    on: vi.fn(() => () => {}),
  };

  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const send = vi.fn(() => Promise.resolve(mockTurn));
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const cancel = vi.fn(() => Promise.resolve());
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const close = vi.fn(() => Promise.resolve());

  const transport = {
    tree,
    view,
    send,
    cancel,
    close,
    regenerate: vi.fn(),
    edit: vi.fn(),
    waitForTurn: vi.fn(),
    on: vi.fn(() => noop),
  } as unknown as ClientTransport<AI.UIMessageChunk, AI.UIMessage>;

  return { transport, send, cancel, close, mockTurn, tree };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createChatTransport', () => {
  describe('sendMessages — submit-message', () => {
    it('sends the last message and passes history in body', async () => {
      const { transport, send, tree, mockTurn } = createMockTransport();
      const chat = createChatTransport(transport);

      const m1 = makeMessage('1');
      const m2 = makeMessage('2');
      const m3 = makeMessage('3');

      (tree.flattenNodes as ReturnType<typeof vi.fn>).mockReturnValue([
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

      const msg = makeMessage('ui-message-id');
      (tree.flattenNodes as ReturnType<typeof vi.fn>).mockReturnValue([
        {
          message: msg,
          msgId: 'wire-msg-id',
          parentId: 'wire-parent-id',
          forkOf: undefined,
          headers: {},
          serial: undefined,
        },
      ]);

      const chat = createChatTransport(transport);

      const streamPromise = chat.sendMessages({
        trigger: 'regenerate-message',
        chatId: 'chat-1',
        messageId: 'ui-message-id',
        messages: [msg],
        abortSignal: undefined,
      });

      mockTurn.close();
      await streamPromise;

      const [, opts] = send.mock.calls[0] as [AI.UIMessage[], SendOptions];
      expect(opts.forkOf).toBe('wire-msg-id');
      expect(opts.parent).toBe('wire-parent-id');
    });

    it('falls back to raw messageId when node not found in tree', async () => {
      const { transport, send, tree, mockTurn } = createMockTransport();
      (tree.flattenNodes as ReturnType<typeof vi.fn>).mockReturnValue([]);

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
    it('includes history nodes from transport.tree.flattenNodes', async () => {
      const { transport, send, tree, mockTurn } = createMockTransport();

      const m1 = makeMessage('1');
      const m2 = makeMessage('2');
      const m3 = makeMessage('3');
      (tree.flattenNodes as ReturnType<typeof vi.fn>).mockReturnValue([
        { message: m1, msgId: 'h1', parentId: undefined, forkOf: undefined, headers: { 'x-ably-msg-id': 'h1' }, serial: undefined },
        { message: m2, msgId: 'h2', parentId: 'h1', forkOf: undefined, headers: { 'x-ably-msg-id': 'h2' }, serial: undefined },
        { message: m3, msgId: 'h3', parentId: 'h2', forkOf: undefined, headers: { 'x-ably-msg-id': 'h3' }, serial: undefined },
      ]);

      const chat = createChatTransport(transport);

      const streamPromise = chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [m1, m2, m3],
        abortSignal: undefined,
      });

      mockTurn.close();
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
