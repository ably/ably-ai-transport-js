/**
 * Vercel chat transport: wraps a core ClientTransport to satisfy the
 * ChatTransport interface that useChat expects.
 *
 * This is a thin adapter — the real logic lives in the core transport.
 * The chat transport maps Vercel's sendMessages/reconnectToStream contract
 * to the core transport's send/cancel methods.
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

import type { ClientTransport, CloseOptions, SendOptions } from '../../core/transport/types.js';
import { ErrorCode } from '../../errors.js';

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

  /** Whether an own-turn stream is currently being consumed by useChat. */
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
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Vercel ChatTransport from a core ClientTransport.
 *
 * Exposes a `streaming` flag and `onStreamingChange` callback so that
 * `useMessageSync` can gate `setMessages` calls during active own-turn
 * streams, preventing the push/replace ID mismatch in useChat's `write()`.
 *
 * Note: concurrent `sendMessage` calls from the same user are a useChat
 * limitation that cannot be fixed from the transport layer. The
 * developer must respect useChat's `status` and only call `sendMessage`
 * when status is `'ready'`.
 * @param transport - The core client transport to wrap.
 * @param chatOptions - Optional hooks for customizing request construction.
 * @returns A {@link ChatTransport} compatible with Vercel's useChat hook.
 */
export const createChatTransport = (
  transport: ClientTransport<AI.UIMessageChunk, AI.UIMessage>,
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
    const allNodes = transport.view.flattenNodes();

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
    //
    // Client-side tool outputs are expected to be staged on the transport
    // via transport.stageEvents() before this runs; the core transport
    // flushes staged events into the POST body automatically.
    const lastMessage = messages.at(-1);
    const lastMessageNode = lastMessage ? allNodes.find((n) => n.message.id === lastMessage.id) : undefined;
    const isContinuation = trigger === 'submit-message' && lastMessage?.role === 'assistant' && !!lastMessageNode;

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
      history = messages.slice(0, -1);
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
        chatId: opts.chatId,
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

    // A single dispatch path: view.send with the (possibly empty)
    // newMessages array. Any events staged via transport.stageEvents()
    // flow automatically through _internalSend into the POST body.
    const turn = await transport.view.send(newMessages, sendOpts);

    if (abortSignal) {
      abortSignal.addEventListener('abort', () => void transport.cancel({ all: true }), {
        once: true,
      });
    }

    // Wrap the stream to detect completion. The streaming flag gates
    // useMessageSync so that setMessages doesn't interfere with
    // useChat's internal write() during active streams.
    const { stream, done } = wrapStreamWithDone(turn.stream);
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

    close: async (options?: CloseOptions) => transport.close(options),

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
