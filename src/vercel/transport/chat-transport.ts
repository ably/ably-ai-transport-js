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

import type { ActiveRun, ClientSession, SendOptions } from '../../core/transport/types.js';
import { ErrorCode } from '../../errors.js';
import type { VercelInput, VercelOutput, VercelProjection } from '../codec/index.js';

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
  /** The codec-message-id of the message being forked (regenerated or edited). */
  forkOf?: string;
  /** The codec-message-id of the predecessor in the conversation thread. */
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
  close(): Promise<void>;

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
 * Hand the run's output stream to useChat as-is. After the TInput/TOutput
 * split, the agent's stream contains only `VercelOutput` (= `UIMessageChunk`)
 * values — no codec-local input variants can leak onto this path. The
 * passthrough exists so we can switch back to a TransformStream-based
 * adapter later (e.g. for instrumentation) without changing call sites.
 * @param source - The output stream from the active run.
 * @returns The same stream, structurally typed as `UIMessageChunk` for useChat.
 */
const filterToChunks = (source: ReadableStream<VercelOutput>): ReadableStream<AI.UIMessageChunk> => source;

/**
 * Wrap a ReadableStream in a passthrough TransformStream that resolves a
 * promise when the stream completes or errors. The returned stream passes
 * all chunks through unchanged.
 * @param source - The original stream to wrap.
 * @returns The wrapped stream and a `done` promise that resolves when the stream closes.
 */

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
/**
 * Whether a UIMessage part is a tool part — either the codec-normalised
 * `dynamic-tool` shape or the AI SDK's statically-declared `tool-${name}`
 * shape. Both carry `toolCallId` and `state`; the shape check at the end
 * is defensive against a future AI SDK release introducing a non-tool
 * variant under the `tool-` prefix (none exists today).
 * @param part - The UIMessage part to inspect.
 * @returns True when the part is a tool part of either representation.
 */
const _isToolPart = (part: AI.UIMessage['parts'][number]): part is AI.DynamicToolUIPart | AI.ToolUIPart =>
  (part.type === 'dynamic-tool' || part.type.startsWith('tool-')) && 'toolCallId' in part && 'state' in part;

const hasUnresolvedToolCall = (msg: AI.UIMessage): boolean =>
  msg.role === 'assistant' &&
  msg.parts.some(
    (p) =>
      _isToolPart(p) &&
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
 * Each TEvent is published as a `role: 'user'` channel message stamped
 * with `x-ably-run-continue: 'true'` AND with `x-ably-codec-message-id` set to the
 * prior assistant's tree codec-message-id (the one carrying the original
 * `dynamic-tool` part the resolution targets). The reducer's direct fold
 * path matches by codec-message-id and the chunk lands on the assistant in one
 * step — no cross-message redirect-by-toolCallId fallback.
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
 *   `tool-approval-response` (approved=true)
 * - `output-denied` overlay vs `approval-requested` tree →
 *   `tool-approval-response` (approved=false)
 * - `output-available`/`output-error` overlay vs unresolved tree →
 *   `tool-output-available` / `tool-output-error` UIMessageChunk
 * @param session - The client session (used to read the current tree).
 * @param messages - useChat's local overlay messages.
 * @returns Continuation events to publish, in tree order, paired with
 *   the target codec-message-id (the prior assistant's tree key) each event should
 *   fold onto. Arrays are parallel — `codecMessageIds[i]` belongs to
 *   `events[i]`.
 */
const deriveContinuationInputs = (
  session: ClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>,
  messages: AI.UIMessage[],
): VercelInput[] => {
  const allMessages = session.view.getMessages();
  const inputs: VercelInput[] = [];
  for (const overlay of messages) {
    if (overlay.role !== 'assistant') continue;
    const treeMessage = allMessages.find((m: AI.UIMessage) => m.id === overlay.id);
    if (!treeMessage) continue;

    for (const overlayPart of overlay.parts) {
      if (!_isToolPart(overlayPart)) continue;
      // The codec normalises every tool part to `dynamic-tool`, but the
      // AI SDK's useChat overlay emits `tool-${name}` parts for statically
      // declared tools. Match by toolCallId rather than the type prefix
      // so the cross-representation comparison works regardless of which
      // side the tool was declared on.
      const treePart = treeMessage.parts.find(
        (p: AI.UIMessage['parts'][number]): p is AI.DynamicToolUIPart | AI.ToolUIPart =>
          _isToolPart(p) && p.toolCallId === overlayPart.toolCallId,
      );

      // Approval response: useChat's `addToolApprovalResponse` flipped the
      // overlay part to `approval-responded` (approve) or `output-denied`
      // (deny) while the tree still sits on `approval-requested`. Publish
      // a `tool-approval-response` TInput so the agent's projection sees
      // the decision.
      if (overlayPart.state === 'approval-responded' && (!treePart || treePart.state === 'approval-requested')) {
        inputs.push({
          kind: 'tool-approval-response',
          codecMessageId: treeMessage.id,
          toolCallId: overlayPart.toolCallId,
          approved: true,
          ...(overlayPart.approval.reason === undefined ? {} : { reason: overlayPart.approval.reason }),
        });
        continue;
      }
      if (overlayPart.state === 'output-denied' && (!treePart || treePart.state === 'approval-requested')) {
        inputs.push({
          kind: 'tool-approval-response',
          codecMessageId: treeMessage.id,
          toolCallId: overlayPart.toolCallId,
          approved: false,
        });
        continue;
      }

      // Client-tool resolution: overlay has `output-available` / `output-error`
      // while the tree's part is still unresolved. Construct a TInput
      // variant (not a UIMessageChunk) so the encoder publishes on the
      // `ai-input` wire — this is the fix for AIT-815 where client tool
      // results previously landed on `ai-output`.
      if (overlayPart.state !== 'output-available' && overlayPart.state !== 'output-error') continue;
      // Tree already resolved (echo arrived back) — nothing to do.
      if (treePart && !UNRESOLVED_TOOL_STATES.has(treePart.state)) continue;

      if (overlayPart.state === 'output-available') {
        inputs.push({
          kind: 'tool-result',
          codecMessageId: treeMessage.id,
          toolCallId: overlayPart.toolCallId,
          output: overlayPart.output,
        });
      } else {
        inputs.push({
          kind: 'tool-result-error',
          codecMessageId: treeMessage.id,
          toolCallId: overlayPart.toolCallId,
          message: overlayPart.errorText,
        });
      }
    }
  }
  return inputs;
};

/**
 * Find the codec-message-id immediately preceding `codecMessageId` in the flat conversation.
 * Returns undefined if `codecMessageId` is the first message or not found.
 * @param messages - Flat conversation messages from `view.getMessages()`.
 * @param codecMessageId - The target message id.
 * @returns The preceding message's id, or undefined.
 */
const findPredecessorMsgId = (messages: AI.UIMessage[], codecMessageId: string): string | undefined => {
  const idx = messages.findIndex((m) => m.id === codecMessageId);
  if (idx <= 0) return undefined;
  return messages[idx - 1]?.id;
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
  session: ClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>,
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

    const allMessages: AI.UIMessage[] = session.view.getMessages();

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
    const lastMessageInTree = lastMessage ? allMessages.find((m: AI.UIMessage) => m.id === lastMessage.id) : undefined;
    const isContinuation = trigger === 'submit-message' && lastMessage?.role === 'assistant' && !!lastMessageInTree;

    // Fork-on-unresolved-tool: user sent a new message while the preceding
    // assistant has an unresolved tool call (approval-requested, input-*).
    // Fork the new message off the preceding assistant so the unresolved
    // tool call stays dormant on a sibling branch. Inference for this run runs
    // on the clean fork — the LLM never sees the dangling tool_use.
    //
    // Only applies to fresh user-message submits (not continuations, not
    // regenerates, not edits-with-messageId).
    //
    // `messages.at(-1)` is the fresh user-prompt being submitted right now;
    // `messages.at(-2)` is therefore the prior assistant whose tool state
    // we need to inspect for the unresolved-tool gate below.
    const precedingMessage =
      trigger === 'submit-message' && !messageId && lastMessage?.role === 'user' ? messages.at(-2) : undefined;
    const forkSourceMsgId =
      precedingMessage && hasUnresolvedToolCall(precedingMessage)
        ? allMessages.find((m: AI.UIMessage) => m.id === precedingMessage.id)?.id
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
      history = forkSourceMsgId ? messages.slice(0, -2) : messages.slice(0, -1);
    }

    // Compute fork metadata for edit (submit-message with messageId) and
    // fork-on-unresolved-tool. Regenerate is NOT precomputed here —
    // `View.regenerate` derives forkOf/parent from the tree itself and
    // overrides anything we'd set.
    let forkOf: string | undefined;
    let parent: string | undefined;

    if (trigger === 'submit-message' && messageId && !isContinuation) {
      // Edit: messageId identifies the user message being replaced. forkOf =
      // its codec-message-id, parent = the immediately-preceding codec-message-id in the flat
      // conversation.
      forkOf = messageId;
      parent = findPredecessorMsgId(allMessages, messageId);
    } else if (forkSourceMsgId) {
      // Fork off the preceding assistant — the new user message becomes a
      // sibling of the unresolved tool call assistant, rooted at its parent.
      forkOf = forkSourceMsgId;
      parent = findPredecessorMsgId(allMessages, forkSourceMsgId);
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
      sendBody = {
        sessionName: opts.chatId,
        trigger,
        ...(messageId !== undefined && { messageId }),
      };
      sendHeaders = undefined;
    }

    const sendOpts: SendOptions = { body: sendBody, headers: sendHeaders };
    if (forkOf !== undefined) sendOpts.forkOf = forkOf;
    if (parent !== undefined) sendOpts.parent = parent;
    // Continuations reuse the suspended assistant's runId so the agent's
    // existing run resumes under a fresh invocation rather than spinning
    // up a brand-new run. `isContinuation` implies `lastMessage` is defined.
    if (isContinuation) {
      const metadata = session.view.getMessageMetadata(lastMessage.id);
      if (metadata) sendOpts.runId = metadata.runId;
    }

    // Dispatch by mode:
    //
    // - Continuation: derive tool-resolution events from useChat's overlay
    //   vs the tree and pair each with the prior assistant's tree codec-message-id —
    //   the SDK stamps the wire's `x-ably-codec-message-id` to that id so the
    //   reducer's direct fold path runs (no redirect, no consume).
    // - Regenerate: route through `view.regenerate`. The View mints a
    //   wire-only regenerate event (`ait-regenerate`) carrying
    //   `forkOf=A1` / `parent=U1` on transport headers. U1 is NOT
    //   republished — A1 and A2 group as tree siblings under U1 via the
    //   existing forkOf machinery. The LLM receives the truncated history
    //   through U1 inclusive via the body.
    // - Fresh send / edit: publish the new user-message TEvent(s) via
    //   `view.sendEvent`.
    let run: ActiveRun<VercelOutput>;
    if (isContinuation) {
      const sendInput = deriveContinuationInputs(session, messages);
      run = await session.view.sendEvent(sendInput, sendOpts);
    } else if (trigger === 'regenerate-message') {
      if (messageId === undefined) {
        throw new Ably.ErrorInfo(
          'unable to regenerate; regenerate-message trigger fired without messageId',
          ErrorCode.InvalidArgument,
          400,
        );
      }
      run = await session.view.regenerate(messageId, sendOpts);
    } else {
      const sendInput = newMessages.map((m): VercelInput => ({ kind: 'user-message', message: m }));
      run = await session.view.sendEvent(sendInput, sendOpts);
    }

    if (abortSignal) {
      const runId = run.runId;
      abortSignal.addEventListener('abort', () => void session.cancel(runId), {
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

    close: async () => session.close(),

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
