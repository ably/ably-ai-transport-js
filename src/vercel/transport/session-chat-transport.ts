/**
 * Vercel chat transport: wraps a core ClientSession to satisfy the
 * SessionChatTransport interface that useChat expects.
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
// Named import for the one SDK type used in an `extends` heritage clause: the
// `import-x/namespace` resolver can't verify a namespaced generic there
// (`AI.ChatTransport<…>`) though tsc resolves it fine. Everything else uses the
// `AI.*` namespace per TYPES.md.
import type { ChatTransport as SdkChatTransport } from 'ai';

import type { CodecMessage, DefinedCodec } from '../../core/transport/session-codec.js';
import type { ClientRun, ClientSession, SendOptions } from '../../core/transport/types.js';
import { ErrorCode } from '../../errors.js';
import { EventEmitter } from '../../event-emitter.js';
import { LogLevel, makeLogger } from '../../logger.js';
import { errorCause, errorMessage } from '../../utils.js';
import type { VercelOutput } from '../codec/index.js';
import type { VercelProjection } from '../codec/reducer.js';
import { createUIMessageSessionCodec } from '../codec/session-codec.js';
import type { ForkSeed, VercelSessionInput } from '../codec/session-events.js';
import { isToolPart, type ToolPart } from '../tool-part.js';
import { createDeferredContinuationStream, createRunOutputStream } from './run-output-stream.js';

// ---------------------------------------------------------------------------
// SessionChatTransport options
// ---------------------------------------------------------------------------

/**
 * Context passed to {@link SessionChatTransportOptions.prepareSendMessagesRequest} for
 * customizing the HTTP POST body and headers.
 *
 * The generic params thread through `history` / `messages` so a consumer's
 * `AI.UIMessage` typing is preserved in the request hook; each defaults to the
 * SDK default.
 * @template TMetadata - Per-message metadata type on the context messages.
 * @template TDataParts - Custom data-part types on the context messages.
 * @template TTools - Tool set typing the context messages' tool parts.
 */
export interface SessionSendMessagesRequestContext<
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
  TTools extends AI.UITools = AI.UITools,
> {
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
  history: AI.UIMessage<TMetadata, TDataParts, TTools>[];
  /** The new message(s) being sent (to publish to the channel). Empty for regeneration and for continuations (an auto-submit where the last message is an already-tracked assistant). */
  messages: AI.UIMessage<TMetadata, TDataParts, TTools>[];
  /** The codec-message-id of the message being forked — the edited user message, or the preceding assistant when forking off an unresolved tool call. Undefined for regeneration (View.regenerate derives it) and fresh sends. */
  forkOf?: string;
  /** The codec-message-id of the predecessor in the conversation thread. */
  parent?: string;
}

/** Default agent endpoint the transport POSTs invocations to — mirrors Vercel's DefaultChatTransport. */
const DEFAULT_VERCEL_API = '/api/chat';

/**
 * Options for customizing the SessionChatTransport behavior.
 *
 * The generic params thread through the {@link SessionSendMessagesRequestContext}
 * passed to `prepareSendMessagesRequest`; each defaults to the SDK default.
 * @template TMetadata - Per-message metadata type on the request context messages.
 * @template TDataParts - Custom data-part types on the request context messages.
 * @template TTools - Tool set typing the request context messages' tool parts.
 */
export interface SessionChatTransportOptions<
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
  TTools extends AI.UITools = AI.UITools,
> {
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
  prepareSendMessagesRequest?: (context: SessionSendMessagesRequestContext<TMetadata, TDataParts, TTools>) => {
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
  };
}

// ---------------------------------------------------------------------------
// SessionChatTransport interface
// ---------------------------------------------------------------------------

/**
 * Transport interface for Vercel AI SDK's useChat hook.
 *
 * Extends the AI SDK's `AI.ChatTransport<AI.UIMessage<…>>` — inheriting
 * `sendMessages` / `reconnectToStream` (both typed to the consumer's UIMessage,
 * carrying the SDK's `AI.ChatRequestOptions`) — with `close()` for releasing the
 * underlying Ably transport resources and `streaming` / `onStreamingChange` for
 * coordinating with useMessageSync.
 *
 * The generic params thread the consumer's `AI.UIMessage` typing through
 * `sendMessages`' `messages`; each defaults to the SDK default.
 * @template TMetadata - Per-message metadata type.
 * @template TDataParts - Custom data-part types.
 * @template TTools - Tool set typing tool parts.
 */
export interface SessionChatTransport<
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
  TTools extends AI.UITools = AI.UITools,
> extends SdkChatTransport<AI.UIMessage<TMetadata, TDataParts, TTools>> {
  /** Close the underlying transport, releasing all resources. */
  close(): Promise<void>;

  /** Whether an own-run stream is currently being consumed by useChat. */
  readonly streaming: boolean;

  /**
   * Subscribe to streaming state changes. The callback fires when the
   * SessionChatTransport transitions between streaming and idle. Used by
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
 * Whether an assistant message has a tool part that can't resolve
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
      isToolPart(p) &&
      (p.state === 'input-streaming' || p.state === 'input-available' || p.state === 'approval-requested'),
  );

/**
 * Tool-part states that mean "the LLM produced a tool call and is waiting on
 * it". Used to detect new client-side resolutions in the useChat overlay
 * relative to the tree.
 */
const UNRESOLVED_TOOL_STATES = new Set(['input-streaming', 'input-available', 'approval-requested']);

/**
 * Walk the useChat message overlay against the session tree and synthesize
 * the {@link VercelSessionInput}s needed to resolve every tool part the user acted on
 * (executed a tool, approved, denied) but the tree's reduced state hasn't
 * reflected yet.
 *
 * Each input carries the prior assistant's tree codec-message-id (the one
 * holding the original tool part the resolution targets) in its
 * `codecMessageId` field, so the encoder stamps `codec-message-id`
 * and the reducer's direct-fold path lands the resolution on that assistant
 * in one step — no cross-message redirect-by-toolCallId fallback. Every
 * variant rides the `ai-input` wire, matching its publisher (client → input).
 *
 * The resulting inputs are passed alongside the continuation `view.send`
 * so the channel publish and the continuation POST land as ONE atomic
 * operation — the agent's `run.view` history walk is guaranteed
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
 *
 * **Fork mode** (`fork.seed` set): a client tool-result continuation opens its
 * OWN reply run (a sibling of the suspended run) so that concurrent answers to
 * one tool call become segregated branches rather than colliding on the shared
 * run. The resolutions then address a FRESH per-message codec-message-id (from
 * the seed) instead of the tree assistant's, and each tool-result /
 * tool-result-error carries the {@link ForkSeed} — a copy of the suspended run's
 * FULL message list under fresh ids — so the reducer reconstructs the whole run
 * (prior resolved tool calls included) inside the fork's own projection before
 * folding this client's result. Seeding the whole run keeps context across
 * SEQUENTIAL client tool calls. Approval responses carry no seed: they land on
 * the reconstructed assistant via the pending-resolution buffer once a
 * co-resolved result seeds it.
 * @template TMetadata - Per-message metadata type carried by the produced inputs.
 * @template TDataParts - Custom data-part types carried by the produced inputs.
 * @template TTools - Tool set typing the produced inputs' tool parts.
 * @param codec - The codec whose well-known input factories build the resolutions.
 * @param codecMessages - The visible tree messages paired with their codec-message-ids.
 * @param messages - useChat's local overlay messages.
 * @param fork - When set, produce fork-run inputs (fresh per-message ids + the
 *   full seed per the description above); omit for an ordinary in-place resolution.
 * @param fork.seed - The suspended run's full message list, each entry under a
 *   fresh client-minted codec-message-id (one such seed per continuation).
 * @returns The continuation inputs to publish, in tree order.
 */
const deriveContinuationInputs = <TMetadata, TDataParts extends AI.UIDataTypes, TTools extends AI.UITools>(
  codec: DefinedCodec<
    VercelSessionInput<TMetadata, TDataParts, TTools>,
    VercelOutput<TMetadata, TDataParts>,
    VercelProjection<TMetadata, TDataParts, TTools>,
    AI.UIMessage<TMetadata, TDataParts, TTools>
  >,
  codecMessages: CodecMessage<AI.UIMessage>[],
  messages: AI.UIMessage[],
  fork?: { seed: ForkSeed },
): VercelSessionInput<TMetadata, TDataParts, TTools>[] => {
  // In fork mode the result's target is the fresh codec-message-id of the seed
  // message carrying the tool call (the message the reducer reconstructs and
  // folds onto). Off the fork path the target is the tree assistant's own id.
  const forkTargetOf = (toolCallId: string): string | undefined =>
    fork?.seed.messages.find((m) => m.message.parts.some((p) => isToolPart(p) && p.toolCallId === toolCallId))
      ?.codecMessageId;

  const inputs: VercelSessionInput<TMetadata, TDataParts, TTools>[] = [];
  for (const overlay of messages) {
    if (overlay.role !== 'assistant') continue;
    // Match the overlay to its tree message by domain id (both sides
    // reconstruct the same stream id), but address the emitted inputs by
    // the tree message's codec-message-id — the agent folds tool
    // resolutions onto the assistant by codec-message-id, never by the
    // domain `message.id`. In fork mode the target is instead the fresh
    // codec-message-id the reconstructed message takes.
    const treeEntry = codecMessages.find((p) => p.message.id === overlay.id);
    if (!treeEntry) continue;
    const { codecMessageId, message: treeMessage } = treeEntry;

    for (const overlayPart of overlay.parts) {
      if (!isToolPart(overlayPart)) continue;
      // The tree and the useChat overlay may each carry a tool part in either
      // representation (`dynamic-tool` or `tool-${name}`). Match by toolCallId
      // rather than the type prefix so the comparison holds regardless of how
      // the tool was declared on each side.
      const treePart = treeMessage.parts.find(
        (p: AI.UIMessage['parts'][number]): p is ToolPart => isToolPart(p) && p.toolCallId === overlayPart.toolCallId,
      );

      // The target: in fork mode the fresh id of the seed message carrying this
      // tool call; off the fork path the tree assistant's own codec-message-id.
      // In fork mode a tool call the seed does NOT carry cannot be reconstructed
      // (the seed's ids are fresh, so folding it onto the tree id would pend
      // forever against a message the fork projection never holds) — skip it
      // rather than emit a doomed resolution. Unreachable in the normal single-
      // run continuation (the suspended tool call is always in the run's seed).
      const forkTarget = fork ? forkTargetOf(overlayPart.toolCallId) : undefined;
      if (fork !== undefined && forkTarget === undefined) continue;
      const target = forkTarget ?? codecMessageId;

      // Approval response: useChat's `addToolApprovalResponse` flipped the
      // overlay part to `approval-responded` while the tree still sits on
      // `approval-requested`. Publish a `tool-approval-response` TInput so the
      // agent's projection sees the decision.
      if (overlayPart.state === 'approval-responded' && (!treePart || treePart.state === 'approval-requested')) {
        inputs.push(
          codec.createToolApprovalResponse(target, {
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
          codec.createToolResult(target, {
            toolCallId: overlayPart.toolCallId,
            output: overlayPart.output,
            ...(fork === undefined ? {} : { forkSeed: fork.seed }),
          }),
        );
      } else {
        inputs.push(
          codec.createToolResultError(target, {
            toolCallId: overlayPart.toolCallId,
            message: overlayPart.errorText,
            ...(fork === undefined ? {} : { forkSeed: fork.seed }),
          }),
        );
      }
    }
  }
  return inputs;
};

/**
 * Whether a derived continuation input is a client tool result — the trigger
 * that makes a continuation fork its own reply run (an approval response or an
 * empty continuation does not).
 * @param input - A derived continuation input.
 * @returns True for `tool-result` / `tool-result-error`.
 */
const isToolResultInput = (input: VercelSessionInput): boolean =>
  input.kind === 'tool-result' || input.kind === 'tool-result-error';

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
 * Create a Vercel SessionChatTransport from a core ClientSession.
 *
 * Exposes a `streaming` flag and `onStreamingChange` callback so that
 * `useMessageSync` can gate `setMessages` calls during active own-run
 * streams, preventing the push/replace ID mismatch in useChat's `write()`.
 *
 * Note: concurrent `sendMessage` calls from the same user are a useChat
 * limitation that cannot be fixed from the transport layer. The
 * developer must respect useChat's `status` and only call `sendMessage`
 * when status is `'ready'`.
 * @template TMetadata - Per-message metadata type (defaults to the SDK default).
 * @template TDataParts - Custom data-part types (defaults to the SDK default).
 * @template TTools - Tool set typing tool parts (defaults to the SDK default).
 * @param session - The core client session to wrap.
 * @param chatOptions - Optional hooks for customizing request construction.
 * @returns A {@link SessionChatTransport} compatible with Vercel's useChat hook.
 */
export const createSessionChatTransport = <
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
  TTools extends AI.UITools = AI.UITools,
>(
  session: ClientSession<
    VercelSessionInput<TMetadata, TDataParts, TTools>,
    VercelOutput<TMetadata, TDataParts>,
    VercelProjection<TMetadata, TDataParts, TTools>,
    AI.UIMessage<TMetadata, TDataParts, TTools>
  >,
  chatOptions?: SessionChatTransportOptions<TMetadata, TDataParts, TTools>,
): SessionChatTransport<TMetadata, TDataParts, TTools> => {
  // Codec instance typed to the consumer's UIMessage params, used to build the
  // well-known input factories (createUserMessage + the tool resolutions) so
  // the inputs published on this session carry the caller's message type.
  const codec = createUIMessageSessionCodec<TMetadata, TDataParts, TTools>();

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

  const sendMessages: SessionChatTransport<TMetadata, TDataParts, TTools>['sendMessages'] = async (opts) => {
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

    // For a continuation, derive the tool-resolution inputs up front so we can
    // detect the "nothing to send" case before any send/POST work, and decide
    // whether this continuation forks.
    const baseContinuationInputs = isContinuation ? deriveContinuationInputs(codec, codecMessages, messages) : [];

    // A continuation carrying a CLIENT TOOL RESULT forks into its own reply run
    // (a sibling of the suspended run) so that concurrent answers to one tool
    // call become segregated branches instead of colliding on the shared run
    // (last-writer-wins on the tool part + both follow-ups in one projection).
    // Pure-approval / empty continuations keep re-entering the suspended run.
    const shouldForkContinuation = isContinuation && baseContinuationInputs.some((input) => isToolResultInput(input));

    // The suspended run this continuation targets — the assistant's run, looked
    // up by its codec-message-id. `isContinuation` implies `lastMessage` is
    // defined (it gates on `lastMessage?.role`, which TypeScript narrows here).
    let continuationRunId: string | undefined;
    // The fork's structural parent: the suspended run's OWN input node, so the
    // fork is a same-parent sibling (the trunk stays off the fork's branch).
    let forkParent: string | undefined;
    // The fork seed: the suspended run's FULL projection reconstructed under
    // fresh client-minted codec-message-ids, so the fork run is self-contained
    // with full history (prior resolved tool calls included, not just the
    // current tool-call assistant) — preserving context across SEQUENTIAL
    // client tool calls.
    let forkSeed: ForkSeed | undefined;
    if (isContinuation) {
      const codecId = codecIdOf(lastMessage.id);
      continuationRunId = codecId === undefined ? undefined : session.view.runOf(codecId)?.runId;
      if (shouldForkContinuation && continuationRunId !== undefined) {
        const trunk = session.tree.getRunNode(continuationRunId);
        if (trunk?.kind === 'run') {
          forkParent = trunk.parentCodecMessageId;
          forkSeed = {
            messages: codec.getMessages(trunk.projection).map((rm) => ({
              codecMessageId: crypto.randomUUID(),
              message: rm.message,
            })),
          };
        }
      }
    }

    // Whether this continuation forks its own reply run: a client tool result
    // WITH a resolvable parent. Gate on the parent — never fork without one (a
    // run-less fork with no parent would be a detached root, not a same-parent
    // sibling); when unresolvable, fall back to the re-enter path below. The
    // fork is published RUN-LESS: the AGENT mints the fork's run-id on
    // `ai-run-start`, and the tree reconciles this client's optimistic reply run
    // onto it by the tool-result's codec-message-id — so two tabs answering the
    // same tool call open two independent branches with no client-minted-id
    // clobber, restoring "agent owns run-ids, client owns codec-message-ids".
    const isForkContinuation = shouldForkContinuation && forkParent !== undefined && forkSeed !== undefined;

    // Fork inputs re-address the resolutions at fresh per-message codec-message-ids
    // and carry the full reconstruction seed; the non-fork path keeps the inputs as-is.
    const continuationInputs =
      isForkContinuation && forkSeed !== undefined
        ? deriveContinuationInputs(codec, codecMessages, messages, { seed: forkSeed })
        : baseContinuationInputs;

    // Empty continuation: every overlay tool resolution is already reflected on
    // the visible branch — e.g. the client's own fork run has resolved and is
    // the selected sibling, or another tab's fork is what the view shows. There
    // is nothing to send: view.send([]) would throw, and returning an
    // immediately-closing stream would make useChat's sendAutomaticallyWhen
    // resubmit in a loop. Instead, observe the run driving that branch and keep
    // useChat in `streaming` until it produces its next turn; closing then lets
    // useMessageSync repaint the overlay from the Tree, at which point
    // sendAutomaticallyWhen is satisfied. We do NOT wake the agent here.
    if (isContinuation && continuationInputs.length === 0) {
      const observe = createDeferredContinuationStream(session, continuationRunId);

      if (abortSignal) {
        // We don't own this run, so there's nothing to cancel — just close the
        // consumer stream. useChat may abort before we reach here, and
        // addEventListener does not fire for an already-aborted signal.
        const onAbort = (): void => {
          observe.close();
        };
        if (abortSignal.aborted) {
          onAbort();
        } else {
          abortSignal.addEventListener('abort', onAbort, { once: true });
        }
      }

      const { stream, done } = wrapStreamWithDone(observe.stream);
      setStreaming(true);
      void done.then(() => {
        setStreaming(false);
      });
      return stream;
    }

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
    let newMessages: AI.UIMessage<TMetadata, TDataParts, TTools>[];
    let history: AI.UIMessage<TMetadata, TDataParts, TTools>[];

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
      newMessages = [messages.at(-1) as AI.UIMessage<TMetadata, TDataParts, TTools>];
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
    if (isForkContinuation) {
      // Fork continuation: published RUN-LESS (no runId). The agent mints the
      // fork's run-id on `ai-run-start`; the tree reconciles this client's
      // optimistic reply run onto it by the tool-result's codec-message-id.
      // `parent` roots the fork at the suspended run's own input node (a
      // same-parent sibling, so the trunk stays off the fork's branch), and
      // `role: 'assistant'` marks the run-less input as a reconstructed
      // assistant turn so the tree classifies it as a reply run, not an input
      // node.
      if (forkParent !== undefined) sendOpts.parent = forkParent;
      sendOpts.role = 'assistant';
      // Supersede the suspended run this fork resolves: it is now dead (nothing
      // resumes it), so the tree hides it from branch selection. A single
      // client's single response thus renders as ONE linear reply; only
      // genuinely concurrent forks (each superseding the same trunk) branch.
      if (continuationRunId !== undefined) sendOpts.supersedes = continuationRunId;
    } else if (continuationRunId !== undefined) {
      // Non-fork continuation (e.g. an approval response): re-enter the
      // suspended run under a fresh invocation via `ai-run-resume`.
      sendOpts.runId = continuationRunId;
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
    let run: ClientRun<VercelSessionInput, AI.UIMessage<TMetadata, TDataParts, TTools>>;
    if (isContinuation) {
      // Non-empty here: the empty case returned the deferred-observe stream above.
      run = await session.view.send(continuationInputs, sendOpts);
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
      const inputs = newMessages.map((m) => codec.createUserMessage(m));
      run = await session.view.send(inputs, sendOpts);
    }

    // Build the consumer-facing stream from the Tree's events for this run.
    // Streaming is a useChat concern owned by the Vercel layer; the core
    // session exposes no per-run stream. Key it on
    // `run.inputCodecMessageId` — the triggering input's codec-message-id, which
    // the client owns from send time and the agent echoes as
    // `input-codec-message-id`. The agent mints the runId; the run-end
    // safety-net needs it as a promise, so resolve it from `run.started`
    // (`.then(() => value)` adapts the void latch into the awaited run-id).
    const runIdPromise = run.started.then(() => run.runId);
    const runStream = createRunOutputStream(session, runIdPromise, run.inputCodecMessageId);

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
        fail(
          new Ably.ErrorInfo(
            `unable to send; HTTP POST to ${api} failed: ${errorMessage(error)}`,
            ErrorCode.SessionSendFailed,
            500,
            errorCause(error),
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
    // eslint-disable-next-line unicorn/no-null, @typescript-eslint/promise-function-async -- null is required by the AI SDK SessionChatTransport contract; no await needed
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
