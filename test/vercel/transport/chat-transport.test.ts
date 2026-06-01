import * as Ably from 'ably';
import type * as AI from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Invocation } from '../../../src/core/transport/invocation.js';
import type { ClientSession, RunLifecycleEvent, SendOptions, Tree, View } from '../../../src/core/transport/types.js';
import { ErrorCode } from '../../../src/errors.js';
import type { VercelInput, VercelOutput, VercelProjection } from '../../../src/vercel/codec/index.js';
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

/**
 * A run-end lifecycle event that closes the router stream.
 * @param runId - The run id to end. Defaults to the mock run's id.
 * @returns A complete run-end lifecycle event.
 */
const runEnd = (runId = 'run-1'): RunLifecycleEvent => ({
  type: 'ai-run-end',
  runId,
  clientId: '',
  reason: 'complete',
});

const makeAssistantWithToolPart = (id: string, part: AI.DynamicToolUIPart): AI.UIMessage => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text: 'intro' }, part],
});

interface MockRun {
  runId: string;
  invocationId: string;
  cancel: ReturnType<typeof vi.fn>;
  optimisticCodecMessageIds: string[];
  /** The run's invocation pointer — POSTed by the transport to wake the agent. */
  toInvocation: () => Invocation;
}

const createMockRun = (): MockRun => {
  const cancel = vi.fn();
  return {
    runId: 'run-1',
    invocationId: 'inv-1',
    cancel,
    optimisticCodecMessageIds: [],
    toInvocation: () =>
      Invocation.fromJSON({ runId: 'run-1', invocationId: 'inv-1', inputEventId: '', sessionName: 'chat-1' }),
  };
};

interface MockSession {
  session: ClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>;
  send: ReturnType<typeof vi.fn>;
  regenerate: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  mockRun: MockRun;
  tree: Tree<VercelProjection>;
  view: View<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>;
  /** Drive a decoded output through the session's output feed. */
  emitOutput: (runId: string, output: VercelOutput) => void;
  /** Drive a per-run stream error through the session's output feed. */
  emitRunError: (runId: string, error: Ably.ErrorInfo) => void;
  /** Drive a session-wide error (no runId) through the session's error event. */
  emitSessionError: (error: Ably.ErrorInfo) => void;
  /** Fire a run lifecycle event through the tree's 'run' subscription. */
  emitRun: (event: RunLifecycleEvent) => void;
}

const createMockSession = (): MockSession => {
  const mockRun = createMockRun();

  // Output / error handlers registered by the chat-transport via
  // session.on('output') / session.on('error'). Tests drive them through
  // emitOutput / emitRunError.
  const outputHandlers = new Set<(event: { runId: string; output: VercelOutput }) => void>();
  const errorHandlers = new Set<(event: { error: Ably.ErrorInfo; runId?: string }) => void>();
  // Tree 'run' lifecycle handlers, fired by emitRun.
  const runHandlers = new Set<(event: RunLifecycleEvent) => void>();

  const tree: Tree<VercelProjection> = {
    getRunNode: vi.fn(),
    getRunByCodecMessageId: vi.fn(),
    getSiblingRuns: vi.fn(() => []),
    hasSiblingRuns: vi.fn(() => false),
    // eslint-disable-next-line unicorn/no-useless-undefined -- vi.fn requires explicit undefined return for the contract
    getRegenerateGroup: vi.fn(() => undefined),
    // CAST: the chat-transport only subscribes to the 'run' event; record
    // those handlers so tests can fire run lifecycle events.
    on: vi.fn((event: string, handler: (event: RunLifecycleEvent) => void) => {
      if (event === 'run') {
        runHandlers.add(handler);
        return () => runHandlers.delete(handler);
      }
      // eslint-disable-next-line @typescript-eslint/no-empty-function, unicorn/consistent-function-scoping -- noop unsubscribe for unused events
      return () => {};
    }) as unknown as Tree<VercelProjection>['on'],
  };

  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const send = vi.fn(() => Promise.resolve(mockRun));
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const regenerate = vi.fn(() => Promise.resolve(mockRun));

  // CAST: mock object satisfies the subset of View methods used by chat-transport tests
  const view = {
    flattenNodes: vi.fn(() => []),
    getMessages: vi.fn(() => []),
    hasOlder: vi.fn(() => false),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    loadOlder: vi.fn(() => Promise.resolve()),
    select: vi.fn(),
    getSelectedIndex: vi.fn(() => 0),
    getMessageMetadata: vi.fn(),
    getRunNode: vi.fn(),
    sendMessage: vi.fn(),
    sendInput: send,
    regenerate,
    edit: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-empty-function, unicorn/consistent-function-scoping -- mock returns noop unsubscribe
    on: vi.fn(() => () => {}),
    close: vi.fn(),
  } as unknown as View<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>;

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
    // The chat-transport subscribes to 'output' and 'error'; record those
    // handlers so tests can drive them via emitOutput / emitRunError.
    on: vi.fn((event: string, handler: (event: unknown) => void) => {
      if (event === 'output') {
        // CAST: the event discriminant guarantees the handler's payload shape.
        const cb = handler as (event: { runId: string; output: VercelOutput }) => void;
        outputHandlers.add(cb);
        return () => outputHandlers.delete(cb);
      }
      if (event === 'error') {
        // CAST: the event discriminant guarantees the handler's payload shape.
        const cb = handler as (event: { error: Ably.ErrorInfo; runId?: string }) => void;
        errorHandlers.add(cb);
        return () => errorHandlers.delete(cb);
      }
      return noop;
    }),
  } as unknown as ClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>;

  const emitOutput = (runId: string, output: VercelOutput): void => {
    for (const handler of outputHandlers) handler({ runId, output });
  };
  const emitRunError = (runId: string, error: Ably.ErrorInfo): void => {
    for (const handler of errorHandlers) handler({ error, runId });
  };
  const emitSessionError = (error: Ably.ErrorInfo): void => {
    for (const handler of errorHandlers) handler({ error });
  };
  const emitRun = (event: RunLifecycleEvent): void => {
    for (const handler of runHandlers) handler(event);
  };

  return {
    session,
    send,
    regenerate,
    cancel,
    close,
    mockRun,
    tree,
    view,
    emitOutput,
    emitRunError,
    emitSessionError,
    emitRun,
  };
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

      (view.flattenNodes as ReturnType<typeof vi.fn>).mockReturnValue([
        { message: m1, codecMessageId: 'n1', parentId: undefined, forkOf: undefined, headers: {}, serial: undefined },
        { message: m2, codecMessageId: 'n2', parentId: 'n1', forkOf: undefined, headers: {}, serial: undefined },
        { message: m3, codecMessageId: 'n3', parentId: 'n2', forkOf: undefined, headers: {}, serial: undefined },
      ]);

      // sendMessages resolves once the wrapped stream is returned, independent
      // of whether the source closes — these assertions inspect the send call,
      // not the stream contents, so no run-end is needed.
      await chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [m1, m2, m3],
        abortSignal: undefined,
      });

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
        invocationId: mockRun.invocationId,
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

      // Inspects the send call, not stream contents — the router stream is
      // left open (sendMessages resolves once the wrapped stream is returned).
      await streamPromise;

      expect(regenerate).toHaveBeenCalledOnce();
      expect(send).not.toHaveBeenCalled();
      const [codecMessageId] = regenerate.mock.calls[0] as [string, SendOptions];
      expect(codecMessageId).toBe('m2-id');

      // The regenerate run's invocation is POSTed to wake the agent.
      expect(postBody()).toMatchObject({
        runId: mockRun.runId,
        invocationId: mockRun.invocationId,
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
      const { session, send, view } = createMockSession();

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

      // Inspects the send call, not stream contents — the router stream is
      // left open (sendMessages resolves once the wrapped stream is returned).
      await streamPromise;

      const [, opts] = send.mock.calls[0] as [AI.UIMessage[], SendOptions];
      expect(opts.forkOf).toBe('edit-target-id');
      expect(opts.parent).toBe('parent-codec-message-id');
    });

    it('falls back to raw messageId when node not found in tree', async () => {
      const { session, send, view } = createMockSession();
      (view.flattenNodes as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const chat = createChatTransport(session);

      const streamPromise = chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: 'unknown-id',
        messages: [makeMessage('1')],
        abortSignal: undefined,
      });

      // Inspects the send call, not stream contents — the router stream is
      // left open (sendMessages resolves once the wrapped stream is returned).
      await streamPromise;

      const [, opts] = send.mock.calls[0] as [AI.UIMessage[], SendOptions];
      expect(opts.forkOf).toBe('unknown-id');
      expect(opts.parent).toBeUndefined();
    });

    it('sends the edited message as new and prior messages as history', async () => {
      const { session, send, view } = createMockSession();

      const m1 = makeMessage('1');
      const edited = makeMessage('2');

      (view.flattenNodes as ReturnType<typeof vi.fn>).mockReturnValue([
        { message: m1, codecMessageId: 'n1', parentId: undefined, forkOf: undefined, headers: {}, serial: undefined },
        { message: edited, codecMessageId: 'n2', parentId: 'n1', forkOf: undefined, headers: {}, serial: undefined },
      ]);

      const chat = createChatTransport(session);

      const streamPromise = chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: '2',
        messages: [m1, edited],
        abortSignal: undefined,
      });

      // Inspects the send call, not stream contents — the router stream is
      // left open (sendMessages resolves once the wrapped stream is returned).
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
      const { session, emitOutput } = createMockSession();
      const chat = createChatTransport(session);

      const stream = await chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [makeMessage('1')],
        abortSignal: undefined,
      });

      // Drive chunks through the output feed. The terminal `finish` chunk
      // makes the router self-close the stream (isTerminal predicate).
      emitOutput('run-1', { type: 'start', messageId: 'msg-1' });
      emitOutput('run-1', { type: 'text-start', id: 'text-1' });
      emitOutput('run-1', { type: 'text-delta', id: 'text-1', delta: 'Hello' });
      emitOutput('run-1', { type: 'finish', finishReason: 'stop' });

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
      const { session, emitRunError } = createMockSession();
      const chat = createChatTransport(session);

      const stream = await chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [makeMessage('1')],
        abortSignal: undefined,
      });

      const error = new Ably.ErrorInfo('channel continuity lost', 50000, 500);
      emitRunError('run-1', error);

      const reader = stream.getReader();
      await expect(reader.read()).rejects.toBe(error);
    });

    it('errors the returned stream when the run ends with reason error', async () => {
      const { session, emitRun } = createMockSession();
      const chat = createChatTransport(session);

      const stream = await chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [makeMessage('1')],
        abortSignal: undefined,
      });

      // Agent mid-run error arrives on the run-end lifecycle event (not the
      // run-error feed), carrying the reified error.
      const error = new Ably.ErrorInfo('agent blew up', 50000, 500);
      emitRun({ type: 'ai-run-end', runId: 'run-1', clientId: '', reason: 'error', error });

      const reader = stream.getReader();
      await expect(reader.read()).rejects.toBe(error);
    });

    it('does not error the stream for a session-wide error (no runId)', async () => {
      const { session, emitSessionError, emitOutput } = createMockSession();
      const chat = createChatTransport(session);

      const stream = await chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [makeMessage('1')],
        abortSignal: undefined,
      });

      emitOutput('run-1', { type: 'text-start', id: 'text-1' });
      // A session-wide error (no runId) — e.g. a decode-loop fault or an agent
      // mid-run error's run-id-less notification — must NOT reject this run's
      // stream; it's not stream-scoped.
      emitSessionError(new Ably.ErrorInfo('session-wide blip', 50000, 500));
      // The run then completes normally and the stream closes cleanly.
      emitOutput('run-1', { type: 'finish', finishReason: 'stop' });

      const reader = stream.getReader();
      const chunks: AI.UIMessageChunk[] = [];
      let result = await reader.read();
      while (!result.done) {
        chunks.push(result.value);
        result = await reader.read();
      }
      expect(chunks.map((c) => c.type)).toEqual(['text-start', 'finish']);
    });
  });

  describe('invocation POST failure', () => {
    it('errors the useChat stream with SessionSendFailed when the POST is non-OK', async () => {
      // Override the default 200 stub with a failing response.
      vi.stubGlobal(
        'fetch',
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
        vi.fn(() => Promise.resolve(new Response(undefined, { status: 500, statusText: 'Server Error' }))),
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

      // The POST failure rejects the useChat-facing stream via the wrapper's
      // `fail()`. The router source is left open (preventCancel) so the
      // tree/observers continue to receive events.
      const reader = stream.getReader();
      await expect(reader.read()).rejects.toBeErrorInfo({ code: ErrorCode.SessionSendFailed });
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

  describe('suspend keeps the stream open', () => {
    it('does not close the stream on a suspended run-end, so a resume keeps feeding it', async () => {
      const { session, emitOutput, emitRun } = createMockSession();
      const chat = createChatTransport(session);

      const stream = await chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [makeMessage('1')],
        abortSignal: undefined,
      });

      emitOutput('run-1', { type: 'text-start', id: 'text-1' });
      // Suspend (e.g. awaiting a tool result) must NOT close the stream.
      emitRun({ type: 'ai-run-end', runId: 'run-1', clientId: '', reason: 'suspended' });
      // The resume continues feeding the same stream, then completes.
      emitOutput('run-1', { type: 'text-delta', id: 'text-1', delta: 'resumed' });
      emitOutput('run-1', { type: 'finish', finishReason: 'stop' });

      const reader = stream.getReader();
      const chunks: AI.UIMessageChunk[] = [];
      let result = await reader.read();
      while (!result.done) {
        chunks.push(result.value);
        result = await reader.read();
      }

      expect(chunks.map((c) => c.type)).toEqual(['text-start', 'text-delta', 'finish']);
    });
  });

  describe('abort signal', () => {
    it('wires to session.cancel(runId) for the run just produced', async () => {
      const { session, cancel, mockRun, emitRun } = createMockSession();
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
      emitRun(runEnd());
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

      // The adapter creates the stream BEFORE wiring the abort handler, so the
      // already-aborted path closes a real stream: the returned stream
      // completes immediately without waiting for a run-end echo.
      const reader = stream.getReader();
      const result = await reader.read();
      expect(result.done).toBe(true);
    });

    it('closes the returned stream when the run is aborted', async () => {
      const { session, cancel, mockRun, emitOutput } = createMockSession();
      const chat = createChatTransport(session);
      const abortController = new AbortController();

      const stream = await chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [makeMessage('1')],
        abortSignal: abortController.signal,
      });

      // Emit some chunks before the abort — these must reach the consumer.
      emitOutput('run-1', { type: 'start', messageId: 'msg-1' });
      emitOutput('run-1', { type: 'text-delta', id: 'text-1', delta: 'partial' });

      // Abort: the adapter cancels the run AND closes its own router stream so
      // the consumer sees end-of-input immediately rather than hanging.
      abortController.abort();

      expect(cancel).toHaveBeenCalledWith(mockRun.runId);

      // Draining the returned stream completes cleanly with the pre-abort
      // chunks and no error.
      const reader = stream.getReader();
      const chunks: AI.UIMessageChunk[] = [];
      let result = await reader.read();
      while (!result.done) {
        chunks.push(result.value);
        result = await reader.read();
      }
      expect(chunks.map((c) => c.type)).toEqual(['start', 'text-delta']);
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

      // Inspects the send call, not stream contents — the router stream is
      // left open (sendMessages resolves once the wrapped stream is returned).
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

      // Inspects the send call, not stream contents — the router stream is
      // left open (sendMessages resolves once the wrapped stream is returned).
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
      (view.flattenNodes as ReturnType<typeof vi.fn>).mockReturnValue([
        {
          message: m1,
          codecMessageId: 'h1',
          parentId: undefined,
          forkOf: undefined,
          headers: { 'codec-message-id': 'h1' },
          serial: undefined,
        },
        {
          message: m2,
          codecMessageId: 'h2',
          parentId: 'h1',
          forkOf: undefined,
          headers: { 'codec-message-id': 'h2' },
          serial: undefined,
        },
        {
          message: m3,
          codecMessageId: 'h3',
          parentId: 'h2',
          forkOf: undefined,
          headers: { 'codec-message-id': 'h3' },
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

      // Inspects the send call, not stream contents — the router stream is
      // left open (sendMessages resolves once the wrapped stream is returned).
      await streamPromise;

      // The invocation pointer carries only identifiers — the agent reads the
      // conversation from the channel, so no history/messages are POSTed.
      const body = postBody();
      expect(body).toEqual({
        runId: mockRun.runId,
        invocationId: mockRun.invocationId,
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
      const { session, emitRun } = createMockSession();
      const chat = createChatTransport(session);

      const stream = await chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [makeMessage('1')],
        abortSignal: undefined,
      });

      expect(chat.streaming).toBe(true);

      // End the run so the router closes the stream, then drain it
      emitRun(runEnd());
      const reader = stream.getReader();
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        // drain
      }

      // Allow microtasks (pipeTo completion + done.then) to settle
      await new Promise((r) => setTimeout(r, 0));
      expect(chat.streaming).toBe(false);
    });

    it('onStreamingChange fires on transitions', async () => {
      const { session, emitRun } = createMockSession();
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

      emitRun(runEnd());
      const reader = stream.getReader();
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        // drain
      }
      await new Promise((r) => setTimeout(r, 0));

      expect(log).toEqual([true, false]);

      unsub();
    });

    it('streaming resets to false when the consumer cancels the stream', async () => {
      const { session, emitOutput } = createMockSession();
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

      // Push one chunk, then cancel the reader — pipeTo aborts, which
      // resolves `done` and clears the streaming flag.
      emitOutput('run-1', { type: 'text-start', id: 'text-1' });

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
  });

  // -------------------------------------------------------------------------
  // Fork-on-unresolved-tool
  // -------------------------------------------------------------------------

  describe('sendMessages — fork on unresolved tool call', () => {
    it('forks off the preceding assistant when it has approval-requested', async () => {
      const { session, send, view } = createMockSession();

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
      // Inspects the send call, not stream contents — the router stream is
      // left open (sendMessages resolves once the wrapped stream is returned).
      await streamPromise;

      const [events, opts] = send.mock.calls[0] as [VercelInput[], SendOptions];
      expect(events).toEqual([{ kind: 'user-message', message: user2 }]);
      expect(opts.forkOf).toBe('a1');
      expect(opts.parent).toBe('u1');
      // The agent reads history from the channel — the POST never carries it.
      expect(postBody().history).toBeUndefined();
    });

    it('forks when the preceding assistant has input-available (client tool pending)', async () => {
      const { session, send, view } = createMockSession();

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
      // Inspects the send call, not stream contents — the router stream is
      // left open (sendMessages resolves once the wrapped stream is returned).
      await streamPromise;

      const [, opts] = send.mock.calls[0] as [AI.UIMessage[], SendOptions];
      expect(opts.forkOf).toBe('a1');
      expect(opts.parent).toBe('u1');
    });

    it('forks when the preceding assistant has input-streaming', async () => {
      const { session, send, view } = createMockSession();

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
      // Inspects the send call, not stream contents — the router stream is
      // left open (sendMessages resolves once the wrapped stream is returned).
      await streamPromise;

      const [, opts] = send.mock.calls[0] as [AI.UIMessage[], SendOptions];
      expect(opts.forkOf).toBe('a1');
      expect(opts.parent).toBe('u1');
    });

    it('does NOT fork when the preceding assistant has output-available (resolved)', async () => {
      const { session, send, view } = createMockSession();

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
        {
          message: user1,
          codecMessageId: 'wire-u1',
          parentId: undefined,
          forkOf: undefined,
          headers: {},
          serial: undefined,
        },
        {
          message: assistant,
          codecMessageId: 'wire-a1',
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
      // Inspects the send call, not stream contents — the router stream is
      // left open (sendMessages resolves once the wrapped stream is returned).
      await streamPromise;

      const [events, opts] = send.mock.calls[0] as [VercelInput[], SendOptions];
      expect(events).toEqual([{ kind: 'user-message', message: user2 }]);
      expect(opts.forkOf).toBeUndefined();
      expect(opts.parent).toBeUndefined();
    });

    it('does NOT fork when the preceding assistant has approval-responded', async () => {
      const { session, send, view } = createMockSession();

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
        {
          message: user1,
          codecMessageId: 'wire-u1',
          parentId: undefined,
          forkOf: undefined,
          headers: {},
          serial: undefined,
        },
        {
          message: assistant,
          codecMessageId: 'wire-a1',
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
      // Inspects the send call, not stream contents — the router stream is
      // left open (sendMessages resolves once the wrapped stream is returned).
      await streamPromise;

      const [, opts] = send.mock.calls[0] as [AI.UIMessage[], SendOptions];
      expect(opts.forkOf).toBeUndefined();
      expect(opts.parent).toBeUndefined();
    });

    it('does NOT fork in edit mode (messageId takes priority over preceding unresolved tool)', async () => {
      const { session, send, view } = createMockSession();

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
      // Inspects the send call, not stream contents — the router stream is
      // left open (sendMessages resolves once the wrapped stream is returned).
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
      const { session, send, view } = createMockSession();

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
      // Continuation flow calls getMessageMetadata(lastMessage.id) to find the runId.
      (view.getMessageMetadata as ReturnType<typeof vi.fn>).mockReturnValue({
        codecMessageId: treeAssistant.id,
        runId: 'run-a1',
        clientId: '',
        status: 'streaming',
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
      // Inspects the send call, not stream contents — the router stream is
      // left open (sendMessages resolves once the wrapped stream is returned).
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
      const { session, send, view } = createMockSession();

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
      (view.getMessageMetadata as ReturnType<typeof vi.fn>).mockReturnValue({
        codecMessageId: treeAssistant.id,
        runId: 'run-a1',
        clientId: '',
        status: 'streaming',
      });

      const chat = createChatTransport(session);
      const streamPromise = chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [user1, overlayAssistant],
        abortSignal: undefined,
      });
      // Inspects the send call, not stream contents — the router stream is
      // left open (sendMessages resolves once the wrapped stream is returned).
      await streamPromise;

      const [input] = send.mock.calls[0] as [VercelInput[]];
      expect(input).toHaveLength(1);
      expect(input[0]?.kind).toBe('tool-approval-response');
      expect(input[0]?.codecMessageId).toBe('a1');
    });
  });
});
