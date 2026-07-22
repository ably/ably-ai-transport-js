import type * as AI from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CodecMessage } from '../../../src/core/codec/types.js';
import { Invocation } from '../../../src/core/transport/invocation.js';
import type { ClientSession, ClientView, SendOptions, Tree } from '../../../src/core/transport/types.js';
import { ErrorCode } from '../../../src/errors.js';
import type { VercelInput, VercelOutput, VercelProjection } from '../../../src/vercel/codec/index.js';
import type { ChatTransportOptions } from '../../../src/vercel/transport/chat-transport.js';
import { createChatTransport } from '../../../src/vercel/transport/chat-transport.js';
import { toBeErrorInfo } from '../../helper/expectations.js';
import { drain, flushMicrotasks } from '../../helper/streams.js';

expect.extend({ toBeErrorInfo });

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const makeMessage = (id: string, role: AI.UIMessage['role'] = 'user'): AI.UIMessage => ({
  id,
  role,
  parts: [],
});

// View.getMessages() returns each message paired with its codec-message-id.
// These fixtures use messages whose domain id equals the codec-message-id;
// the divergent-id case is set explicitly per test.
const asPairs = (messages: AI.UIMessage[]): CodecMessage<AI.UIMessage>[] =>
  messages.map((message) => ({ codecMessageId: message.id, message }));

const makeAssistantWithToolPart = (id: string, part: AI.DynamicToolUIPart): AI.UIMessage => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text: 'intro' }, part],
});

// Tree + overlay where the only tool call is ALREADY resolved on both sides, so
// deriveContinuationInputs returns []. runOf reports the run suspended, awaiting
// the continuation the other tab drives. Used by the defer-and-observe tests.
const setupResolvedContinuation = (mock: ReturnType<typeof createMockSession>): { messages: AI.UIMessage[] } => {
  const user1 = makeMessage('u1');
  const treeAssistant = makeAssistantWithToolPart('a1', {
    type: 'dynamic-tool',
    toolName: 'getLocation',
    toolCallId: 'tc1',
    state: 'output-available',
    input: {},
    output: { latitude: 51, longitude: 0 },
  });
  const overlayAssistant: AI.UIMessage = {
    id: 'a1',
    role: 'assistant',
    parts: [
      {
        type: 'dynamic-tool',
        toolName: 'getLocation',
        toolCallId: 'tc1',
        state: 'output-available',
        input: {},
        output: { latitude: 99, longitude: 9 },
      },
    ],
  };
  (mock.view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue(asPairs([user1, treeAssistant]));
  (mock.view.runOf as ReturnType<typeof vi.fn>).mockReturnValue({
    runId: 'run-1',
    clientId: '',
    status: 'suspended',
    invocationId: '',
  });
  return { messages: [user1, overlayAssistant] };
};

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
  inputCodecMessageId: string;
  runId: string;
  started: Promise<void>;
  inputEventId: string;
  cancel: ReturnType<typeof vi.fn>;
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
  view: ClientView<VercelInput, AI.UIMessage>;
}

const createMockSession = (): MockSession => {
  const treeEmitter = makeEmitter();
  const sessionEmitter = makeEmitter();
  const runId = 'run-1';
  // The triggering input's codec-message-id — the synchronous routing key the
  // consumer stream is built on (the agent mints the run-id separately).
  const inputCodecMessageId = 'input-1';

  const mockRun: MockRun = {
    inputCodecMessageId,
    runId,
    started: Promise.resolve(),
    inputEventId: '',
    cancel: vi.fn(),
    toInvocation: () => Invocation.fromJSON({ inputEventId: '', sessionName: 'chat-1' }),
    enqueue: (chunk: AI.UIMessageChunk) => {
      // Route by the triggering input id — the key the consumer stream opens on.
      treeEmitter.emit('output', {
        runId,
        inputCodecMessageId,
        codecMessageId: 'm-1',
        serial: 's-1',
        events: [chunk],
      });
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
    getRunNode: vi.fn(),
    getNodeByCodecMessageId: vi.fn(),
    getSiblingNodes: vi.fn(() => []),
    on: vi.fn(treeEmitter.on),
  } as unknown as Tree<VercelOutput, VercelProjection>;

  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const send = vi.fn(() => Promise.resolve(mockRun));
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const regenerate = vi.fn(() => Promise.resolve(mockRun));

  // CAST: mock object satisfies the subset of View methods used by chat-transport tests
  const getMessages = vi.fn((): CodecMessage<AI.UIMessage>[] => []);
  const view = {
    getMessages,
    runs: vi.fn(() => []),
    hasOlder: vi.fn(() => false),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    loadOlder: vi.fn(() => Promise.resolve([])),
    runOf: vi.fn(),
    run: vi.fn(),
    branchSelection: vi.fn(() => ({
      hasSiblings: false,
      siblings: [],
      index: 0,
      selected: undefined,
      select: vi.fn(),
    })),
    send: send,
    regenerate,
    edit: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-empty-function, unicorn/consistent-function-scoping -- mock returns noop unsubscribe
    on: vi.fn(() => () => {}),
    close: vi.fn(),
  } as unknown as ClientView<VercelInput, AI.UIMessage>;

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

// Drive one continuation through the chat transport (a useChat auto-submit after
// a client tool result): submit-message whose last overlay message is the
// tracked assistant carrying the executed tool.
const sendContinuation = async (mock: ReturnType<typeof createMockSession>, overlay: AI.UIMessage[]): Promise<void> => {
  const chat = createChatTransport(mock.session);
  await chat.sendMessages({
    trigger: 'submit-message',
    chatId: 'chat-1',
    messageId: undefined,
    messages: overlay,
    abortSignal: undefined,
  });
};

// The send options a tab's continuation dispatched with.
const sendOptsOf = (mock: ReturnType<typeof createMockSession>): SendOptions | undefined => {
  const call = mock.send.mock.calls[0] as [VercelInput[], SendOptions] | undefined;
  return call?.[1];
};

// The fork branch a tab's continuation opened — identified by the fork
// tool-result's target codec-message-id (the client-owned optimistic reply-run
// key the agent reconciles to its minted run-id), since the fork is run-less.
const forkTargetOf = (mock: ReturnType<typeof createMockSession>): string | undefined => {
  const call = mock.send.mock.calls[0] as [VercelInput[], SendOptions] | undefined;
  const toolResult = call?.[0].find(
    (input): input is Extract<VercelInput, { kind: 'tool-result' }> => input.kind === 'tool-result',
  );
  return toolResult?.codecMessageId;
};

// The tool-result output a tab's continuation carried.
const resultOutputOf = (mock: ReturnType<typeof createMockSession>): unknown => {
  const call = mock.send.mock.calls[0] as [VercelInput[], SendOptions] | undefined;
  const toolResult = call?.[0].find(
    (input): input is Extract<VercelInput, { kind: 'tool-result' }> => input.kind === 'tool-result',
  );
  return toolResult?.payload.output;
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

      (view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue(asPairs([m1, m2, m3]));

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
      // Regenerate must route through `view.regenerate` (not `view.send`)
      // so the View mints an `ait-regenerate` event. The event publishes
      // wire-only with `fork-of: A1`, `parent: U1` headers
      // — U1 is never re-published. The agent's input-event lookup catches the
      // regenerate event by its inputEventId and reads parent/forkOf from those
      // transport headers; the LLM receives history through U1 inclusive
      // via the body. Routing through `send([])` would skip this
      // entirely and the agent would have no way to learn the run's
      // parent/forkOf.
      const { session, send, regenerate, view, mockRun } = createMockSession();
      const chat = createChatTransport(session);

      const m1 = makeMessage('1');
      const m2 = makeMessage('m2-id', 'assistant');
      // The regenerate target must be resolvable in the visible view so the
      // transport can route by its codec-message-id (here id == codec id).
      (view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue(asPairs([m1, m2]));

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
        sessionName: 'chat-1',
      });
    });

    it('routes regenerate by codec-message-id when it differs from the domain id', async () => {
      const { session, regenerate, view, mockRun } = createMockSession();
      const chat = createChatTransport(session);

      const m1 = makeMessage('1');
      const m2 = makeMessage('a2', 'assistant');
      // useChat references the assistant by its domain id 'a2'; the transport
      // must regenerate by its codec-message-id 'codec-a2'.
      (view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue([
        { codecMessageId: 'codec-1', message: m1 },
        { codecMessageId: 'codec-a2', message: m2 },
      ]);

      const streamPromise = chat.sendMessages({
        trigger: 'regenerate-message',
        chatId: 'chat-1',
        messageId: 'a2',
        messages: [m1, m2],
        abortSignal: undefined,
      });
      mockRun.close();
      await streamPromise;

      const [codecMessageId] = regenerate.mock.calls[0] as [string, SendOptions];
      expect(codecMessageId).toBe('codec-a2');
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

      // The edit path resolves `forkOf` = the edit target's codec-message-id
      // (via `codecIdOf(messageId)`) and `parent` = the predecessor's
      // codec-message-id. This fixture keeps `message.id == codec-message-id`,
      // so those resolve to the same string values; the divergent case is
      // covered by the test below.
      const previousUser = makeMessage('parent-codec-message-id');
      const edited = makeMessage('edit-target-id');
      (view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue(asPairs([previousUser, edited]));

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

    it('resolves edit fork metadata by codec-message-id when it differs from the domain id', async () => {
      const { session, send, view, mockRun } = createMockSession();

      const previousUser = makeMessage('u1');
      const edited = makeMessage('edit-target-id');
      // Domain ids differ from the codec-message-ids the transport must route on.
      (view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue([
        { codecMessageId: 'codec-prev', message: previousUser },
        { codecMessageId: 'codec-edit', message: edited },
      ]);

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
      expect(opts.forkOf).toBe('codec-edit');
      expect(opts.parent).toBe('codec-prev');
    });

    it('leaves forkOf undefined when the edit target is not in the visible tree', async () => {
      const { session, send, view, mockRun } = createMockSession();
      (view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue(asPairs([]));

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

      // The target isn't visible, so there is no codec-message-id to fork
      // from — the transport does NOT fabricate one from the domain id.
      const [, opts] = send.mock.calls[0] as [AI.UIMessage[], SendOptions];
      expect(opts.forkOf).toBeUndefined();
      expect(opts.parent).toBeUndefined();
    });

    it('sends the edited message as new and prior messages as history', async () => {
      const { session, send, view, mockRun } = createMockSession();

      const m1 = makeMessage('1');
      const edited = makeMessage('2');

      (view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue(asPairs([m1, edited]));

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
    it('wires to run.cancel() for the run just produced', async () => {
      const { session, mockRun } = createMockSession();
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

      // Abort — the listener calls `void run.cancel()` (the run handle knows its
      // own key / agent-minted runId) which is fire-and-forget.
      abortController.abort();

      expect(mockRun.cancel).toHaveBeenCalled();

      // Clean up
      mockRun.close();
      const reader = stream.getReader();
      await reader.read();
    });

    it('cancels the run when the signal aborts during the await before the listener attaches', async () => {
      // Repro: useChat sets `status: 'submitted'` synchronously before
      // awaiting `transport.sendMessages`. That exposes the Stop button to
      // the UI immediately. If the user clicks Stop while `sendMessages` is
      // still awaiting `session.view.send(...)` (e.g. waiting for the
      // run-start ack — seconds for a real LLM), useChat fires the abort
      // *before* the adapter has the runId to attach a listener for. The
      // adapter must call `session.cancel(runId)` even when the signal is
      // already aborted by the time it gets a chance to look at it.
      const { session, mockRun, view } = createMockSession();
      const chat = createChatTransport(session);
      const abortController = new AbortController();

      // Defer the send resolution so we can abort the signal while it
      // is still pending — this mirrors the run-start ack wait window.
      let resolveSend: ((run: typeof mockRun) => void) | undefined;
      const sendPromise = new Promise<typeof mockRun>((resolve) => {
        resolveSend = resolve;
      });
      (view.send as ReturnType<typeof vi.fn>).mockReturnValue(sendPromise);

      const streamPromise = chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [makeMessage('1')],
        abortSignal: abortController.signal,
      });

      // Simulate the user clicking Stop while send is still awaiting.
      abortController.abort();
      expect(mockRun.cancel).not.toHaveBeenCalled();

      // send settles after the abort — by the time the adapter sees
      // run.runId, the signal is already aborted.
      resolveSend?.(mockRun);
      const stream = await streamPromise;

      expect(mockRun.cancel).toHaveBeenCalled();

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
      expect(body.inputEventId).toBe(mockRun.toInvocation().inputEventId);
      expect(postHeaders()['X-Custom']).toBe('header');
    });

    it('passes regenerate-message context through prepareSendMessagesRequest', async () => {
      const { session, regenerate, view, mockRun } = createMockSession();

      const hook = vi.fn().mockReturnValue({
        body: { customBody: 'regen' },
        headers: { 'X-Custom-Regen': 'yes' },
      });

      const chat = createChatTransport(session, { prepareSendMessagesRequest: hook });
      const m1 = makeMessage('1');
      const m2 = makeMessage('2');
      // The regenerate target must be resolvable in the visible view.
      (view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue(asPairs([m1, m2]));

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
      expect(body.inputEventId).toBe(mockRun.toInvocation().inputEventId);
      expect(postHeaders()['X-Custom-Regen']).toBe('yes');
    });
  });

  describe('default body construction', () => {
    it('POSTs only the invocation pointer — no history or messages', async () => {
      const { session, view, mockRun } = createMockSession();

      const m1 = makeMessage('1');
      const m2 = makeMessage('2');
      const m3 = makeMessage('3');
      (view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue(asPairs([m1, m2, m3]));

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

      // Let the run-id resolve (`run.started`) before run-end — mirrors
      // production, where run-start is observed before run-end, so the
      // run-end safety-net knows the run-id it must match.
      await new Promise((r) => setTimeout(r, 0));

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

      // Let the run-id resolve (`run.started`) before run-end — mirrors
      // production, where run-start is observed before run-end, so the
      // run-end safety-net knows the run-id it must match.
      await new Promise((r) => setTimeout(r, 0));

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

      (view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue(asPairs([user1, assistant]));

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

      (view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue(asPairs([user1, assistant]));

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

      (view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue(asPairs([user1, assistant]));

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

      (view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue(asPairs([user1, assistant]));

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

      (view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue(asPairs([user1, assistant]));

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

      (view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue(asPairs([user1, assistant, edited]));

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

  describe('sendMessages — continuation forks a client-tool resolution', () => {
    it('forks into a fresh reply run, reconstructing the tool-call assistant from a seed', async () => {
      const { session, send, view, tree, mockRun } = createMockSession();

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

      (view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue(asPairs([user1, treeAssistant]));
      // Continuation flow resolves the suspended run by the assistant's
      // codec-message-id; the fork then reads the run node for its parent.
      (view.runOf as ReturnType<typeof vi.fn>).mockReturnValue({
        runId: 'run-suspended',
        clientId: 'user-a',
        status: 'suspended',
        invocationId: '',
      });
      (tree.getRunNode as ReturnType<typeof vi.fn>).mockReturnValue({
        kind: 'run',
        runId: 'run-suspended',
        parentCodecMessageId: 'u1',
        state: { status: 'suspended' },
        // The suspended run's projection — the source of the fork seed. Here the
        // run holds its single tool-call assistant (getLocation, unresolved).
        projection: { messages: asPairs([treeAssistant]), trackers: new Map(), pendingToolResolutions: [] },
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

      const [input, opts] = send.mock.calls[0] as [VercelInput[], SendOptions];

      // A client tool result forks: the resolution opens its OWN reply run so
      // concurrent answers segregate. It addresses a FRESH codec-message-id (not
      // the tree assistant's) and carries a `forkSeed` — the suspended run's full
      // message list under fresh ids — so the fork run's reducer reconstructs
      // that run before folding this result.
      expect(input).toHaveLength(1);
      expect(input[0]?.kind).toBe('tool-result');
      expect(input[0]?.codecMessageId).toBeDefined();
      expect(input[0]?.codecMessageId).not.toBe('a1');
      const toolResult = input[0]?.kind === 'tool-result' ? input[0] : undefined;
      // The seed carries the suspended run's message list; the single message is
      // the tool-call assistant (domain id 'a1') under a fresh codec-message-id.
      expect(toolResult?.payload.forkSeed?.messages).toHaveLength(1);
      const seedMsg = toolResult?.payload.forkSeed?.messages[0];
      expect(seedMsg?.message.id).toBe('a1');
      expect(seedMsg?.message.parts).toContainEqual(
        expect.objectContaining({ type: 'dynamic-tool', toolCallId: 'tc1', state: 'input-available' }),
      );
      // The result targets the fresh id of the seed message carrying tc1.
      expect(input[0]?.codecMessageId).toBe(seedMsg?.codecMessageId);
      // The fork is published RUN-LESS (the agent mints the fork's run-id, not
      // the client), rooted at the suspended run's own input node so it is a
      // same-parent sibling, and marked role:'assistant' so the tree treats the
      // run-less input as a reply run rather than a user input node.
      expect(opts.runId).toBeUndefined();
      expect(opts.parent).toBe('u1');
      expect(opts.role).toBe('assistant');
    });

    it('resolves the fork parent from the suspended run by codec-message-id, never the domain id', async () => {
      const { session, send, view, tree, mockRun } = createMockSession();

      const user1 = makeMessage('u1');
      // The assistant's domain id ('a1', preserved from the stream) is NOT its
      // codec-message-id ('codec-a1', the SDK's minted correlation id). The
      // transport must route by the codec-message-id, never the domain id.
      const treeAssistant = makeAssistantWithToolPart('a1', {
        type: 'dynamic-tool',
        toolName: 'getLocation',
        toolCallId: 'tc1',
        state: 'input-available',
        input: {},
      });
      const overlayAssistant: AI.UIMessage = {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'dynamic-tool',
            toolName: 'getLocation',
            toolCallId: 'tc1',
            state: 'output-available',
            input: {},
            output: { ok: true },
          },
        ],
      };

      (view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue([
        { codecMessageId: 'codec-u1', message: user1 },
        { codecMessageId: 'codec-a1', message: treeAssistant },
      ]);
      // runOf resolves the suspended run ONLY when queried by the
      // codec-message-id — a lookup by the domain id 'a1' would miss.
      (view.runOf as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
        id === 'codec-a1'
          ? { runId: 'run-suspended', clientId: 'user-a', status: 'suspended', invocationId: '' }
          : undefined,
      );
      (tree.getRunNode as ReturnType<typeof vi.fn>).mockImplementation((runId: string) =>
        runId === 'run-suspended'
          ? {
              kind: 'run',
              runId: 'run-suspended',
              parentCodecMessageId: 'codec-u1',
              state: { status: 'suspended' },
              // The suspended run's projection — the fork seed source (the
              // tool-call assistant, keyed on its codec-message-id 'codec-a1').
              projection: {
                messages: [{ codecMessageId: 'codec-a1', message: treeAssistant }],
                trackers: new Map(),
                pendingToolResolutions: [],
              },
            }
          : undefined,
      );

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

      // The fork's parent is the suspended run's input node ('codec-u1'),
      // resolved via runOf keyed on 'codec-a1' → getRunNode('run-suspended') —
      // never the domain id 'a1'. The fork is run-less (the agent mints the
      // run-id) and addresses a fresh assistant codec-message-id.
      const [input, opts] = send.mock.calls[0] as [VercelInput[], SendOptions];
      expect(opts.parent).toBe('codec-u1');
      expect(opts.runId).toBeUndefined();
      expect(opts.role).toBe('assistant');
      expect(input[0]?.codecMessageId).not.toBe('codec-a1');
      expect(input[0]?.codecMessageId).not.toBe('a1');
    });

    // useChat's `addToolApprovalResponse` sets the overlay part to
    // `approval-responded` for both approve and deny; the decision lives in
    // `approval.approved`, which the derived `tool-approval-response` must
    // carry. The response targets the prior assistant's tree codec-message-id.
    it.each([
      { label: 'an approval', approved: true, reason: undefined },
      { label: 'a denial', approved: false, reason: 'User denied' },
    ])(
      'derives $label carrying approved=$approved, with the prior assistant tree codec-message-id',
      async ({ approved, reason }) => {
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
              approval: { id: 'ap-1', approved, ...(reason === undefined ? {} : { reason }) },
            },
          ],
        };

        (view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue(asPairs([user1, treeAssistant]));
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
        expect(input[0]).toMatchObject({
          kind: 'tool-approval-response',
          codecMessageId: 'a1',
          payload: {
            toolCallId: 'tc1',
            approved,
            ...(reason === undefined ? {} : { reason }),
          },
        });
      },
    );

    // Regression (locks D10): a SEQUENTIAL second client tool call by one client
    // must not lose the prior context. Because EVERY client tool-result forks,
    // the fork seed must carry the suspended run's FULL projection — the prior
    // resolved tool call AND the current one — so the second fork's prompt keeps
    // the first tool call + result rather than starting blank.
    it('seeds a sequential second fork with the FULL run — the prior resolved tool call AND the current one', async () => {
      const { session, send, view, tree, mockRun } = createMockSession();

      const user1 = makeMessage('u1');
      // The suspended run's projection: a PRIOR tool call already resolved
      // (tc-prior → Paris), plus the CURRENT tool call awaiting a result
      // (tc-current) — the shape a sequential multi-step run carries after the
      // first fork resumed and made a second client tool call.
      const priorAssistant: AI.UIMessage = {
        id: 'a-prior',
        role: 'assistant',
        parts: [
          {
            type: 'dynamic-tool',
            toolName: 'getLocation',
            toolCallId: 'tc-prior',
            state: 'output-available',
            input: {},
            output: { city: 'Paris' },
          },
        ],
      };
      const currentTreeAssistant = makeAssistantWithToolPart('a-current', {
        type: 'dynamic-tool',
        toolName: 'getLocation',
        toolCallId: 'tc-current',
        state: 'input-available',
        input: {},
      });
      // useChat overlay: the current tool executed to output-available.
      const currentOverlay: AI.UIMessage = {
        id: 'a-current',
        role: 'assistant',
        parts: [
          {
            type: 'dynamic-tool',
            toolName: 'getLocation',
            toolCallId: 'tc-current',
            state: 'output-available',
            input: {},
            output: { city: 'Berlin' },
          },
        ],
      };

      // Visible tree: only the current tool call is unresolved (drives the fork).
      (view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue(asPairs([user1, currentTreeAssistant]));
      (view.runOf as ReturnType<typeof vi.fn>).mockReturnValue({
        runId: 'run-suspended',
        clientId: 'user-a',
        status: 'suspended',
        invocationId: '',
      });
      // The suspended run's projection carries BOTH messages.
      (tree.getRunNode as ReturnType<typeof vi.fn>).mockReturnValue({
        kind: 'run',
        runId: 'run-suspended',
        parentCodecMessageId: 'u1',
        state: { status: 'suspended' },
        projection: {
          messages: [
            { codecMessageId: 'a-prior', message: priorAssistant },
            { codecMessageId: 'a-current', message: currentTreeAssistant },
          ],
          trackers: new Map(),
          pendingToolResolutions: [],
        },
      });

      const chat = createChatTransport(session);
      const streamPromise = chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages: [user1, priorAssistant, currentOverlay],
        abortSignal: undefined,
      });
      mockRun.close();
      await streamPromise;

      const [input, opts] = send.mock.calls[0] as [VercelInput[], SendOptions];
      const toolResult = input.find(
        (i): i is Extract<VercelInput, { kind: 'tool-result' }> => i.kind === 'tool-result',
      );
      const seed = toolResult?.payload.forkSeed;
      // The fork seeds the FULL run — context is NOT lost across sequential calls.
      expect(seed?.messages).toHaveLength(2);
      const priorSeed = seed?.messages.find((m) => m.message.id === 'a-prior');
      const currentSeed = seed?.messages.find((m) => m.message.id === 'a-current');
      // The prior tool call is carried in its RESOLVED state (context preserved).
      expect(priorSeed?.message.parts).toContainEqual(
        expect.objectContaining({ toolCallId: 'tc-prior', state: 'output-available' }),
      );
      // The current tool call is carried awaiting this result.
      expect(currentSeed?.message.parts).toContainEqual(
        expect.objectContaining({ toolCallId: 'tc-current', state: 'input-available' }),
      );
      // The result targets the fresh id of the CURRENT tool-call message, on a
      // run-less fork rooted at the suspended run's input node (the agent mints
      // the run-id).
      expect(toolResult?.codecMessageId).toBe(currentSeed?.codecMessageId);
      expect(opts.parent).toBe('u1');
      expect(opts.runId).toBeUndefined();
      expect(opts.role).toBe('assistant');
    });
  });

  // -------------------------------------------------------------------------
  // sendMessages — empty continuation (defer-and-observe)
  // -------------------------------------------------------------------------
  //
  // Regression for AIT-843: a continuation whose tool resolutions are already
  // reflected in the Tree (another tab published the result first and we folded
  // it) derives no inputs. The transport must NOT call view.send([]) (which the
  // core rejects with "inputs array is empty") nor wake the agent; it returns a
  // chunk-less stream that observes the run the other tab is driving and stays
  // open (keeping useChat in `streaming`) until that run produces its next
  // assistant turn — signalled by its first output, with run-end as a safety
  // net — so useChat doesn't resubmit the empty continuation in a loop.
  describe('sendMessages — empty continuation (defer-and-observe)', () => {
    it('does not send, does not POST, and stays open until the observed run ends', async () => {
      const mock = createMockSession();
      // The observed run is suspended (awaiting the continuation the other tab drives).
      (mock.tree.getRunNode as ReturnType<typeof vi.fn>).mockReturnValue({ state: { status: 'suspended' } });
      const { messages } = setupResolvedContinuation(mock);

      const chat = createChatTransport(mock.session);
      const stream = await chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages,
        abortSignal: undefined,
      });

      // The empty input set is never sent (the bug: this path threw), and the
      // agent is not woken — the other tab owns the continuation.
      expect(mock.send).not.toHaveBeenCalled();
      expect(postCalls).toHaveLength(0);
      // Streaming is held so useChat neither resubmits nor opens the sync gate.
      expect(chat.streaming).toBe(true);

      let closed = false;
      const drained = drain(stream).then((chunks) => {
        closed = true;
        return chunks;
      });
      await flushMicrotasks();
      expect(closed).toBe(false);

      // The other tab's continuation runs and the run ends; the stream closes
      // (forwarding no chunks) and streaming clears so useMessageSync repaints.
      mock.mockRun.close();
      await expect(drained).resolves.toEqual([]);
      await flushMicrotasks();
      expect(chat.streaming).toBe(false);
    });

    it('stays open, then closes when the observed run produces its next output', async () => {
      const mock = createMockSession();
      (mock.tree.getRunNode as ReturnType<typeof vi.fn>).mockReturnValue({ state: { status: 'suspended' } });
      const { messages } = setupResolvedContinuation(mock);

      const chat = createChatTransport(mock.session);
      const stream = await chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages,
        abortSignal: undefined,
      });

      let closed = false;
      const drained = drain(stream).then((chunks) => {
        closed = true;
        return chunks;
      });
      await flushMicrotasks();
      expect(closed).toBe(false);

      // The other tab's continuation begins producing the next assistant turn.
      // Its first output for the run closes the observe stream (which forwards
      // no chunks) — we don't wait for run-end, since the new turn appearing is
      // what makes useChat stop resubmitting.
      mock.mockRun.enqueue({ type: 'text-start', id: 't1' });
      await expect(drained).resolves.toEqual([]);
      await flushMicrotasks();
      expect(chat.streaming).toBe(false);
    });

    it('closes immediately when the observed run already ended', async () => {
      const mock = createMockSession();
      // The agent already responded before sendMessages ran (snapshot pre-check):
      // the run is terminal, so there is nothing to wait for.
      (mock.tree.getRunNode as ReturnType<typeof vi.fn>).mockReturnValue({ state: { status: 'complete' } });
      const { messages } = setupResolvedContinuation(mock);

      const chat = createChatTransport(mock.session);
      const stream = await chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages,
        abortSignal: undefined,
      });

      expect(mock.send).not.toHaveBeenCalled();
      expect(postCalls).toHaveLength(0);
      await expect(drain(stream)).resolves.toEqual([]);
      await flushMicrotasks();
      expect(chat.streaming).toBe(false);
    });

    it('aborting after resolve closes the observe stream without sending or cancelling', async () => {
      const mock = createMockSession();
      (mock.tree.getRunNode as ReturnType<typeof vi.fn>).mockReturnValue({ state: { status: 'suspended' } });
      const { messages } = setupResolvedContinuation(mock);

      const controller = new AbortController();
      const chat = createChatTransport(mock.session);
      const stream = await chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages,
        abortSignal: controller.signal,
      });

      expect(chat.streaming).toBe(true);

      let closed = false;
      const drained = drain(stream).then((chunks) => {
        closed = true;
        return chunks;
      });
      await flushMicrotasks();
      expect(closed).toBe(false);

      // useChat aborts (e.g. the user hit Stop). We don't own this run, so
      // nothing is sent or cancelled — the observe stream simply closes.
      controller.abort();
      await expect(drained).resolves.toEqual([]);
      await flushMicrotasks();
      expect(chat.streaming).toBe(false);
      expect(mock.send).not.toHaveBeenCalled();
      expect(mock.cancel).not.toHaveBeenCalled();
    });

    it('an already-aborted signal closes the observe stream immediately', async () => {
      const mock = createMockSession();
      (mock.tree.getRunNode as ReturnType<typeof vi.fn>).mockReturnValue({ state: { status: 'suspended' } });
      const { messages } = setupResolvedContinuation(mock);

      // useChat can abort before sendMessages runs; addEventListener would not
      // fire for an already-aborted signal, so the explicit `aborted` branch
      // must close the stream without waiting for a run event.
      const controller = new AbortController();
      controller.abort();
      const chat = createChatTransport(mock.session);
      const stream = await chat.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-1',
        messageId: undefined,
        messages,
        abortSignal: controller.signal,
      });

      await expect(drain(stream)).resolves.toEqual([]);
      expect(mock.send).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // sendMessages — concurrent client tool results for one suspended tool call
  // -------------------------------------------------------------------------
  //
  // Two sessions with the SAME clientId (e.g. two browser tabs) each execute the
  // same client-side tool call on the ONE suspended run and each submit a
  // DIFFERENT result. Each result must be segregated onto its OWN reply-run
  // branch — not collapsed onto the single suspended run, where the two results
  // would contaminate each other (last-writer-wins on the tool-call assistant,
  // both follow-ups piled into one run projection).
  //
  // At the transport boundary the segregation shows up as: each continuation is
  // dispatched (via view.send) to a DISTINCT reply-run branch (a distinct
  // runId), rather than both re-entering the one suspended run. The full
  // tree-level outcome (each branch carries only its own result and follow-up,
  // each agent invocation's prompt clean) is asserted over real Ably in
  // chat-transport.integration.test.ts.
  describe('sendMessages — concurrent client tool results for one suspended tool call', () => {
    // The one suspended run both tabs' continuations resolve today.
    const SUSPENDED_RUN_ID = 'run-suspended';

    // Wire one tab: the suspended run's getLocation tool call is unresolved in
    // the tree; this tab's useChat overlay has executed the tool to `output`.
    const wireTab = (output: {
      city: string;
    }): { mock: ReturnType<typeof createMockSession>; overlay: AI.UIMessage[] } => {
      const mock = createMockSession();
      const user1 = makeMessage('u1');
      const treeAssistant = makeAssistantWithToolPart('asst-tool', {
        type: 'dynamic-tool',
        toolName: 'getLocation',
        toolCallId: 'tc-loc',
        state: 'input-available',
        input: {},
      });
      const overlayAssistant: AI.UIMessage = {
        id: 'asst-tool',
        role: 'assistant',
        parts: [
          {
            type: 'dynamic-tool',
            toolName: 'getLocation',
            toolCallId: 'tc-loc',
            state: 'output-available',
            input: {},
            output,
          },
        ],
      };
      (mock.view.getMessages as ReturnType<typeof vi.fn>).mockReturnValue(asPairs([user1, treeAssistant]));
      // Both tabs resolve the SAME suspended run, looked up by the assistant's
      // codec-message-id — the shared trunk both continuations reuse today.
      (mock.view.runOf as ReturnType<typeof vi.fn>).mockReturnValue({
        runId: SUSPENDED_RUN_ID,
        clientId: 'user-a',
        status: 'suspended',
        invocationId: '',
      });
      // The suspended run is rooted at the prompt 'u1' (its input node). A fork
      // roots there too and seeds from the run's projection (its single
      // tool-call assistant).
      (mock.tree.getRunNode as ReturnType<typeof vi.fn>).mockReturnValue({
        kind: 'run',
        runId: SUSPENDED_RUN_ID,
        parentCodecMessageId: 'u1',
        state: { status: 'suspended' },
        projection: { messages: asPairs([treeAssistant]), trackers: new Map(), pendingToolResolutions: [] },
      });
      return { mock, overlay: [user1, overlayAssistant] };
    };

    it('routes each result to a distinct run-less fork branch instead of the one suspended run', async () => {
      const tabHK = wireTab({ city: 'Hong Kong' });
      const tabBerlin = wireTab({ city: 'Berlin' });

      // Two tabs resolve the same suspended tool call concurrently.
      await Promise.all([
        sendContinuation(tabHK.mock, tabHK.overlay),
        sendContinuation(tabBerlin.mock, tabBerlin.overlay),
      ]);

      // Each tab published its OWN result (nothing dropped, nothing overwritten).
      expect(resultOutputOf(tabHK.mock)).toEqual({ city: 'Hong Kong' });
      expect(resultOutputOf(tabBerlin.mock)).toEqual({ city: 'Berlin' });

      // Both forks are published RUN-LESS (the agent mints each run-id) — neither
      // reuses the suspended run's id.
      expect(sendOptsOf(tabHK.mock)?.runId).toBeUndefined();
      expect(sendOptsOf(tabBerlin.mock)?.runId).toBeUndefined();

      const forkHK = forkTargetOf(tabHK.mock);
      const forkBerlin = forkTargetOf(tabBerlin.mock);

      // Segregation: the two concurrent results address two DISTINCT fork
      // branches — each keyed by its own client-owned target codec-message-id,
      // which the agent reconciles to a distinct minted run-id — NOT both
      // re-entering the one suspended run (the contamination this ticket fixes).
      expect(forkHK).toBeDefined();
      expect(forkBerlin).toBeDefined();
      expect(forkHK).not.toBe(forkBerlin);
      // Both forks root at the suspended run's input node ('u1') — a same-parent
      // sibling group — rather than the suspended run itself.
      expect(sendOptsOf(tabHK.mock)?.parent).toBe('u1');
      expect(sendOptsOf(tabBerlin.mock)?.parent).toBe('u1');
    });
  });
});
