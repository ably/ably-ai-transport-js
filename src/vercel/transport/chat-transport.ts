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

import type { ClientTransport, CloseOptions, MessageNode, SendOptions } from '../../core/transport/types.js';
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
// Message / history split
// ---------------------------------------------------------------------------

/**
 * Split useChat's messages array into new messages and history.
 *
 * The split depends on the trigger and the role of the last message:
 * - `regenerate-message`: no new messages, entire array is history.
 * - `submit-message` with last message `role: 'user'`: the last message
 *   is the new user message, everything before it is history.
 * - `submit-message` with last message `role: 'assistant'`: this is a
 *   tool approval response (from `addToolApprovalResponse`). useChat
 *   patched the assistant message to `approval-responded` and triggered
 *   a send — there are no new messages to publish, the entire array
 *   is history.
 */
const splitMessagesAndHistory = (
  messages: AI.UIMessage[],
  trigger: 'submit-message' | 'regenerate-message',
): { newMessages: AI.UIMessage[]; history: AI.UIMessage[] } => {
  if (trigger === 'regenerate-message') {
    return { newMessages: [], history: messages };
  }

  if (messages.length === 0) {
    throw new Ably.ErrorInfo(
      'unable to send messages; messages array is empty for submit-message trigger',
      ErrorCode.InvalidArgument,
      400,
    );
  }

  // CAST: length check above guarantees at least one element; .at(-1) cannot be undefined.
  // eslint-disable-next-line @typescript-eslint/non-nullable-type-assertion-style -- prefer `as` over `!` per TYPES.md
  const lastMessage = messages.at(-1) as AI.UIMessage;

  if (lastMessage.role === 'assistant') {
    return { newMessages: [], history: messages };
  }

  return { newMessages: [lastMessage], history: messages.slice(0, -1) };
};

/**
 * Build history nodes by overlaying useChat's message content onto the
 * transport's tree nodes. The tree provides structural metadata (msgId,
 * parentId, headers, serial); the message content comes from useChat's
 * state, which may have local patches (e.g. approval-responded) that
 * the tree doesn't reflect yet.
 */
const buildHistoryNodes = (
  history: AI.UIMessage[],
  allNodes: MessageNode<AI.UIMessage>[],
): MessageNode<AI.UIMessage>[] => {
  const historyById = new Map(history.map((m) => [m.id, m]));
  return allNodes
    .filter((n) => historyById.has(n.message.id))
    .map((n) => {
      const chatMessage = historyById.get(n.message.id);
      return chatMessage ? { ...n, message: chatMessage } : n;
    });
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

    const { newMessages, history } = splitMessagesAndHistory(messages, trigger);

    // Compute fork metadata from the conversation tree.
    // For regeneration: messageId is the assistant message being regenerated.
    // For edit: messageId is the user message being replaced.
    // In both cases: forkOf = the x-ably-msg-id of that message,
    //   parent = the parent of that message in the tree.
    let forkOf: string | undefined;
    let parent: string | undefined;

    if (messageId) {
      forkOf = messageId;
      // Look up the message in the tree to resolve x-ably-msg-id.
      // messageId comes from useChat (UIMessage.id) — scan the flattened
      // nodes to find the one whose domain message matches this ID.
      // Uses the transport's default view — ChatTransport is single-view (one useChat per channel).
      const node = transport.view.flattenNodes().find((n) => n.message.id === messageId);
      if (node) {
        forkOf = node.msgId;
        parent = node.parentId;
      }
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
      // Build history nodes from the transport's conversation tree, but use
      // useChat's message content (not the tree's). useChat may have patched
      // message parts locally (e.g. approval-requested → approval-responded)
      // that the tree doesn't reflect yet. The tree provides structural
      // metadata (msgId, parentId, headers); the message content comes from
      // useChat's authoritative state.
      sendBody = {
        chatId: opts.chatId,
        history: buildHistoryNodes(history, transport.view.flattenNodes()),
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
