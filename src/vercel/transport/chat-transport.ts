/**
 * Vercel chat transport: wraps a core ClientTransport to satisfy the
 * ChatTransport interface that useChat expects.
 *
 * This is a thin adapter — the real logic lives in the core transport.
 * The chat transport maps Vercel's sendMessages/reconnectToStream contract
 * to the core transport's send/cancel methods.
 *
 * useChat manages message state before calling sendMessages:
 * - submit-message: appends the new user message, passes the full array
 * - regenerate-message: truncates after the target, passes the truncated array
 *
 * The adapter uses `trigger` to determine the history/messages split:
 * - submit-message: last message is new (publish to channel), rest is history
 * - regenerate-message: no new messages, entire array is history
 */

import * as Ably from 'ably';
import type * as AI from 'ai';

import type { ClientTransport, CloseOptions, SendOptions } from '../../core/transport/client/types.js';
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
  id?: string;
  /** What triggered the request: user sent a message, or requested regeneration. */
  trigger: 'submit-message' | 'regenerate-message';
  /**
   * The message ID for regeneration requests. Identifies which assistant
   * message to regenerate. Undefined for submit-message.
   */
  messageId?: string;
  /** Previous messages in the conversation (context for the LLM). */
  history: AI.UIMessage[];
  /** The new message(s) being sent (to publish to the channel). Empty for regeneration. */
  messages: AI.UIMessage[];
  /** The msg-id of the message being forked (regenerated or edited). */
  forkOf?: string;
  /** The msg-id of the predecessor in the conversation thread. */
  parent?: string | null;
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
 * resources.
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
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Vercel ChatTransport from a core ClientTransport.
 *
 * Maps Vercel's useChat contract to the core transport's methods:
 * - trigger 'submit-message' → transport.send(lastMessage) with history in body
 * - trigger 'regenerate-message' → transport.send([]) with all messages as history
 * - abortSignal → transport.cancel({ all: true })
 * - reconnectToStream → null (observer mode handles in-progress streams)
 * @param transport - The core client transport to wrap.
 * @param chatOptions - Optional hooks for customizing request construction.
 * @returns A {@link ChatTransport} compatible with Vercel's useChat hook.
 */
export const createChatTransport = (
  transport: ClientTransport<AI.UIMessageChunk, AI.UIMessage>,
  chatOptions?: ChatTransportOptions,
): ChatTransport => ({
  sendMessages: async (opts) => {
    const { messages, abortSignal, trigger, messageId } = opts;

    // Determine the history/messages split based on trigger.
    // - submit-message: useChat appended the new user message → last is new
    // - regenerate-message: useChat truncated the array → no new messages
    let newMessages: AI.UIMessage[];
    let history: AI.UIMessage[];

    if (trigger === 'regenerate-message') {
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

    // Compute fork metadata from the conversation tree.
    // For regeneration: forkOf = messageId (the assistant message being regenerated),
    //   parent = the parent of that message in the tree.
    let forkOf: string | undefined;
    let parent: string | null | undefined;

    if (trigger === 'regenerate-message' && messageId) {
      forkOf = messageId;
      // Look up the parent of the message being regenerated.
      // messageId comes from useChat (UIMessage.id), so use getNodeByKey
      // which resolves via the codec key secondary index.
      const node = transport.getTree().getNodeByKey(messageId);
      if (node) {
        // Use the tree node's msgId (x-ably-msg-id) as forkOf — this is
        // what the server stamps on the wire, not the UIMessage.id.
        forkOf = node.msgId;
        parent = node.parentId;
      }
    }

    let sendBody: Record<string, unknown>;
    let sendHeaders: Record<string, string> | undefined;

    if (chatOptions?.prepareSendMessagesRequest) {
      const prepared = chatOptions.prepareSendMessagesRequest({
        id: opts.chatId,
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
      const historyWithHeaders = history.map((m) => ({
        message: m,
        headers: transport.getMessageHeaders(m),
      }));
      sendBody = {
        history: historyWithHeaders,
        id: opts.chatId,
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

    const turn = await transport.send(newMessages, sendOpts);

    // Wire abort signal to cancel all turns on the channel.
    // In multi-user scenarios, any client can stop any stream — cancelling
    // by specific turnId would only work for the sender.
    if (abortSignal) {
      abortSignal.addEventListener('abort', () => void transport.cancel({ all: true }), {
        once: true,
      });
    }

    // Return an empty stream that closes when the turn ends.
    // useChat consumes the returned stream to accumulate the assistant message,
    // but useMessageSync already pushes the transport's authoritative message
    // state into useChat via setMessages. Returning the real event stream would
    // cause useChat to accumulate a duplicate assistant message. Instead, we
    // return a stream that produces no chunks and closes when the turn's stream
    // finishes, so useChat knows when streaming is done without duplicating state.
    const { readable, writable } = new TransformStream<AI.UIMessageChunk>();
    const writer = writable.getWriter();
    // Fire-and-forget: we only care about the close/abort signal, not the piped data.
    // Errors on the turn stream are surfaced via transport.on('error'), not here.
    /* eslint-disable @typescript-eslint/no-empty-function -- swallow: writer.close() rejection after stream teardown is unrecoverable */
    turn.stream
      .pipeTo(
        new WritableStream({
          close: () => {
            writer.close().catch(() => {});
          },
          abort: () => {
            writer.close().catch(() => {});
          },
        }),
      )
      .catch(() => {
        writer.close().catch(() => {});
      });
    /* eslint-enable @typescript-eslint/no-empty-function */
    return readable;
  },

  // Observer mode handles in-progress streams automatically.
  // The transport subscribes before attach — on the next server append,
  // observer accumulation emits lifecycle events that useMessageSync
  // upserts into React state.
  // eslint-disable-next-line unicorn/no-null, @typescript-eslint/promise-function-async -- null is required by the AI SDK ChatTransport contract; no await needed
  reconnectToStream: () => Promise.resolve(null),

  close: async (options?: CloseOptions) => transport.close(options),
});
