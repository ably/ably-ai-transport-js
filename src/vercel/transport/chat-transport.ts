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
 * The adapter uses `(trigger, last-message role)` to determine the
 * history/messages split:
 * - submit-message + last message is a user message: that last message is new
 *   (publish to channel), rest is history. A new submit and an edit both take
 *   this path — an edit just carries a messageId.
 * - submit-message + last message is an assistant already in the tree
 *   (continuation): no new messages, entire array is history
 * - regenerate-message: no new messages, entire array is history
 *
 * For an edit (submit-message with messageId) and for forking off an
 * unresolved tool call, the adapter computes fork metadata (forkOf/parent)
 * from the conversation tree so the server can place the response on the
 * correct branch. Regeneration fork metadata is NOT computed here —
 * `View.regenerate` derives forkOf/parent from the tree itself.
 */

import * as Ably from 'ably';
import type * as AI from 'ai';

import type { CodecMessage } from '../../core/codec/index.js';
import type { ActiveRun, ClientSession, SendOptions } from '../../core/transport/types.js';
import { ErrorCode } from '../../errors.js';
import { EventEmitter } from '../../event-emitter.js';
import { LogLevel, makeLogger } from '../../logger.js';
import type { VercelInput, VercelOutput, VercelProjection } from '../codec/index.js';
import { UIMessageCodec } from '../codec/index.js';
import { createRunOutputStream } from './run-output-stream.js';

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
  /** The new message(s) being sent (to publish to the channel). Empty for regeneration and for continuations (an auto-submit where the last message is an already-tracked assistant). */
  messages: AI.UIMessage[];
  /** The codec-message-id of the message being forked — the edited user message, or the preceding assistant when forking off an unresolved tool call. Undefined for regeneration (View.regenerate derives it) and fresh sends. */
  forkOf?: string;
  /** The codec-message-id of the predecessor in the conversation thread. */
  parent?: string;
}

/** Default agent endpoint the transport POSTs invocations to — mirrors Vercel's DefaultChatTransport. */
const DEFAULT_VERCEL_API = '/api/chat';

/** Options for customizing the ChatTransport behavior. */
export interface ChatTransportOptions {
  /**
   * Endpoint the transport POSTs the invocation pointer to, to wake the
   * agent. Mirrors useChat's request-driven contract. Default `/api/chat`.
   */
  api?: string;
  /** Fetch credentials mode for the invocation POST (e.g. `'include'`). */
  credentials?: RequestCredentials;
  /** Custom fetch implementation for the invocation POST. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /**
   * Customize the invocation POST before sending. Called by sendMessages()
   * with the conversation context; the returned `body` is merged into the
   * POST body (the run's invocation identifiers always take precedence) and
   * `headers` are added to the request. Use it for auth headers or extra
   * agent metadata.
   * @param context - The conversation context for the current request.
   * @returns The body and headers to merge into the invocation POST.
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
 * Wrap a ReadableStream in a passthrough TransformStream that resolves a
 * promise when the stream completes or errors. The returned stream passes
 * all chunks through unchanged, and `fail(reason)` errors the readable side
 * useChat consumes without cancelling or otherwise disturbing the source run
 * stream (used when the agent-invocation POST fails).
 * @param source - The original stream to wrap.
 * @returns The wrapped stream, a `done` promise that resolves when the stream
 *   closes, and a `fail` callback that errors the wrapped stream.
 */

const wrapStreamWithDone = <T>(
  source: ReadableStream<T>,
): { stream: ReadableStream<T>; done: Promise<void>; fail: (reason: Ably.ErrorInfo) => void } => {
  let resolveDone: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const passthrough = new TransformStream<T, T>({
    flush: () => {
      resolveDone();
    },
  });

  // Aborting this signal errors the destination (the readable useChat reads)
  // with the abort reason. `preventCancel` keeps the source run stream intact
  // so the tree/observers are unaffected — only the useChat-facing view fails.
  const failController = new AbortController();

  // Pipe in the background. If the source errors/cancels, or `fail()` aborts,
  // resolve done so the serialization queue advances.
  // Fire-and-forget: the pipe runs independently; errors surface through
  // the readable side that useChat consumes.
  source.pipeTo(passthrough.writable, { signal: failController.signal, preventCancel: true }).catch(() => {
    resolveDone();
  });

  return {
    stream: passthrough.readable,
    done,
    fail: (reason: Ably.ErrorInfo) => {
      failController.abort(reason);
    },
  };
};

// ---------------------------------------------------------------------------
// Unresolved tool call detection
// ---------------------------------------------------------------------------

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
 * the {@link VercelInput}s needed to resolve every `dynamic-tool` part the
 * user acted on (executed a tool, approved, denied) but the tree's reduced
 * state hasn't reflected yet.
 *
 * Each input carries the prior assistant's tree codec-message-id (the one
 * holding the original `dynamic-tool` part the resolution targets) in its
 * `codecMessageId` field, so the encoder stamps `codec-message-id`
 * and the reducer's direct-fold path lands the resolution on that assistant
 * in one step — no cross-message redirect-by-toolCallId fallback. Every
 * variant rides the `ai-input` wire, matching its publisher (client → input).
 *
 * The resulting inputs are passed alongside the continuation `view.send`
 * so the channel publish and the continuation POST land as ONE atomic
 * operation — the agent's `loadConversation()` history walk is guaranteed
 * to see them because the channel publish happens before the POST inside
 * `_internalSend`.
 *
 * Three resolutions are produced:
 *
 * - `approval-responded` overlay vs `approval-requested` tree →
 *   `tool-approval-response` carrying the user's decision
 *   (`approved` = `overlayPart.approval.approved`, i.e. approve or deny)
 * - `output-available` overlay vs unresolved tree → `tool-result`
 * - `output-error` overlay vs unresolved tree → `tool-result-error`
 * @param codecMessages - The visible tree messages paired with their codec-message-ids.
 * @param messages - useChat's local overlay messages.
 * @returns The continuation inputs to publish, in tree order. Each input
 *   carries its own `codecMessageId` targeting the prior assistant it folds
 *   onto.
 */
const deriveContinuationInputs = (
  codecMessages: CodecMessage<AI.UIMessage>[],
  messages: AI.UIMessage[],
): VercelInput[] => {
  const inputs: VercelInput[] = [];
  for (const overlay of messages) {
    if (overlay.role !== 'assistant') continue;
    // Match the overlay to its tree message by domain id (both sides
    // reconstruct the same stream id), but address the emitted inputs by
    // the tree message's codec-message-id — the agent folds tool
    // resolutions onto the assistant by codec-message-id, never by the
    // domain `message.id`.
    const treeEntry = codecMessages.find((p) => p.message.id === overlay.id);
    if (!treeEntry) continue;
    const { codecMessageId, message: treeMessage } = treeEntry;

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
      // overlay part to `approval-responded` while the tree still sits on
      // `approval-requested`. Publish a `tool-approval-response` TInput so the
      // agent's projection sees the decision.
      if (overlayPart.state === 'approval-responded' && (!treePart || treePart.state === 'approval-requested')) {
        inputs.push(
          UIMessageCodec.createToolApprovalResponse(codecMessageId, {
            toolCallId: overlayPart.toolCallId,
            approved: overlayPart.approval.approved,
            ...(overlayPart.approval.reason === undefined ? {} : { reason: overlayPart.approval.reason }),
          }),
        );
        continue;
      }

      // Client-tool resolution: overlay has `output-available` / `output-error`
      // while the tree's part is still unresolved. Construct a TInput
      // variant (not a UIMessageChunk) so the encoder publishes on the
      // `ai-input` wire — client tool results belong on `ai-input`, matching
      // their client publisher, not on `ai-output`.
      if (overlayPart.state !== 'output-available' && overlayPart.state !== 'output-error') continue;
      // Tree already resolved (echo arrived back) — nothing to do.
      if (treePart && !UNRESOLVED_TOOL_STATES.has(treePart.state)) continue;

      if (overlayPart.state === 'output-available') {
        inputs.push(
          UIMessageCodec.createToolResult(codecMessageId, {
            toolCallId: overlayPart.toolCallId,
            output: overlayPart.output,
          }),
        );
      } else {
        inputs.push(
          UIMessageCodec.createToolResultError(codecMessageId, {
            toolCallId: overlayPart.toolCallId,
            message: overlayPart.errorText,
          }),
        );
      }
    }
  }
  return inputs;
};

/**
 * Find the codec-message-id immediately preceding the message identified by
 * domain id `domainId` in the flat visible conversation. The target is
 * located by its domain `message.id` (the id useChat references), but the
 * returned value is the predecessor's codec-message-id — never a domain id.
 * Returns undefined if the target is the first message or not found.
 * @param codecMessages - Visible messages paired with their codec-message-ids.
 * @param domainId - The domain id of the target message.
 * @returns The predecessor's codec-message-id, or undefined.
 */
const findPredecessorCodecId = (codecMessages: CodecMessage<AI.UIMessage>[], domainId: string): string | undefined => {
  const idx = codecMessages.findIndex((p) => p.message.id === domainId);
  if (idx <= 0) return undefined;
  return codecMessages[idx - 1]?.codecMessageId;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Internal EventEmitter events map backing the transport's streaming state. */
interface ChatTransportEventsMap {
  /** Fired on every streaming-state transition with the new value. */
  streaming: boolean;
}

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
  // -- Invocation POST config (the transport owns waking the agent) ----------
  const api = chatOptions?.api ?? DEFAULT_VERCEL_API;
  const fetchFn = chatOptions?.fetch ?? globalThis.fetch.bind(globalThis);
  const credentials = chatOptions?.credentials;

  // -- Streaming state -------------------------------------------------------
  // Backed by the shared EventEmitter for listener error isolation (one bad
  // onStreamingChange handler can't prevent others from firing or block the
  // state transition) and uniform emitter behaviour across the SDK. The
  // factory takes no logger, so a silent one is used — listener exceptions are
  // swallowed by the emitter rather than surfaced.
  let _streaming = false;
  const emitter = new EventEmitter<ChatTransportEventsMap>(makeLogger({ logLevel: LogLevel.Silent }));

  const setStreaming = (value: boolean): void => {
    _streaming = value;
    emitter.emit('streaming', value);
  };

  // -- sendMessages implementation -------------------------------------------

  const sendMessages: ChatTransport['sendMessages'] = async (opts) => {
    const { messages, abortSignal, trigger, messageId } = opts;

    // The visible messages paired with their codec-message-ids. useChat
    // references messages by their domain `message.id`; we match on that to
    // locate a message in the tree, then route every transport operation by
    // the message's codec-message-id (the SDK never correlates on the domain
    // id, which may differ from the codec-message-id).
    const codecMessages = session.view.getMessages();
    const codecIdByDomainId = new Map(codecMessages.map((m) => [m.message.id, m.codecMessageId]));
    const codecIdOf = (domainId: string): string | undefined => codecIdByDomainId.get(domainId);

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
    const lastMessageInTree = !!lastMessage && codecIdByDomainId.has(lastMessage.id);
    const isContinuation = trigger === 'submit-message' && lastMessage?.role === 'assistant' && lastMessageInTree;

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
    // The domain id of the preceding assistant when it carries an unresolved
    // tool call and is present in the tree — the new user message forks off it.
    const forkSourceDomainId =
      precedingMessage && hasUnresolvedToolCall(precedingMessage) && codecIdByDomainId.has(precedingMessage.id)
        ? precedingMessage.id
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
      history = forkSourceDomainId ? messages.slice(0, -2) : messages.slice(0, -1);
    }

    // Compute fork metadata for edit (submit-message with messageId) and
    // fork-on-unresolved-tool. Regenerate is NOT precomputed here —
    // `View.regenerate` derives forkOf/parent from the tree itself and
    // overrides anything we'd set.
    let forkOf: string | undefined;
    let parent: string | undefined;

    if (trigger === 'submit-message' && messageId && !isContinuation) {
      // Edit: messageId is the domain id of the user message being replaced.
      // forkOf = its codec-message-id, parent = the immediately-preceding
      // codec-message-id in the flat conversation.
      forkOf = codecIdOf(messageId);
      parent = findPredecessorCodecId(codecMessages, messageId);
    } else if (forkSourceDomainId) {
      // Fork off the preceding assistant — the new user message becomes a
      // sibling of the unresolved tool call assistant, rooted at its parent.
      forkOf = codecIdOf(forkSourceDomainId);
      parent = findPredecessorCodecId(codecMessages, forkSourceDomainId);
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
      sendBody = {};
      sendHeaders = undefined;
    }

    const sendOpts: SendOptions = {};
    if (forkOf !== undefined) sendOpts.forkOf = forkOf;
    if (parent !== undefined) sendOpts.parent = parent;
    // Continuations reuse the suspended assistant's runId so the agent's
    // existing run resumes under a fresh invocation rather than spinning
    // up a brand-new run. `isContinuation` implies `lastMessage` is defined.
    if (isContinuation) {
      // `isContinuation` implies `lastMessage` is defined (it gates on
      // `lastMessage?.role`). Route the runId lookup by codec-message-id.
      const codecId = codecIdOf(lastMessage.id);
      const run = codecId === undefined ? undefined : session.view.runOf(codecId);
      if (run) sendOpts.runId = run.runId;
    }

    // Dispatch by mode:
    //
    // - Continuation: derive tool-resolution events from useChat's overlay
    //   vs the tree and pair each with the prior assistant's tree codec-message-id —
    //   the SDK stamps the wire's `codec-message-id` to that id so the
    //   reducer's direct fold path runs (no redirect, no consume).
    // - Regenerate: route through `view.regenerate`. The View mints a
    //   wire-only regenerate event (`ait-regenerate`) carrying
    //   `forkOf=A1` / `parent=U1` on transport headers. U1 is NOT
    //   republished — A1 and A2 group as tree siblings under U1 via the
    //   existing forkOf machinery. The LLM receives the truncated history
    //   through U1 inclusive via the body.
    // - Fresh send / edit: publish the new user-message input(s) via
    //   `view.send`.
    let run: ActiveRun;
    if (isContinuation) {
      const inputs = deriveContinuationInputs(codecMessages, messages);
      run = await session.view.send(inputs, sendOpts);
    } else if (trigger === 'regenerate-message') {
      if (messageId === undefined) {
        throw new Ably.ErrorInfo(
          'unable to regenerate; regenerate-message trigger fired without messageId',
          ErrorCode.InvalidArgument,
          400,
        );
      }
      // useChat passes the assistant's domain id; route by its codec-message-id.
      const regenCodecId = codecIdOf(messageId);
      if (regenCodecId === undefined) {
        throw new Ably.ErrorInfo(
          `unable to regenerate; message not visible: ${messageId}`,
          ErrorCode.InvalidArgument,
          400,
        );
      }
      run = await session.view.regenerate(regenCodecId, sendOpts);
    } else {
      const inputs = newMessages.map((m) => UIMessageCodec.createUserMessage(m));
      run = await session.view.send(inputs, sendOpts);
    }

    // Build the consumer-facing stream from the Tree's events for this run.
    // Streaming is a useChat concern owned by the Vercel layer; the core
    // session exposes no per-run stream. Key it on
    // `run.inputCodecMessageId` — the triggering input's codec-message-id, which
    // the client owns from send time and the agent echoes as
    // `input-codec-message-id`. The agent mints the runId, supplied as
    // `run.runId` (a promise) for the run-end safety-net.
    const runStream = createRunOutputStream(session, run.runId, run.inputCodecMessageId);

    if (abortSignal) {
      const onAbort = (): void => {
        // Best-effort cancel via the run handle (knows its own key / runId);
        // the core resolves the runId once the agent mints it.
        void run.cancel();
        // Close the consumer stream immediately so useChat's reader ends
        // without waiting for the agent's run-end round-trip.
        runStream.close();
      };
      // useChat sets `status: 'submitted'` synchronously inside `makeRequest`
      // BEFORE awaiting `transport.sendMessages`. That immediately enables
      // the Stop button in the UI. If the user clicks Stop while
      // `session.view.send` is still awaiting the run-start ack (which
      // can take seconds for a real LLM), useChat aborts the signal before
      // we ever get here. `addEventListener('abort', ...)` does not fire
      // for an already-aborted signal, so we'd silently lose the cancel
      // and the agent would keep streaming.
      if (abortSignal.aborted) {
        onAbort();
      } else {
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }
    }

    // Wrap the stream to detect completion. The streaming flag gates
    // useMessageSync so that setMessages doesn't interfere with
    // useChat's internal write() during active streams.
    const { stream, done, fail } = wrapStreamWithDone(runStream.stream);
    setStreaming(true);

    // Fire-and-forget: clear the streaming flag when the stream ends.
    void done.then(() => {
      setStreaming(false);
    });

    // Wake the agent: POST the invocation pointer to the configured endpoint.
    // useChat's transport contract is request-driven, so the transport owns
    // this POST (the core session is HTTP-free). Fire-and-forget — `await`
    // would delay the stream return, and the agent's response arrives over
    // the Ably channel, not the HTTP response. The run's invocation
    // identifiers always win over any custom body so the agent can parse it
    // via Invocation.fromJSON. A failed POST means the agent never woke, so
    // error the useChat-facing stream; the core run and observers are
    // untouched.
    const postBody = { ...sendBody, ...run.toInvocation().toJSON() };
    fetchFn(api, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...sendHeaders },
      body: JSON.stringify(postBody),
      ...(credentials ? { credentials } : {}),
    })
      .then((response) => {
        if (!response.ok) {
          fail(
            new Ably.ErrorInfo(
              `unable to send; HTTP POST to ${api} returned ${String(response.status)} ${response.statusText}`,
              ErrorCode.SessionSendFailed,
              response.status,
            ),
          );
        }
      })
      .catch((error: unknown) => {
        const cause = error instanceof Ably.ErrorInfo ? error : undefined;
        fail(
          new Ably.ErrorInfo(
            `unable to send; HTTP POST to ${api} failed: ${error instanceof Error ? error.message : String(error)}`,
            ErrorCode.SessionSendFailed,
            500,
            cause,
          ),
        );
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
      emitter.on('streaming', callback);
      return () => {
        emitter.off('streaming', callback);
      };
    },
  };
};
