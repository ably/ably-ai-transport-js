/**
 * Vercel chat transport: wraps a core ClientSession to satisfy the
 * ChatTransport interface that useChat expects.
 *
 * This is a thin adapter — the real logic lives in the core client session.
 * The chat transport maps Vercel's sendMessages/reconnectToStream contract
 * to the core session's send/cancel methods.
 *
 * useChat manages message state before calling sendMessages:
 * - submit-message (new): appends the new user message, passes the full array
 * - submit-message (edit): truncates after the edited message, replaces it,
 *   passes the truncated array with messageId set
 * - regenerate-message: truncates after the target, passes the truncated array
 *
 * The adapter uses `trigger` to determine the history/messages split:
 * - submit-message: last message is new (publish to channel), rest is history
 * - regenerate-message: no new messages, entire array is history
 *
 * When messageId is set (edit or regeneration), the adapter computes fork
 * metadata (forkOf/parent) from the conversation tree so the server can
 * place the response on the correct branch.
 */

import * as Ably from 'ably';
import type * as AI from 'ai';

import { HEADER_RUN_ID } from '../../constants.js';
import type { ClientSession, CloseOptions, SendOptions } from '../../core/transport/types.js';
import { ErrorCode } from '../../errors.js';
import type { VercelEvent, VercelProjection } from '../codec/index.js';

// ---------------------------------------------------------------------------
// ChatTransport options
// ---------------------------------------------------------------------------

/**
 * Context passed to {@link ChatTransportOptions.prepareSendMessagesRequest} for
 * customizing the HTTP POST body and headers.
 */
export interface SendMessagesRequestContext {
  /** Chat session ID (from useChat's id). */
  chatId?: string;
  /** What triggered the request: user sent a message, or requested regeneration. */
  trigger: 'submit-message' | 'regenerate-message';
  /**
   * The message ID for edit or regeneration requests. For regeneration,
   * identifies the assistant message to regenerate. For edits (submit-message
   * with messageId), identifies the user message being replaced. Undefined
   * when submitting a new message.
   */
  messageId?: string;
  /** Previous messages in the conversation (context for the LLM). */
  history: AI.UIMessage[];
  /** The new message(s) being sent (to publish to the channel). Empty for regeneration. */
  messages: AI.UIMessage[];
  /** The msg-id of the message being forked (regenerated or edited). */
  forkOf?: string;
  /** The msg-id of the predecessor in the conversation thread. */
  parent?: string;
}

/** Options for customizing the ChatTransport behavior. */
export interface ChatTransportOptions {
  /**
   * Customize the POST body before sending. Called by sendMessages()
   * with the conversation context. Return the body and headers for
   * the HTTP POST.
   *
   * Default: sends all previous messages as `history` in the body.
   * @param context - The conversation context for the current request.
   * @returns The body and headers to use for the HTTP POST.
   */
  prepareSendMessagesRequest?: (context: SendMessagesRequestContext) => {
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
  };
}

// ---------------------------------------------------------------------------
// ChatTransport interface
// ---------------------------------------------------------------------------

/**
 * Additional options passed through from useChat alongside the core
 * sendMessages/reconnectToStream parameters.
 *
 * Mirrors the AI SDK's internal ChatRequestOptions type, which is not
 * exported from the `ai` package.
 */
interface ChatRequestOptions {
  /** Additional headers for the request. */
  headers?: Record<string, string> | Headers;
  /** Additional JSON body properties for the request. */
  body?: object;
  /** Custom metadata to attach to the request. */
  metadata?: unknown;
}

/**
 * Transport interface for Vercel AI SDK's useChat hook.
 *
 * Structurally compatible with the AI SDK's internal `ChatTransport<UIMessage>`
 * interface. Extended with `close()` for releasing the underlying Ably transport
 * resources and `streaming` / `onStreamingChange` for coordinating with
 * useMessageSync.
 */
export interface ChatTransport {
  /** Send messages and return a streaming response of UIMessageChunk events. */
  sendMessages: (
    options: {
      /** The type of message submission — new message or regeneration. */
      trigger: 'submit-message' | 'regenerate-message';
      /** Unique identifier for the chat session. */
      chatId: string;
      /** ID of the message to regenerate, or undefined for new messages. */
      messageId: string | undefined;
      /** Array of UI messages representing the conversation history. */
      messages: AI.UIMessage[];
      /** Signal to abort the request if needed. */
      abortSignal: AbortSignal | undefined;
    } & ChatRequestOptions,
  ) => Promise<ReadableStream<AI.UIMessageChunk>>;

  /**
   * Reconnect to an existing streaming response. Returns null if no active
   * stream exists for the specified chat session.
   */
  reconnectToStream: (
    options: {
      /** Unique identifier for the chat session to reconnect to. */
      chatId: string;
    } & ChatRequestOptions,
  ) => Promise<ReadableStream<AI.UIMessageChunk> | null>;

  /** Close the underlying transport, releasing all resources. */
  close(options?: CloseOptions): Promise<void>;

  /** Whether an own-run stream is currently being consumed by useChat. */
  readonly streaming: boolean;

  /**
   * Subscribe to streaming state changes. The callback fires when the
   * ChatTransport transitions between streaming and idle. Used by
   * useMessageSync to gate setMessages calls during active streams.
   * @param callback - Called with `true` when a stream starts, `false` when it ends.
   * @returns Unsubscribe function.
   */
  onStreamingChange(callback: (streaming: boolean) => void): () => void;
}

// ---------------------------------------------------------------------------
// Stream wrapper — passthrough that signals completion via a promise
// ---------------------------------------------------------------------------

/**
 * Wrap a ReadableStream in a passthrough TransformStream that resolves a
 * promise when the stream completes or errors. The returned stream passes
 * all chunks through unchanged.
 * @param source - The original stream to wrap.
 * @returns The wrapped stream and a `done` promise that resolves when the stream closes.
 */
/**
 * Filter a VercelEvent stream down to its UIMessageChunk variants. Non-chunk
 * variants (UserMessageEvent / ToolApprovalEvent) only appear on prompt-side
 * publishes from the client; the assistant stream consumed by useChat is
 * naturally chunk-only. This filter narrows the TypeScript type and protects
 * against any unexpected non-chunk leakage at runtime.
 * @param source - The raw VercelEvent stream from the active run.
 * @returns A stream of UIMessageChunks suitable for handing to useChat.
 */
const filterToChunks = (source: ReadableStream<VercelEvent>): ReadableStream<AI.UIMessageChunk> =>
  source.pipeThrough(
    new TransformStream<VercelEvent, AI.UIMessageChunk>({
      transform: (event, controller) => {
        if (
          event.type === 'ait-user-message' ||
          event.type === 'ait-tool-approval' ||
          event.type === 'ait-client-tool-output' ||
          event.type === 'ait-client-tool-output-error'
        )
          return;
        // CAST: discriminator above excludes the codec-local variants, leaving UIMessageChunk.
        controller.enqueue(event);
      },
    }),
  );

const wrapStreamWithDone = <T>(source: ReadableStream<T>): { stream: ReadableStream<T>; done: Promise<void> } => {
  let resolveDone: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const passthrough = new TransformStream<T, T>({
    flush: () => {
      resolveDone();
    },
  });

  // Pipe in the background. If the source errors or is cancelled, resolve
  // done so the serialization queue advances.
  // Fire-and-forget: the pipe runs independently; errors surface through
  // the readable side that useChat consumes.
  source.pipeTo(passthrough.writable).catch(() => {
    resolveDone();
  });

  return { stream: passthrough.readable, done };
};

// ---------------------------------------------------------------------------
// Unresolved tool call detection
// ---------------------------------------------------------------------------

/**
 * Whether an assistant message has a `dynamic-tool` part that can't resolve
 * without further user action. Matches:
 * - `input-streaming` / `input-available` — tool call emitted, not yet run.
 * - `approval-requested` — waiting for the user.
 *
 * Excludes `approval-responded` (streamText will run the tool this run)
 * and all terminal `output-*` states.
 * @param msg - The UIMessage to inspect.
 * @returns True when a fork-on-send is warranted to avoid shipping a
 *   dangling tool call to the LLM.
 */
const hasUnresolvedToolCall = (msg: AI.UIMessage): boolean =>
  msg.role === 'assistant' &&
  msg.parts.some(
    (p) =>
      p.type === 'dynamic-tool' &&
      (p.state === 'input-streaming' || p.state === 'input-available' || p.state === 'approval-requested'),
  );

/**
 * `dynamic-tool` part states that mean "the LLM produced a tool call and
 * is waiting on it". Used to detect new client-side resolutions in the
 * useChat overlay relative to the tree.
 */
const UNRESOLVED_TOOL_STATES = new Set(['input-streaming', 'input-available', 'approval-requested']);

/**
 * Walk the useChat message overlay against the session tree and synthesize
 * the TEvents needed to resolve every `dynamic-tool` part that the user
 * acted on (executed a tool, approved, denied) but the tree's reduced
 * state hasn't reflected yet.
 *
 * The resulting events are passed alongside the continuation `view.sendEvent`
 * so the channel publish and the continuation POST land as ONE atomic
 * operation — the agent's `loadProjection()` history fetch is guaranteed
 * to see the new events because the channel publish happens before the
 * POST inside `_internalSend`.
 *
 * Three resolutions are produced:
 *
 * - `approval-responded` overlay vs `approval-requested` tree →
 *   `ait-tool-approval` (approved=true)
 * - `output-denied` overlay vs `approval-requested` tree →
 *   `ait-tool-approval` (approved=false)
 * - `output-available`/`output-error` overlay vs unresolved tree →
 *   `ait-client-tool-output(-error)`
 *
 * Replacement for the retired `session.stageEvents` flow: client-side
 * resolutions reach the agent through the channel, not the HTTP POST body.
 * @param session - The client session (used to read the current tree).
 * @param messages - useChat's local overlay messages.
 * @returns Continuation events to publish, in tree order.
 */
const deriveContinuationEvents = (
  session: ClientSession<VercelEvent, VercelProjection, AI.UIMessage>,
  messages: AI.UIMessage[],
): VercelEvent[] => {
  const allNodes = session.view.flattenNodes();
  const events: VercelEvent[] = [];
  for (const overlay of messages) {
    if (overlay.role !== 'assistant') continue;
    const node = allNodes.find((n) => n.message.id === overlay.id);
    if (!node) continue;
    const treeMessage = node.message;

    for (const overlayPart of overlay.parts) {
      if (overlayPart.type !== 'dynamic-tool') continue;
      const treePart = treeMessage.parts.find(
        (p): p is AI.DynamicToolUIPart => p.type === 'dynamic-tool' && p.toolCallId === overlayPart.toolCallId,
      );

      // Approval response: useChat's `addToolApprovalResponse` flipped the
      // overlay part to `approval-responded` (approve) or `output-denied`
      // (deny) while the tree still sits on `approval-requested`. Publish a
      // `ToolApprovalEvent` so the agent's projection sees the decision.
      if (overlayPart.state === 'approval-responded' && (!treePart || treePart.state === 'approval-requested')) {
        const approvalEvent: VercelEvent = {
          type: 'ait-tool-approval',
          toolCallId: overlayPart.toolCallId,
          approved: true,
          targetMsgId: node.msgId,
        };
        if (overlayPart.approval.reason !== undefined) {
          (approvalEvent as { reason?: string }).reason = overlayPart.approval.reason;
        }
        events.push(approvalEvent);
        continue;
      }
      if (overlayPart.state === 'output-denied' && (!treePart || treePart.state === 'approval-requested')) {
        events.push({
          type: 'ait-tool-approval',
          toolCallId: overlayPart.toolCallId,
          approved: false,
          targetMsgId: node.msgId,
        });
        continue;
      }

      // Client-tool resolution: overlay has `output-available` / `output-error`
      // while the tree's part is still unresolved.
      if (overlayPart.state !== 'output-available' && overlayPart.state !== 'output-error') continue;
      // Tree already resolved (echo arrived back) — nothing to do.
      if (treePart && !UNRESOLVED_TOOL_STATES.has(treePart.state)) continue;

      if (overlayPart.state === 'output-available') {
        events.push({
          type: 'ait-client-tool-output',
          toolCallId: overlayPart.toolCallId,
          output: overlayPart.output,
          targetMsgId: node.msgId,
        });
      } else {
        events.push({
          type: 'ait-client-tool-output-error',
          toolCallId: overlayPart.toolCallId,
          errorText: overlayPart.errorText,
          targetMsgId: node.msgId,
        });
      }
    }
  }
  return events;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Vercel ChatTransport from a core ClientSession.
 *
 * Exposes a `streaming` flag and `onStreamingChange` callback so that
 * `useMessageSync` can gate `setMessages` calls during active own-run
 * streams, preventing the push/replace ID mismatch in useChat's `write()`.
 *
 * Note: concurrent `sendMessage` calls from the same user are a useChat
 * limitation that cannot be fixed from the transport layer. The
 * developer must respect useChat's `status` and only call `sendMessage`
 * when status is `'ready'`.
 * @param session - The core client session to wrap.
 * @param chatOptions - Optional hooks for customizing request construction.
 * @returns A {@link ChatTransport} compatible with Vercel's useChat hook.
 */
export const createChatTransport = (
  session: ClientSession<VercelEvent, VercelProjection, AI.UIMessage>,
  chatOptions?: ChatTransportOptions,
): ChatTransport => {
  // -- Streaming state -------------------------------------------------------
  let _streaming = false;
  const streamingCallbacks = new Set<(streaming: boolean) => void>();

  const setStreaming = (value: boolean): void => {
    _streaming = value;
    for (const cb of streamingCallbacks) {
      try {
        cb(value);
      } catch {
        // Isolate subscriber errors so one bad handler doesn't prevent
        // other subscribers from being notified or block the streaming
        // state transition.
      }
    }
  };

  // -- sendMessages implementation -------------------------------------------

  const sendMessages: ChatTransport['sendMessages'] = async (opts) => {
    const { messages, abortSignal, trigger, messageId } = opts;

    const allNodes = session.view.flattenNodes();

    // useChat calls sendMessages in three distinct modes. We disambiguate
    // by (trigger, last-message role) so each mode dispatches correctly:
    //
    //   - 'regenerate-message'                          → fork an assistant
    //   - 'submit-message' + last message is assistant  → continuation
    //                                                     (auto-submit after
    //                                                     addToolResult, or
    //                                                     multi-step tool use)
    //   - 'submit-message' + last message is user       → new user message
    //                                                     (or edit if
    //                                                     messageId is set)
    //
    // Continuation mode must NOT publish the assistant as a new message or
    // treat messageId as a fork target — useChat v6's sendAutomaticallyWhen
    // path always sets messageId to the last message id regardless.
    const lastMessage = messages.at(-1);
    const lastMessageNode = lastMessage ? allNodes.find((n) => n.message.id === lastMessage.id) : undefined;
    const isContinuation = trigger === 'submit-message' && lastMessage?.role === 'assistant' && !!lastMessageNode;

    // Fork-on-unresolved-tool: user sent a new message while the preceding
    // assistant has an unresolved tool call (approval-requested, input-*).
    // Fork the new message off the preceding assistant so the unresolved
    // tool call stays dormant on a sibling branch. Inference for this run runs
    // on the clean fork — the LLM never sees the dangling tool_use.
    //
    // Only applies to fresh user-message submits (not continuations, not
    // regenerates, not edits-with-messageId).
    const precedingMessage =
      trigger === 'submit-message' && !messageId && lastMessage?.role === 'user' ? messages.at(-2) : undefined;
    const forkSource =
      precedingMessage && hasUnresolvedToolCall(precedingMessage)
        ? allNodes.find((n) => n.message.id === precedingMessage.id)
        : undefined;

    // Determine the history/messages split based on mode.
    let newMessages: AI.UIMessage[];
    let history: AI.UIMessage[];

    if (trigger === 'regenerate-message' || isContinuation) {
      newMessages = [];
      history = messages;
    } else {
      if (messages.length === 0) {
        throw new Ably.ErrorInfo(
          'unable to send messages; messages array is empty for submit-message trigger',
          ErrorCode.InvalidArgument,
          400,
        );
      }
      // CAST: length check above guarantees at least one element; .at(-1) cannot be undefined.
      // eslint-disable-next-line @typescript-eslint/non-nullable-type-assertion-style -- prefer `as` over `!` per TYPES.md
      newMessages = [messages.at(-1) as AI.UIMessage];
      // When forking off an unresolved tool call, drop the unresolved
      // assistant from history too — it belongs on the sibling branch, not
      // the ancestor chain of the new message.
      history = forkSource ? messages.slice(0, -2) : messages.slice(0, -1);
    }

    // Compute fork metadata. Only set in regenerate or edit modes — in
    // continuation mode we do NOT fork, we continue the branch.
    let forkOf: string | undefined;
    let parent: string | undefined;

    if (messageId && !isContinuation) {
      // Regeneration: messageId = assistant to regenerate.
      // Edit (submit-message with user message and messageId): messageId = user being replaced.
      // In both cases forkOf = the x-ably-msg-id, parent = that message's parent.
      forkOf = messageId;
      const node = allNodes.find((n) => n.message.id === messageId);
      if (node) {
        forkOf = node.msgId;
        parent = node.parentId;
      }
    } else if (isContinuation) {
      // Continuation: the server's next assistant message is a child of the
      // last assistant (no fork). Pass parent so the server places the new
      // message correctly in the tree. isContinuation narrows lastMessageNode
      // to defined.
      parent = lastMessageNode.msgId;
    } else if (forkSource) {
      // Fork off the preceding assistant — the new user message becomes a
      // sibling of the unresolved tool call assistant, rooted at its parent.
      forkOf = forkSource.msgId;
      parent = forkSource.parentId;
    }

    let sendBody: Record<string, unknown>;
    let sendHeaders: Record<string, string> | undefined;

    if (chatOptions?.prepareSendMessagesRequest) {
      const prepared = chatOptions.prepareSendMessagesRequest({
        chatId: opts.chatId,
        trigger,
        messageId,
        history,
        messages: newMessages,
        forkOf,
        parent,
      });
      sendBody = prepared.body ?? {};
      sendHeaders = prepared.headers;
    } else {
      const historyIds = new Set(history.map((m) => m.id));
      const historyNodes = allNodes.filter((n) => historyIds.has(n.message.id));
      sendBody = {
        history: historyNodes,
        sessionName: opts.chatId,
        trigger,
        ...(messageId !== undefined && { messageId }),
        ...(forkOf !== undefined && { forkOf }),
        ...(parent !== undefined && { parent }),
      };
      sendHeaders = undefined;
    }

    const sendOpts: SendOptions = { body: sendBody, headers: sendHeaders };
    if (forkOf !== undefined) sendOpts.forkOf = forkOf;
    if (parent !== undefined) sendOpts.parent = parent;
    // Continuations reuse the suspended assistant's runId so the agent's
    // existing run resumes under a fresh invocation rather than spinning
    // up a brand-new run. `lastMessageNode` is non-undefined whenever
    // `isContinuation` is true.
    if (isContinuation) {
      const suspendedRunId = lastMessageNode.headers[HEADER_RUN_ID];
      if (suspendedRunId) sendOpts.runId = suspendedRunId;
    }

    // Build the events array. For continuations, this is the set of
    // client-side tool-output amends derived from useChat's overlay vs the
    // tree — publishing them through the same `view.sendEvent` call means the
    // channel publish lands BEFORE the continuation POST reaches the agent,
    // so the agent's `loadProjection()` history fetch sees the amends.
    let inputEvents: VercelEvent[];
    if (isContinuation) {
      inputEvents = deriveContinuationEvents(session, messages);
    } else if (trigger === 'regenerate-message') {
      inputEvents = [];
    } else {
      inputEvents = newMessages.map((m) => ({ type: 'ait-user-message', message: m }));
    }

    const run = await session.view.sendEvent(inputEvents, sendOpts);

    if (abortSignal) {
      abortSignal.addEventListener('abort', () => void session.cancel({ all: true }), {
        once: true,
      });
    }

    // Wrap the stream to detect completion. The streaming flag gates
    // useMessageSync so that setMessages doesn't interfere with
    // useChat's internal write() during active streams.
    const { stream, done } = wrapStreamWithDone(filterToChunks(run.stream));
    setStreaming(true);

    // Fire-and-forget: clear the streaming flag when the stream ends.
    void done.then(() => {
      setStreaming(false);
    });

    return stream;
  };

  return {
    sendMessages,

    // Observer mode handles in-progress streams automatically.
    // The transport subscribes before attach — on the next server append,
    // observer accumulation emits lifecycle events that useMessageSync
    // upserts into React state.
    // eslint-disable-next-line unicorn/no-null, @typescript-eslint/promise-function-async -- null is required by the AI SDK ChatTransport contract; no await needed
    reconnectToStream: () => Promise.resolve(null),

    close: async (options?: CloseOptions) => session.close(options),

    get streaming(): boolean {
      return _streaming;
    },

    onStreamingChange: (callback: (streaming: boolean) => void): (() => void) => {
      streamingCallbacks.add(callback);
      return () => {
        streamingCallbacks.delete(callback);
      };
    },
  };
};
