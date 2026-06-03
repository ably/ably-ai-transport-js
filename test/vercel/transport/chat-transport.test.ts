import type * as AI from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Invocation } from '../../../src/core/transport/invocation.js';
import type { ClientSession, SendOptions, Tree, View } from '../../../src/core/transport/types.js';
import { ErrorCode } from '../../../src/errors.js';
import type { VercelInput, VercelOutput, VercelProjection } from '../../../src/vercel/codec/index.js';
import type { ChatTransportOptions } from '../../../src/vercel/transport/chat-transport.js';
import { createChatTransport } from '../../../src/vercel/transport/chat-transport.js';
import { toBeErrorInfo } from '../../helper/expectations.js';

expect.extend({ toBeErrorInfo });

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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

/**
 * Minimal event registry mirroring the Tree/session `on(event, handler)`
 * contract: returns an unsubscribe, dispatches synchronously in registration
 * order. Lets tests drive the transport's stream via the same `output` / `run`
 * / `error` events the production stream subscribes to.
 */
interface MockEmitter {
  on: (event: string, handler: (arg: never) => void) => () => void;
  emit: (event: string, arg?: unknown) => void;
}

const makeEmitter = (): MockEmitter => {
  const handlers = new Map<string, Set<(arg: never) => void>>();
  return {
    on: (event, handler) => {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },
    // CAST: the registry is untyped; the production `on` overloads guarantee
    // each handler receives the payload matching its event.
    emit: (event, arg) => {
      for (const handler of handlers.get(event) ?? []) (handler as (a: unknown) => void)(arg);
    },
  };
};

interface MockRun {
  stream: ReadableStream<AI.UIMessageChunk>;
  started: Promise<void>;
  runId: string;
  cancel: ReturnType<typeof vi.fn>;
  optimisticCodecMessageIds: string[];
  toInvocation: () => Invocation;
  /** Emit a chunk as a Tree `output` event for this run (drives the consumer stream). */
  enqueue: (chunk: AI.UIMessageChunk) => void;
  /** Emit a terminal `run-end` for this run (closes the consumer stream). */
  close: () => void;
  /** Emit a session `error` (errors the consumer stream). */
  error: (reason: unknown) => void;
}

interface MockSession {
  session: ClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>;
  send: ReturnType<typeof vi.fn>;
  regenerate: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  mockRun: MockRun;
  tree: Tree<VercelOutput, VercelProjection>;
  view: View<VercelInput, AI.UIMessage>;
}

const createMockSession = (): MockSession => {
  const treeEmitter = makeEmitter();
  const sessionEmitter = makeEmitter();
  const runId = 'run-1';

  const mockRun: MockRun = {
    // The transport no longer reads this — it builds its own stream from Tree
    // events. Kept only to satisfy the ActiveRun shape returned by send.
    stream: new ReadableStream<AI.UIMessageChunk>({
      // eslint-disable-next-line @typescript-eslint/no-empty-function -- inert placeholder stream
      start: () => {},
    }),
    started: Promise.resolve(),
    runId,
    cancel: vi.fn(),
    optimisticCodecMessageIds: [],
    toInvocation: () => Invocation.fromJSON({ runId, inputEventId: '', sessionName: 'chat-1' }),
    enqueue: (chunk: AI.UIMessageChunk) => {
      treeEmitter.emit('output', { runId, codecMessageId: 'm-1', serial: 's-1', events: [chunk] });
    },
    close: () => {
      treeEmitter.emit('run', {
        type: 'end',
        runId,
        clientId: '',
        invocationId: 'inv-1',
        serial: 's-1',
        reason: 'complete',
      });
    },
    error: (reason: unknown) => {
      sessionEmitter.emit('error', reason);
    },
  };

  const tree = {
    runs: vi.fn(() => []),
    getRunNode: vi.fn(),
    getRunByCodecMessageId: vi.fn(),
    getSiblingRuns: vi.fn(() => []),
    hasSiblingRuns: vi.fn(() => false),
    // eslint-disable-next-line unicorn/no-useless-undefined -- vi.fn requires explicit undefined return for the contract
    getRegenerateGroup: vi.fn(() => undefined),
    on: vi.fn(treeEmitter.on),
  } as unknown as Tree<VercelOutput, VercelProjection>;

  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const send = vi.fn(() => Promise.resolve(mockRun));
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const regenerate = vi.fn(() => Promise.resolve(mockRun));

  // CAST: mock object satisfies the subset of View methods used by chat-transport tests
  const view = {
    getMessages: vi.fn(() => []),
    runs: vi.fn(() => []),
    hasOlder: vi.fn(() => false),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    loadOlder: vi.fn(() => Promise.resolve()),
    runOf: vi.fn(),
    run: vi.fn(),
    branchSelection: vi.fn(() => ({ hasSiblings: false, siblings: [], index: 0, selected: undefined })),
    selectSibling: vi.fn(),
    sendMessage: vi.fn(),
    sendInput: send,
    regenerate,
    edit: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-empty-function, unicorn/consistent-function-scoping -- mock returns noop unsubscribe
    on: vi.fn(() => () => {}),
    close: vi.fn(),
  } as unknown as View<VercelInput, AI.UIMessage>;

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
    on: vi.fn(sessionEmitter.on),
  } as unknown as ClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>;

  return { session, send, regenerate, cancel, close, mockRun, tree, view };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createChatTransport', () => {
  // The transport owns the agent-invocation POST; it defaults to globalThis.fetch.
  // Stub it so each test can inspect the POST (url, body, headers) and so the
  // POST succeeds (200) rather than failing against a non-existent server.
  let postCalls: { url: string; init: RequestInit }[];

  beforeEach(() => {
    postCalls = [];
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      postCalls.push({ url: urlStr, init: init ?? {} });
      return Promise.resolve(new Response(undefined, { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The transport fires the POST synchronously before returning the stream,
  // so it is recorded by the time `sendMessages` resolves.
  const postBody = (index = 0): Record<string, unknown> => {
    const call = postCalls[index];
    if (!call) throw new Error(`no POST recorded at index ${String(index)}`);
    return JSON.parse(call.init.body as string) as Record<string, unknown>;
  };
  const postHeaders = (index = 0): Record<string, string> => {
    const call = postCalls[index];
    if (!call) throw new Error(`no POST recorded at index ${String(index)}`);
    return (call.init.headers ?? {}) as Record<string, string>;
  };

  describe('sendMessages — submit-message', () => {
    it('POSTs the run invocation and sends the last message as input', async () => {
      const { session, send, view, mockRun } = createMockSession();
      const chat = createChatTransport(session);

      const m1 = makeMessage('1');
      const m2 = makeMessage('2');
      const m3 = makeMessage('3');

      (view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue([m1, m2, m3]);

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
      const [events] = send.mock.calls[0] as [VercelInput[], SendOptions];
      expect(events).toEqual([{ kind: 'user-message', message: m3 }]);

      // The transport POSTs the run's invocation pointer to wake the agent.
      // The agent reads the conversation from the channel, so the body carries
      // only the invocation identifiers — never history.
      expect(postCalls).toHaveLength(1);
      const body = postBody();
      expect(body).toMatchObject({
        runId: mockRun.runId,
        sessionName: 'chat-1',
      });
      expect(body.history).toBeUndefined();
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
    it('delegates to view.regenerate so a wire-only regenerate event is published', async () => {
      // Regenerate must route through `view.regenerate` (not `view.sendInput`)
      // so the View mints an `ait-regenerate` event. The event publishes
      // wire-only with `fork-of: A1`, `parent: U1` headers
      // — U1 is never re-published. The agent's input-event lookup catches the
      // regenerate event by its inputEventId and reads parent/forkOf from those
      // transport headers; the LLM receives history through U1 inclusive
      // via the body. Routing through `sendInput([])` would skip this
      // entirely and the agent would have no way to learn the run's
      // parent/forkOf.
      const { session, send, regenerate, mockRun } = createMockSession();
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

      expect(regenerate).toHaveBeenCalledOnce();
      expect(send).not.toHaveBeenCalled();
      const [codecMessageId] = regenerate.mock.calls[0] as [string, SendOptions];
      expect(codecMessageId).toBe('m2-id');

      // The regenerate run's invocation is POSTed to wake the agent.
      expect(postBody()).toMatchObject({
        runId: mockRun.runId,
        sessionName: 'chat-1',
      });
    });

    it('throws when regenerate-message fires without a messageId', async () => {
      const { session } = createMockSession();
      const chat = createChatTransport(session);

      await expect(
        chat.sendMessages({
          trigger: 'regenerate-message',
          chatId: 'chat-1',
          messageId: undefined,
          messages: [],
          abortSignal: undefined,
        }),
      ).rejects.toBeErrorInfo({
        code: ErrorCode.InvalidArgument,
        statusCode: 400,
        message: 'unable to regenerate; regenerate-message trigger fired without messageId',
      });
    });
  });

  describe('sendMessages — submit-message with messageId (edit)', () => {
    it('resolves fork metadata from the conversation tree', async () => {
      const { session, send, view, mockRun } = createMockSession();

      // Codec convention: TMessage.id == wire codec-message-id. The chat-transport's
      // edit path reads `messageId` (the UIMessage.id == wire codecMessageId) directly
      // as `forkOf`, and derives `parent` from the flat message list.
      const previousUser = makeMessage('parent-codec-message-id');
      const edited = makeMessage('edit-target-id');
      (view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue([previousUser, edited]);

      const chat = createChatTransport(session);

      const streamPromise = chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: 'edit-target-id',
        messages: [edited],
        abortSignal: undefined,
      });

      mockRun.close();
      await streamPromise;

      const [, opts] = send.mock.calls[0] as [AI.UIMessage[], SendOptions];
      expect(opts.forkOf).toBe('edit-target-id');
      expect(opts.parent).toBe('parent-codec-message-id');
    });

    it('falls back to raw messageId when node not found in tree', async () => {
      const { session, send, view, mockRun } = createMockSession();
      (view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue([]);

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

      (view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue([m1, edited]);

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

      const [events, opts] = send.mock.calls[0] as [VercelInput[], SendOptions];
      expect(events).toEqual([{ kind: 'user-message', message: edited }]);
      // The forkOf metadata is carried in sendOpts; the agent reads history
      // from the channel, so the POST never carries it.
      expect(opts.forkOf).toBeDefined();
      expect(postBody().history).toBeUndefined();
    });
  });

  describe('real stream return', () => {
    it('returns the run stream with chunks flowing through', async () => {
      const { session, mockRun } = createMockSession();
      const chat = createChatTransport(session);

      const stream = await chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [makeMessage('1')],
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
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [makeMessage('1')],
        abortSignal: undefined,
      });

      const error = new Error('channel continuity lost');
      mockRun.error(error);

      const reader = stream.getReader();
      await expect(reader.read()).rejects.toBe(error);
    });
  });

  describe('invocation POST failure', () => {
    it('errors the useChat stream with SessionSendFailed and leaves the run stream intact when the POST is non-OK', async () => {
      // Override the default 200 stub with a failing response.
      vi.stubGlobal(
        'fetch',
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
        vi.fn(() => Promise.resolve(new Response(undefined, { status: 500, statusText: 'Server Error' }))),
      );
      const { session, mockRun } = createMockSession();
      const chat = createChatTransport(session);

      const stream = await chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [makeMessage('1')],
        abortSignal: undefined,
      });

      // The useChat-facing stream errors with the POST failure.
      const reader = stream.getReader();
      await expect(reader.read()).rejects.toBeErrorInfo({ code: ErrorCode.SessionSendFailed });

      // The source run stream is left untouched (preventCancel) — still
      // enqueuable, so the tree/observers continue to receive events.
      expect(() => {
        mockRun.enqueue({ type: 'finish', finishReason: 'stop' });
      }).not.toThrow();
    });

    it('errors the useChat stream when the POST rejects (network error)', async () => {
      vi.stubGlobal(
        'fetch',
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock rejects directly
        vi.fn(() => Promise.reject(new Error('network down'))),
      );
      const { session } = createMockSession();
      const chat = createChatTransport(session);

      const stream = await chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [makeMessage('1')],
        abortSignal: undefined,
      });

      const reader = stream.getReader();
      await expect(reader.read()).rejects.toBeErrorInfo({ code: ErrorCode.SessionSendFailed });
    });
  });

  describe('abort signal', () => {
    it('wires to session.cancel(runId) for the run just produced', async () => {
      const { session, cancel, mockRun } = createMockSession();
      const chat = createChatTransport(session);
      const abortController = new AbortController();

      // sendMessages must resolve before the abort listener is registered
      const stream = await chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [makeMessage('1')],
        abortSignal: abortController.signal,
      });

      // Abort — the listener calls `void session.cancel(runId)` which is fire-and-forget
      abortController.abort();

      expect(cancel).toHaveBeenCalledWith(mockRun.runId);

      // Clean up
      mockRun.close();
      const reader = stream.getReader();
      await reader.read();
    });

    it('cancels the run when the signal aborts during the await before the listener attaches', async () => {
      // Repro: useChat sets `status: 'submitted'` synchronously before
      // awaiting `transport.sendMessages`. That exposes the Stop button to
      // the UI immediately. If the user clicks Stop while `sendMessages` is
      // still awaiting `session.view.sendInput(...)` (e.g. waiting for the
      // run-start ack — seconds for a real LLM), useChat fires the abort
      // *before* the adapter has the runId to attach a listener for. The
      // adapter must call `session.cancel(runId)` even when the signal is
      // already aborted by the time it gets a chance to look at it.
      const { session, cancel, mockRun, view } = createMockSession();
      const chat = createChatTransport(session);
      const abortController = new AbortController();

      // Defer the sendInput resolution so we can abort the signal while it
      // is still pending — this mirrors the run-start ack wait window.
      let resolveSend: ((run: typeof mockRun) => void) | undefined;
      const sendPromise = new Promise<typeof mockRun>((resolve) => {
        resolveSend = resolve;
      });
      (view.sendInput as ReturnType<typeof vi.fn>).mockReturnValue(sendPromise);

      const streamPromise = chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [makeMessage('1')],
        abortSignal: abortController.signal,
      });

      // Simulate the user clicking Stop while sendInput is still awaiting.
      abortController.abort();
      expect(cancel).not.toHaveBeenCalled();

      // sendInput settles after the abort — by the time the adapter sees
      // run.runId, the signal is already aborted.
      resolveSend?.(mockRun);
      const stream = await streamPromise;

      expect(cancel).toHaveBeenCalledWith(mockRun.runId);

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

      // The custom body is merged into the invocation POST (the run's
      // invocation identifiers always win), and custom headers are added.
      expect(send).toHaveBeenCalledOnce();
      const body = postBody();
      expect(body.custom).toBe('body');
      expect(body.runId).toBe(mockRun.runId);
      expect(postHeaders()['X-Custom']).toBe('header');
    });

    it('passes regenerate-message context through prepareSendMessagesRequest', async () => {
      const { session, regenerate, mockRun } = createMockSession();

      const hook = vi.fn().mockReturnValue({
        body: { customBody: 'regen' },
        headers: { 'X-Custom-Regen': 'yes' },
      });

      const chat = createChatTransport(session, { prepareSendMessagesRequest: hook });
      const m1 = makeMessage('1');
      const m2 = makeMessage('2');

      const streamPromise = chat.sendMessages({
        trigger: 'regenerate-message',
        chatId: 'chat-regen',
        messageId: m2.id,
        messages: [m1, m2],
        abortSignal: undefined,
      });

      mockRun.close();
      await streamPromise;

      // The hook fires with the regenerate-trigger context. For regenerate,
      // the chat-transport routes through view.regenerate which derives
      // forkOf/parent internally; the hook is called BEFORE that dispatch
      // so forkOf/parent are still undefined here.
      expect(hook).toHaveBeenCalledWith({
        chatId: 'chat-regen',
        trigger: 'regenerate-message',
        messageId: m2.id,
        history: [m1, m2],
        messages: [],
        forkOf: undefined,
        parent: undefined,
      });

      // The custom body/headers from the hook are applied to the invocation POST.
      expect(regenerate).toHaveBeenCalledOnce();
      const body = postBody();
      expect(body.customBody).toBe('regen');
      expect(body.runId).toBe(mockRun.runId);
      expect(postHeaders()['X-Custom-Regen']).toBe('yes');
    });
  });

  describe('default body construction', () => {
    it('POSTs only the invocation pointer — no history or messages', async () => {
      const { session, view, mockRun } = createMockSession();

      const m1 = makeMessage('1');
      const m2 = makeMessage('2');
      const m3 = makeMessage('3');
      (view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue([m1, m2, m3]);

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

      // The invocation pointer carries only identifiers — the agent reads the
      // conversation from the channel, so no history/messages are POSTed.
      const body = postBody();
      expect(body).toEqual({
        runId: mockRun.runId,
        inputEventId: mockRun.toInvocation().inputEventId,
        sessionName: 'chat-1',
      });
      expect(body.history).toBeUndefined();
      expect(body.messages).toBeUndefined();
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
    it('delegates to session.close', async () => {
      const { session, close } = createMockSession();
      const chat = createChatTransport(session);

      await chat.close();

      expect(close).toHaveBeenCalledWith();
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
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [makeMessage('1')],
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
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [makeMessage('1')],
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
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [makeMessage('1')],
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
          trigger: 'submit-message',
          chatId: 'chat-1',
          messageId: undefined,
          messages: [makeMessage('1')],
          abortSignal: undefined,
        }),
      ).rejects.toThrow('send failed');

      // streaming should never have been set to true because the error
      // occurred before wrapStreamWithDone was called
      expect(chat.streaming).toBe(false);
      expect(log).toEqual([]);
    });

    it('isolates a throwing onStreamingChange subscriber from the others', async () => {
      const { session } = createMockSession();
      const chat = createChatTransport(session);

      const log: boolean[] = [];
      chat.onStreamingChange(() => {
        throw new Error('bad subscriber');
      });
      chat.onStreamingChange((s) => log.push(s));

      // The throwing subscriber must not prevent the good one from firing or
      // block the streaming-state transition.
      await chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [makeMessage('1')],
        abortSignal: undefined,
      });

      expect(chat.streaming).toBe(true);
      expect(log).toEqual([true]);
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

      (view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue([user1, assistant]);

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

      const [events, opts] = send.mock.calls[0] as [VercelInput[], SendOptions];
      expect(events).toEqual([{ kind: 'user-message', message: user2 }]);
      expect(opts.forkOf).toBe('a1');
      expect(opts.parent).toBe('u1');
      // The agent reads history from the channel — the POST never carries it.
      expect(postBody().history).toBeUndefined();
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

      (view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue([user1, assistant]);

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
      expect(opts.forkOf).toBe('a1');
      expect(opts.parent).toBe('u1');
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

      (view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue([user1, assistant]);

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
      expect(opts.forkOf).toBe('a1');
      expect(opts.parent).toBe('u1');
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

      (view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue([user1, assistant]);

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

      const [events, opts] = send.mock.calls[0] as [VercelInput[], SendOptions];
      expect(events).toEqual([{ kind: 'user-message', message: user2 }]);
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

      (view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue([user1, assistant]);

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

      (view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue([user1, assistant, edited]);

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
      expect(opts.forkOf).toBe('u2');
      expect(opts.parent).toBe('a1');
    });
  });

  // -------------------------------------------------------------------------
  // sendMessages — continuation: codecMessageId threading
  // -------------------------------------------------------------------------

  describe('sendMessages — continuation codecMessageId', () => {
    it('passes the prior assistant tree codec-message-id as codecMessageId for a client-tool resolution', async () => {
      const { session, send, view, mockRun } = createMockSession();

      const user1 = makeMessage('u1');
      // Tree view: getLocation is unresolved (input-available).
      const treeAssistant = makeAssistantWithToolPart('a1', {
        type: 'dynamic-tool',
        toolName: 'getLocation',
        toolCallId: 'tc1',
        state: 'input-available',
        input: { highAccuracy: false },
      });
      // useChat overlay: client executed the tool, output-available.
      const overlayAssistant: AI.UIMessage = {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'intro' },
          {
            type: 'dynamic-tool',
            toolName: 'getLocation',
            toolCallId: 'tc1',
            state: 'output-available',
            input: { highAccuracy: false },
            output: { latitude: 51, longitude: 0 },
          },
        ],
      };

      (view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue([user1, treeAssistant]);
      // Continuation flow calls runOf(lastMessage.id) to find the runId.
      (view.runOf as ReturnType<typeof vi.fn>).mockReturnValue({
        runId: 'run-a1',
        clientId: '',
        status: 'active',
        invocationId: '',
      });

      const chat = createChatTransport(session);
      const streamPromise = chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        // Continuation: last message is an assistant (with a tree node) and
        // useChat's local overlay has the tool in output-available state.
        messages: [user1, overlayAssistant],
        abortSignal: undefined,
      });
      mockRun.close();
      await streamPromise;

      const [input] = send.mock.calls[0] as [VercelInput[]];

      // chat-transport passes tool-resolution inputs to view.sendInput.
      // Each input carries `codecMessageId` so the SDK stamps the wire
      // HEADER_CODEC_MESSAGE_ID to 'a1' — the reducer's direct-fold path
      // then matches by codec-message-id and folds onto the existing
      // assistant without a cross-message redirect.
      expect(input).toHaveLength(1);
      expect(input[0]?.kind).toBe('tool-result');
      expect(input[0]?.codecMessageId).toBe('a1');
    });

    it('passes the prior assistant tree codec-message-id as codecMessageId for an approval response', async () => {
      const { session, send, view, mockRun } = createMockSession();

      const user1 = makeMessage('u1');
      const treeAssistant = makeAssistantWithToolPart('a1', {
        type: 'dynamic-tool',
        toolName: 'getWeatherForecast',
        toolCallId: 'tc1',
        state: 'approval-requested',
        input: { location: 'London' },
        approval: { id: 'ap-1' },
      });
      const overlayAssistant: AI.UIMessage = {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'intro' },
          {
            type: 'dynamic-tool',
            toolName: 'getWeatherForecast',
            toolCallId: 'tc1',
            state: 'approval-responded',
            input: { location: 'London' },
            approval: { id: 'ap-1', approved: true },
          },
        ],
      };

      (view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue([user1, treeAssistant]);
      (view.runOf as ReturnType<typeof vi.fn>).mockReturnValue({
        runId: 'run-a1',
        clientId: '',
        status: 'active',
        invocationId: '',
      });

      const chat = createChatTransport(session);
      const streamPromise = chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [user1, overlayAssistant],
        abortSignal: undefined,
      });
      mockRun.close();
      await streamPromise;

      const [input] = send.mock.calls[0] as [VercelInput[]];
      expect(input).toHaveLength(1);
      expect(input[0]?.kind).toBe('tool-approval-response');
      expect(input[0]?.codecMessageId).toBe('a1');
    });
  });
});
