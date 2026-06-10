/**
 * Core agent (server-side) session, parameterized by codec.
 *
 * Composes RunManager and pipeStream to handle the full server-side run
 * lifecycle. Cancel message routing is handled directly by the session's
 * single channel subscription — no separate cancel manager needed.
 *
 * The session exposes a single factory method — `createRun()` — which returns
 * a Run object with explicit lifecycle methods: start(), pipe(), suspend(),
 * and end() (suspend() and end() are both terminal).
 */

import * as Ably from 'ably';

import {
  EVENT_CANCEL,
  HEADER_CODEC_MESSAGE_ID,
  HEADER_EVENT_ID,
  HEADER_FORK_OF,
  HEADER_INPUT_CODEC_MESSAGE_ID,
  HEADER_MSG_REGENERATE,
  HEADER_PARENT,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_ID,
} from '../../constants.js';
import { ErrorCode } from '../../errors.js';
import { type Logger, LogLevel, makeLogger } from '../../logger.js';
import { compareBySerial, getTransportHeaders } from '../../utils.js';
import { registerAgent } from '../agent.js';
import type { Codec, CodecInputEvent, CodecOutputEvent, Decoder } from '../codec/types.js';
import { applyWireMessage } from './decode-fold.js';
import { buildTransportHeaders } from './headers.js';
import { evictOldestIfFull } from './internal/bounded-map.js';
import { Invocation } from './invocation.js';
import { loadHistoryPages } from './load-history-pages.js';
import { pipeStream } from './pipe-stream.js';
import type { RunManager } from './run-manager.js';
import { createRunManager } from './run-manager.js';
import { createTree, type DefaultTree } from './tree.js';
import type {
  AgentSession,
  AgentSessionOptions,
  CancelRequest,
  ConversationNode,
  LoadConversationOptions,
  PipeOptions,
  Run,
  RunEndReason,
  RunRuntime,
  RunView,
  StreamResult,
  Tree,
} from './types.js';

// ---------------------------------------------------------------------------
// Input-event lookup result
// ---------------------------------------------------------------------------

/**
 * Result of {@link DefaultAgentSession._findInputEvent}. The lookup races
 * the session's Tree (`findWireByEventId` pre-scan + `'ably-message'` event
 * for live arrivals) against a bounded `loadHistoryPages` fetch; resolves
 * with the matched messages sorted by Ably `serial` ascending.
 *
 * Run.start reads `firstHeaders` / `firstClientId` from the smallest-serial
 * matched message to derive per-run metadata (run-id, parent, forkOf,
 * continuation flag, publisher clientId). The Tree has already folded
 * each message by the time the lookup resolves, so callers do NOT need to
 * decode the raw matched messages themselves.
 */
interface InputEventLookupResult {
  /** Raw Ably messages matched by the lookup, sorted by serial ascending. */
  rawMessages: Ably.InboundMessage[];
  /** Transport headers of the smallest-serial matched message (run metadata). */
  firstHeaders?: Record<string, string>;
  /** Publisher's Ably channel-level `clientId` from the smallest-serial message. */
  firstClientId?: string;
}

// ---------------------------------------------------------------------------
// Ancestor-chain walk over the Tree
// ---------------------------------------------------------------------------

/**
 * Walk parent pointers from an anchor codec-message-id back through the
 * Tree to the conversation root, returning nodes in root-first order. When
 * `maxRuns` is set, the walk stops after collecting that many reply
 * RunNodes (input nodes encountered alongside don't count toward the bound).
 *
 * Returns an empty array when the anchor isn't in the Tree.
 * @param tree - The materialisation tree to walk.
 * @param anchor - The codec-message-id to start from (typically the current run's input).
 * @param maxRuns - Optional bound on the number of reply RunNodes in the chain.
 * @returns Nodes from root to anchor in chronological order.
 */
const walkAncestorChain = <TOutput extends CodecOutputEvent, TProjection>(
  tree: Tree<TOutput, TProjection>,
  anchor: string | undefined,
  maxRuns?: number,
): readonly ConversationNode<TProjection>[] => {
  if (anchor === undefined) return [];
  const chain: ConversationNode<TProjection>[] = [];
  let current = tree.getNodeByCodecMessageId(anchor);
  const seen = new Set<string>();
  while (current !== undefined) {
    // Defensive cycle guard — `parentCodecMessageId` chains should be DAGs;
    // a cycle indicates Tree corruption but we don't want to infinite-loop.
    const key = current.kind === 'run' ? current.runId : current.codecMessageId;
    if (seen.has(key)) break;
    seen.add(key);
    chain.unshift(current);
    if (maxRuns !== undefined && countReplyRuns(chain) >= maxRuns) break;
    const parentId = current.parentCodecMessageId;
    if (parentId === undefined) break;
    current = tree.getNodeByCodecMessageId(parentId);
  }
  return chain;
};

/**
 * Count the reply RunNodes in an ancestor chain. Used to bound the walk
 * via the `maxRuns` option.
 * @param chain - Ancestor chain to count over.
 * @returns Number of reply RunNodes in the chain.
 */
const countReplyRuns = <TProjection>(chain: readonly ConversationNode<TProjection>[]): number => {
  let count = 0;
  for (const node of chain) if (node.kind === 'run') count++;
  return count;
};

/**
 * Extract a human-readable message from an unknown thrown value.
 * @param error - The thrown value.
 * @returns The error's message, or its string form.
 */
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Wrap an unknown history-walk failure as `Ably.ErrorInfo`, preserving the
 * original code/statusCode when the failure already carried them and
 * attaching the original as `cause`. Falls back to `HistoryFetchFailed`.
 * @param operation - The failed operation, phrased for an `unable to <operation>; <reason>` message.
 * @param error - The thrown value.
 * @returns The wrapped error.
 */
const wrapHistoryError = (operation: string, error: unknown): Ably.ErrorInfo => {
  const errInfo = error instanceof Ably.ErrorInfo ? error : undefined;
  return new Ably.ErrorInfo(
    `unable to ${operation}; ${errorMessage(error)}`,
    errInfo?.code ?? ErrorCode.HistoryFetchFailed,
    errInfo?.statusCode ?? 500,
    errInfo,
  );
};

// ---------------------------------------------------------------------------
// Internal run record for cancel routing
// ---------------------------------------------------------------------------

interface RegisteredRun {
  runId: string;
  /** Invocation-id this run is associated with, minted by the agent at `createRun` (or the `runtime.invocationId` override). */
  invocationId: string;
  controller: AbortController;
  /** Composite signal that fires when either the internal controller or the external signal aborts. */
  signal: AbortSignal;
  onCancel?: (request: CancelRequest) => Promise<boolean>;
  onError?: (error: Ably.ErrorInfo) => void;
}

// ---------------------------------------------------------------------------
// Internal state machines
// ---------------------------------------------------------------------------

enum SessionState {
  READY = 'ready',
  CLOSED = 'closed',
}

enum RunState {
  INITIALIZED = 'initialized',
  STARTED = 'started',
  ENDED = 'ended',
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

// Spec: AIT-ST1
class DefaultAgentSession<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> implements AgentSession<TOutput, TProjection, TMessage> {
  private readonly _channel: Ably.RealtimeChannel;
  private readonly _codec: Codec<TInput, TOutput, TProjection, TMessage>;
  private readonly _logger: Logger | undefined;
  private readonly _onError: ((error: Ably.ErrorInfo) => void) | undefined;
  private readonly _runManager: RunManager;
  private readonly _registeredRuns = new Map<string, RegisteredRun>();
  /**
   * Reverse index from a run's triggering input codec-message-id to its
   * run-id, populated once `Run.start()`'s input-event lookup resolves the
   * triggering input. Lets `_handleCancelMessage` route a cancel keyed by the
   * input codec-message-id (a fresh send whose run-id the client doesn't know)
   * to the registered run. Entries are removed when the run ends / suspends /
   * the session closes, alongside `_registeredRuns`.
   */
  private readonly _runIdByInputCodecMessageId = new Map<string, string>();
  /**
   * Cancels buffered by triggering input codec-message-id when they arrived
   * before the run was known — i.e. before `Run.start()`'s input-event lookup
   * resolved that input to a run. A fresh run has no run-id at the client's
   * send time (the agent mints it at run-start), so an early cancel can only be
   * keyed by the input codec-message-id, and the `inputCodecMessageId → run`
   * linkage doesn't exist until the lookup completes. `Run.start()` consults
   * this buffer as a PULL once it resolves its `resolvedInputCodecMessageId`,
   * honouring any cancel that arrived first. Cleared on `close()`.
   */
  private readonly _deferredCancels = new Map<string, Ably.InboundMessage>();
  /**
   * Session-owned materialisation tree. Every message (live + history) folds
   * through `applyWireMessage(this._tree, this._decoder, msg)`; conversation
   * state is read by walking parent pointers from the input node.
   *
   * Replaced (not cleared in place) on channel continuity loss so that the
   * fresh tree starts empty. The old tree is abandoned to GC once in-flight
   * lookups have aborted.
   */
  private _tree: DefaultTree<TInput, TOutput, TProjection>;
  /**
   * Single shared inbound decoder threaded through every `applyWireMessage`
   * call (live + history). Streaming-across-pages folds correctly because
   * the decoder keeps stream-tracker state across messages. Outbound encoders
   * (used by `Run.pipe`) manage their own decoders.
   */
  private _decoder: Decoder<TInput, TOutput>;
  /**
   * Single-slot promise mutex for history-page hydration. Concurrent
   * `loadConversation` calls that both need to extend the Tree's ancestor
   * coverage serialise through this so we issue at most one history fetch
   * per overlapping extension request.
   */
  private _hydrationMutex: Promise<void> | undefined;
  /**
   * True once a hydration walk has driven channel history to exhaustion for
   * the current attach epoch: everything older than the attach point is
   * already folded into the Tree, so a further backwards fetch cannot reveal
   * more. Lets concurrent / subsequent `loadConversation` calls skip
   * redundant full-channel re-walks. Reset on continuity-loss Tree swap
   * (the fresh Tree starts empty and must re-hydrate).
   */
  private _historyExhausted = false;
  /**
   * Set of Ably message serials already folded into the Tree. Both the live
   * channel listener and `_hydrateAncestors` consult this before
   * `applyWireMessage` — guards against double-folds when a message is
   * delivered live AND returned by a subsequent history fetch (overlap can
   * happen at the attachSerial boundary or in test mocks that don't
   * partition live vs history).
   *
   * Bounded by the Tree's lifetime — cleared on continuity-loss Tree swap.
   */
  private _foldedSerials = new Set<string>();
  private readonly _channelListener: (msg: Ably.InboundMessage) => void;
  private readonly _inputEventLookupTimeoutMs: number;
  /**
   * Lookback bound for `findInputEvent`'s history scan: stop paginating
   * when the oldest message in a page is older than
   * `Date.now() - _inputEventLookbackMs`.
   */
  private readonly _inputEventLookbackMs: number;

  private _state = SessionState.READY;
  private _connectPromise: Promise<void> | undefined;
  private _hasAttachedOnce: boolean;
  private readonly _onChannelStateChange: Ably.channelEventCallback;

  constructor(options: AgentSessionOptions<TInput, TOutput, TProjection, TMessage>) {
    this._codec = options.codec;
    // Spec: AIT-ST1a, AIT-ST1a2 — register this SDK on both the connection
    // (options.agents) and channel-attach (params.agent) paths. Idempotent
    // across sessions sharing one client.
    const registerOptions = registerAgent(options.client, options.codec);
    this._channel = options.client.channels.get(options.channelName, registerOptions);
    this._logger = options.logger?.withContext({ component: 'AgentSession' });
    this._onError = options.onError;
    this._runManager = createRunManager(this._channel, this._logger);
    this._inputEventLookupTimeoutMs = options.inputEventLookupTimeoutMs ?? 30000;
    this._inputEventLookbackMs = options.inputEventLookbackMs ?? 120_000;
    this._tree = createTree<TInput, TOutput, TProjection>(
      this._codec,
      this._logger ?? makeLogger({ logLevel: LogLevel.Silent }),
    );
    this._decoder = this._codec.createDecoder();

    this._channelListener = (msg: Ably.InboundMessage) => {
      this._handleChannelMessage(msg);
    };

    // Spec: AIT-ST12, AIT-ST12a
    // Listen for channel state changes that break message continuity. The
    // session only consumes cancel messages from the channel, so losing one
    // is survivable — but the developer needs to know so they can decide
    // whether to cancel in-flight work. _hasAttachedOnce is seeded from the
    // channel's current state so pre-attached channels are handled correctly;
    // it distinguishes the initial attach from a genuine discontinuity.
    this._hasAttachedOnce = this._channel.state === 'attached';
    this._onChannelStateChange = (stateChange: Ably.ChannelStateChange) => {
      this._handleChannelStateChange(stateChange);
    };
    this._channel.on(this._onChannelStateChange);

    this._logger?.debug('DefaultAgentSession(); session created');
  }

  // -------------------------------------------------------------------------
  // Public accessors
  // -------------------------------------------------------------------------

  // Spec: AIT-ST14
  get presence(): Ably.RealtimePresence {
    return this._channel.presence;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  // Spec: AIT-ST2
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- preserve reference equality across calls
  connect(): Promise<void> {
    if (this._state === SessionState.CLOSED) {
      return Promise.reject(new Ably.ErrorInfo('unable to connect; session is closed', ErrorCode.SessionClosed, 400));
    }
    if (this._connectPromise) return this._connectPromise;

    this._logger?.trace('DefaultAgentSession.connect();');
    // Subscribe unfiltered (before attach, per RTL7g — subscribe implicitly
    // attaches the channel). Unfiltered so the Tree folds every post-attach
    // message regardless of name (cancel control messages are dispatched
    // separately by the channel listener after the Tree fold).
    this._connectPromise = this._channel.subscribe(this._channelListener).then(
      () => {
        this._logger?.debug('DefaultAgentSession.connect(); subscribed and attached');
      },
      (error: unknown) => {
        const errInfo = new Ably.ErrorInfo(
          `unable to subscribe to channel; ${errorMessage(error)}`,
          ErrorCode.SessionSubscriptionError,
          500,
          error instanceof Ably.ErrorInfo ? error : undefined,
        );
        this._logger?.error('DefaultAgentSession.connect(); subscribe failed');
        this._onError?.(errInfo);
        throw errInfo;
      },
    );
    return this._connectPromise;
  }

  /**
   * The session-owned materialisation tree. Mirrors `ClientSession.tree`
   * for observability and parity.
   * @returns The session's Tree.
   */
  get tree(): Tree<TOutput, TProjection> {
    return this._tree;
  }

  // Spec: AIT-ST3
  createRun(invocation: Invocation, runtime?: RunRuntime<TOutput>): Run<TOutput, TProjection, TMessage> {
    this._logger?.trace('DefaultAgentSession.createRun();', { inputEventId: invocation.inputEventId });
    return this._createRun(invocation, runtime ?? {});
  }

  // Spec: AIT-ST11
  async close(): Promise<void> {
    if (this._state === SessionState.CLOSED) return;
    this._state = SessionState.CLOSED;
    this._logger?.trace('DefaultAgentSession.close();');
    if (this._connectPromise) {
      this._channel.unsubscribe(this._channelListener);
    }
    this._channel.off(this._onChannelStateChange);
    for (const reg of this._registeredRuns.values()) {
      reg.controller.abort();
    }
    this._registeredRuns.clear();
    this._runIdByInputCodecMessageId.clear();
    this._deferredCancels.clear();
    this._runManager.close();

    // Detach the channel this session attached. connect() subscribes (which
    // implicitly attaches), so we only detach when connect() ran. Best-effort:
    // a detach failure (e.g. the channel is already FAILED) must not throw out
    // of close().
    if (this._connectPromise) {
      try {
        await this._channel.detach();
      } catch (error) {
        // Swallowed (see above): a detach failure must not throw out of
        // close(). Logged at debug for observability.
        this._logger?.debug('DefaultAgentSession.close(); channel detach failed', { error });
      }
    }

    this._logger?.debug('DefaultAgentSession.close(); session closed');
  }

  // -------------------------------------------------------------------------
  // Cancel message routing
  // -------------------------------------------------------------------------

  private async _handleCancelMessage(msg: Ably.InboundMessage): Promise<void> {
    const headers = getTransportHeaders(msg);
    const runId = headers[HEADER_RUN_ID];
    const inputCodecMessageId = headers[HEADER_INPUT_CODEC_MESSAGE_ID];

    // Malformed cancel: drop with warn. A cancel must identify its target by
    // `run-id` (a continuation, whose run-id the client knows) and/or by
    // `input-codec-message-id` (a fresh send, before the agent minted the
    // run-id). Neither present means there is nothing to route to.
    if (!runId && !inputCodecMessageId) {
      this._logger?.warn('DefaultAgentSession._handleCancelMessage(); missing run-id and input-codec-message-id', {
        serial: msg.serial,
      });
      return;
    }

    // Primary path — match by run-id (continuations, whose run-id the client
    // already knows). Resolve the input-codec-message-id to a run-id when the
    // run-id wasn't supplied (a fresh-send cancel that arrived after the run's
    // input-event lookup resolved, so the linkage already exists).
    const resolvedRunId =
      runId ?? (inputCodecMessageId ? this._runIdByInputCodecMessageId.get(inputCodecMessageId) : undefined);
    const reg = resolvedRunId ? this._registeredRuns.get(resolvedRunId) : undefined;

    if (!reg) {
      // The run isn't known yet. A fresh-send cancel can race ahead of the
      // run's input-event lookup (which is what establishes the
      // input-codec-message-id → run linkage). Buffer it by
      // input-codec-message-id so `Run.start()` can pull and honour it once it
      // resolves the triggering input. A bare run-id cancel for an unknown run
      // is a no-op (the run never existed here, or already ended).
      if (inputCodecMessageId !== undefined) {
        this._bufferDeferredCancel(inputCodecMessageId, msg);
      }
      return;
    }

    await this._cancelRegistration(reg, msg);
  }

  /**
   * Buffer a cancel that arrived before its target run was known, keyed by the
   * triggering input's codec-message-id. FIFO-evicts the oldest entry at the
   * fixed limit below. A later cancel for the same input replaces the earlier
   * one — the intent is identical.
   * @param inputCodecMessageId - The triggering input's codec-message-id.
   * @param msg - The raw cancel message (passed to `onCancel`).
   */
  private _bufferDeferredCancel(inputCodecMessageId: string, msg: Ably.InboundMessage): void {
    // Deferred cancels are bounded so a pathological burst can't grow the
    // map without bound. 200 outstanding fresh-send cancels in flight is
    // ample — a typical agent process sees one per HTTP request.
    const DEFERRED_CANCEL_LIMIT = 200;
    const evicted = evictOldestIfFull(this._deferredCancels, inputCodecMessageId, DEFERRED_CANCEL_LIMIT);
    if (evicted !== undefined) {
      this._logger?.warn('DefaultAgentSession._bufferDeferredCancel(); deferred-cancel buffer full, dropping oldest', {
        evictedInputCodecMessageId: evicted,
        limit: DEFERRED_CANCEL_LIMIT,
      });
    }
    this._deferredCancels.set(inputCodecMessageId, msg);
    this._logger?.debug('DefaultAgentSession._bufferDeferredCancel(); buffered early cancel', {
      inputCodecMessageId,
      serial: msg.serial,
    });
  }

  /**
   * Pull and honour a cancel buffered before this run was known. Called from
   * `Run.start()` once the input-event lookup resolves the run's triggering
   * input codec-message-id — the point at which the
   * `input-codec-message-id → run` linkage first exists. No-op when no cancel
   * was buffered for that input.
   * @param reg - The now-known run registration.
   * @param inputCodecMessageId - The run's resolved triggering input codec-message-id.
   */
  private async _pullDeferredCancel(reg: RegisteredRun, inputCodecMessageId: string): Promise<void> {
    const buffered = this._deferredCancels.get(inputCodecMessageId);
    if (buffered === undefined) return;
    this._deferredCancels.delete(inputCodecMessageId);
    this._logger?.debug('DefaultAgentSession._pullDeferredCancel(); honouring buffered cancel', {
      runId: reg.runId,
      inputCodecMessageId,
    });
    await this._cancelRegistration(reg, buffered);
  }

  /**
   * Fire a cancel against a known run: consult its `onCancel` authorization
   * hook (if any), then abort the run's controller. Shared by the run-id match,
   * the input-codec-message-id match, and the buffered-cancel pull so all three
   * honour `onCancel` and surface handler errors identically.
   * @param reg - The target run registration.
   * @param msg - The raw cancel message (passed to `onCancel`).
   */
  private async _cancelRegistration(reg: RegisteredRun, msg: Ably.InboundMessage): Promise<void> {
    const { runId } = reg;
    this._logger?.debug('DefaultAgentSession._cancelRegistration(); matched run', { runId });

    const request: CancelRequest = { message: msg, runId };

    try {
      if (reg.onCancel) {
        const allowed = await reg.onCancel(request);
        if (!allowed) {
          this._logger?.debug('DefaultAgentSession._cancelRegistration(); cancel rejected by onCancel', {
            runId,
          });
          return;
        }
      }
      reg.controller.abort();
      this._logger?.debug('DefaultAgentSession._cancelRegistration(); run cancelled', { runId });
    } catch (error) {
      const errInfo = new Ably.ErrorInfo(
        `unable to process cancel for run ${runId}; onCancel handler threw: ${errorMessage(error)}`,
        ErrorCode.CancelListenerError,
        500,
        error instanceof Ably.ErrorInfo ? error : undefined,
      );
      this._logger?.error('DefaultAgentSession._cancelRegistration(); onCancel threw', { runId });
      (reg.onError ?? this._onError)?.(errInfo);
    }
  }

  // -------------------------------------------------------------------------
  // Channel state change handler
  // -------------------------------------------------------------------------

  // Spec: AIT-ST12, AIT-ST12a
  private _handleChannelStateChange(stateChange: Ably.ChannelStateChange): void {
    if (this._state === SessionState.CLOSED) return;

    const { current, resumed } = stateChange;

    // Track the initial attach so we don't treat it as a discontinuity.
    if (current === 'attached' && !this._hasAttachedOnce) {
      this._hasAttachedOnce = true;
      return;
    }

    // Continuity-breaking states:
    // - FAILED, SUSPENDED, DETACHED: no more messages expected (or gap)
    // - ATTACHED with resumed: false (UPDATE): messages were lost
    const continuityLost =
      current === 'failed' || current === 'suspended' || current === 'detached' || (current === 'attached' && !resumed);

    if (!continuityLost) return;

    this._logger?.error('DefaultAgentSession._handleChannelStateChange(); channel continuity lost', {
      current,
      resumed,
      previous: stateChange.previous,
    });

    const continuityErr = new Ably.ErrorInfo(
      `unable to continue; channel continuity lost (${current}${current === 'attached' ? ', resumed: false' : ''})`,
      ErrorCode.ChannelContinuityLost,
      500,
      stateChange.reason,
    );

    // Abort every active run's controller FIRST so in-flight
    // `loadConversation` / `findInputEvent` calls observe the abort before
    // the Tree changes underneath them and reject (InvalidArgument from their
    // signal checks; the session-level onError carries ChannelContinuityLost).
    for (const reg of this._registeredRuns.values()) {
      reg.controller.abort();
    }

    // Then swap the Tree for a fresh empty instance — abandons the old
    // Tree's projections, indices, and ably-message listeners to GC. New
    // runs use the fresh Tree; lingering closures on the old Tree from
    // in-flight (now-aborted) lookups are bounded by the abort propagation.
    this._tree = createTree<TInput, TOutput, TProjection>(
      this._codec,
      this._logger ?? makeLogger({ logLevel: LogLevel.Silent }),
    );
    this._decoder = this._codec.createDecoder();
    this._foldedSerials = new Set<string>();
    this._historyExhausted = false;

    // Session-level notification: continuity loss is not scoped to any one
    // run. Per-run onError handlers are reserved for errors from that run's
    // own operations (publish failures, encoder errors).
    this._onError?.(continuityErr);
  }

  // -------------------------------------------------------------------------
  // Wire fold
  // -------------------------------------------------------------------------

  /**
   * Fold a single wire message into the session-owned Tree. Mirrors the
   * ClientSession's live decode loop — same engine, same fold path.
   * `applyWireMessage` decodes the message and applies the result to the
   * Tree (or routes lifecycle messages through `applyRunLifecycle`);
   * `emitAblyMessage` notifies Tree subscribers AND populates the event-id
   * index used by `findInputEvent`.
   *
   * Dedup by serial so the live listener and the history walks
   * (`_findInputEvent`, `_hydrateAncestors`) don't double-fold a message
   * that surfaces via more than one path. Wires without a serial bypass the
   * dedup (we cannot uniquely identify them).
   * @param wire - The inbound Ably message to fold.
   */
  private _foldWire(wire: Ably.InboundMessage): void {
    if (wire.serial !== undefined) {
      if (this._foldedSerials.has(wire.serial)) return;
      this._foldedSerials.add(wire.serial);
    }
    applyWireMessage(this._tree, this._decoder, wire);
    this._tree.emitAblyMessage(wire);
  }

  // -------------------------------------------------------------------------
  // Channel subscription handler
  // -------------------------------------------------------------------------

  private _handleChannelMessage(msg: Ably.InboundMessage): void {
    try {
      // Fold first (no-op for already-folded serials), then dispatch cancel
      // control messages regardless of whether the fold was skipped.
      this._foldWire(msg);

      if (msg.name === EVENT_CANCEL) {
        // Fire-and-forget async handler — errors are caught internally.
        this._handleCancelMessage(msg).catch((error: unknown) => {
          const errInfo = new Ably.ErrorInfo(
            `unable to route cancel message; ${errorMessage(error)}`,
            ErrorCode.CancelListenerError,
            500,
            error instanceof Ably.ErrorInfo ? error : undefined,
          );
          this._logger?.error('DefaultAgentSession._handleChannelMessage(); cancel routing error');
          this._onError?.(errInfo);
        });
        return;
      }
    } catch (error) {
      const errInfo = new Ably.ErrorInfo(
        `unable to process channel message; ${errorMessage(error)}`,
        ErrorCode.SessionSubscriptionError,
        500,
        error instanceof Ably.ErrorInfo ? error : undefined,
      );
      this._logger?.error('DefaultAgentSession._handleChannelMessage(); subscription error');
      this._onError?.(errInfo);
    }
  }

  // -------------------------------------------------------------------------
  // Connection guard
  // -------------------------------------------------------------------------

  private async _requireConnected(method: string): Promise<void> {
    if (!this._connectPromise) {
      throw new Ably.ErrorInfo(
        `unable to ${method}; connect() must be called before ${method}()`,
        ErrorCode.InvalidArgument,
        400,
      );
    }
    return this._connectPromise;
  }

  // -------------------------------------------------------------------------
  // Input-event lookup
  // -------------------------------------------------------------------------

  /**
   * Find every message whose `event-id` matches one of `expectedEventIds`,
   * racing three sources:
   *
   *  1. A pre-scan of the Tree via `findWireByEventId` for messages already
   *     folded into it from prior live arrivals.
   *  2. A live listener on the Tree's `ably-message` event for new arrivals
   *     during the call.
   *  3. A bounded history scan via `loadHistoryPages` (lookback window).
   *
   * Resolves when every expected event-id has been matched. Per-id race
   * resolution — whichever source surfaces a matched message first wins
   * (dedup by serial). On timeout: cancels the in-flight history scan and
   * rejects with `InputEventNotFound`, wrapping any history-scan failure as
   * `cause` so a broken history fetch isn't masked behind the timeout. On
   * signal abort: rejects with `InvalidArgument`.
   *
   * `firstHeaders` and `firstClientId` are read from the matched message with
   * the smallest serial (`compareBySerial`), giving stable run-level
   * metadata regardless of arrival ordering across sources.
   * @param opts - Lookup parameters.
   * @param opts.invocationId - The invocation id this lookup is for (logging / error messages).
   * @param opts.runId - The run id this lookup is for (logging / error messages).
   * @param opts.expectedEventIds - The set of `event-id`s the lookup must observe before resolving.
   * @param opts.timeoutMs - Maximum total wait across live + history sources.
   * @param opts.signal - AbortSignal that aborts the lookup if the run is cancelled.
   * @returns Raw matched Ably messages sorted by serial ascending, plus the
   *   smallest-serial message's headers and clientId for downstream metadata.
   */
  private async _findInputEvent(opts: {
    invocationId: string;
    runId: string;
    expectedEventIds: readonly string[];
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<InputEventLookupResult> {
    const { invocationId, runId, expectedEventIds, timeoutMs, signal } = opts;
    const logger = this._logger;
    const expectedSet = new Set(expectedEventIds);
    const expectedCount = expectedSet.size;

    const matchedByEventId = new Map<string, Ably.InboundMessage>();

    // Bounded history fetch in parallel with the live wait; this controller
    // lets the lookup cancel the in-flight fetch on timeout / abort.
    const historyController = new AbortController();

    return new Promise<InputEventLookupResult>((resolve, reject) => {
      let settled = false;
      // A genuine history-scan failure (not a cancel-induced abort) recorded
      // so the timeout rejection can surface it as `cause` — the live path
      // may still win the race, so the failure alone doesn't reject.
      let historyError: Ably.ErrorInfo | undefined;
      /* eslint-disable prefer-const -- forward-declared so cleanup() / onCancelled() can reference before the listener register or the timeout schedule has run. */
      let unregisterLive: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | number | undefined;
      /* eslint-enable */

      const cleanup = (): void => {
        if (unregisterLive) unregisterLive();
        if (timer !== undefined) clearTimeout(timer);
        historyController.abort();
        signal.removeEventListener('abort', onCancelled);
      };

      const onCancelled = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          new Ably.ErrorInfo(
            `unable to look up input event; run ${runId} was cancelled`,
            ErrorCode.InvalidArgument,
            400,
          ),
        );
      };

      const finishOk = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        // Sort matched messages by serial for deterministic publish-order
        // delivery to the caller — firstHeaders / firstClientId come from
        // the smallest-serial message.
        const sorted = [...matchedByEventId.values()].toSorted(compareBySerial);
        let firstHeaders: Record<string, string> | undefined;
        let firstClientId: string | undefined;
        for (const m of sorted) {
          if (firstHeaders === undefined) {
            firstHeaders = getTransportHeaders(m);
            firstClientId = m.clientId;
            break;
          }
        }
        logger?.debug('AgentSession._findInputEvent(); collected input events', {
          runId,
          invocationId,
          count: sorted.length,
        });
        resolve({ rawMessages: sorted, firstHeaders, firstClientId });
      };

      // Consider a message for matching against the expected set; returns true
      // when the lookup is now fully satisfied.
      const consider = (m: Ably.InboundMessage): boolean => {
        if (settled) return false;
        const headers = getTransportHeaders(m);
        const eventId = headers[HEADER_EVENT_ID];
        if (!eventId || !expectedSet.has(eventId) || matchedByEventId.has(eventId)) return false;
        matchedByEventId.set(eventId, m);
        return matchedByEventId.size >= expectedCount;
      };

      signal.addEventListener('abort', onCancelled, { once: true });
      if (signal.aborted) {
        onCancelled();
        return;
      }

      // 1. Pre-scan the Tree's event-id index for already-folded matches.
      //    Multi-run sessions where a prior run folded the message hit here
      //    synchronously.
      for (const id of expectedEventIds) {
        const wire = this._tree.findWireByEventId(id);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- settled may mutate via synchronous callbacks during consider()
        if (wire && consider(wire) && !settled) {
          finishOk();
          return;
        }
      }

      // 2. Subscribe to the Tree's `ably-message` event for live arrivals.
      //    `applyWireMessage` folds first; `emitAblyMessage` notifies
      //    subscribers AND populates the event-id index. Wires fed in by
      //    the parallel history fetch flow through the same event so the
      //    listener picks them up uniformly.
      unregisterLive = this._tree.on('ably-message', (msg) => {
        if (consider(msg) && !settled) finishOk();
      });

      // 3. Drive a bounded history fetch in parallel; each page's messages
      //    fold into the Tree via `_foldWire`, which triggers the listener
      //    above.
      (async (): Promise<void> => {
        // Captured so a continuity-loss Tree swap mid-walk abandons the
        // fold — a page fetched against the pre-loss attach epoch must not
        // pollute the fresh Tree.
        const treeAtStart = this._tree;
        try {
          const cursor = await loadHistoryPages(this._channel, {
            pageLimit: 200,
            untilAttach: true,
            lookbackMs: this._inputEventLookbackMs,
            signal: historyController.signal,
            logger,
          });
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- settled mutates via listener / timer callbacks fired on the event loop
          while (cursor.hasNext() && !settled) {
            const chunk = await cursor.next();
            if (!chunk) break;
            if (this._tree !== treeAtStart) return;
            // Ably returns history pages newest-first; fold in chronological
            // order so codec projections build oldest-to-newest (matches the
            // live decode loop's fold order).
            for (const wire of chunk.toReversed()) {
              this._foldWire(wire);
            }
          }
        } catch (error) {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- settled mutates via listener / timer callbacks fired on the event loop
          if (settled) return;
          historyError = wrapHistoryError('scan history for input event', error);
          logger?.warn('AgentSession._findInputEvent(); history scan failed (continuing on live path)', {
            error: errorMessage(error),
          });
        }
      })().catch(() => {
        /* swallowed — handled inside */
      });

      // 4. Overall timeout — cancels the in-flight history fetch and
      //    rejects with InputEventNotFound.
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          new Ably.ErrorInfo(
            `unable to look up input event; received ${String(matchedByEventId.size)} of ${String(expectedCount)} input events for invocation ${invocationId} within ${String(timeoutMs)}ms`,
            ErrorCode.InputEventNotFound,
            504,
            historyError,
          ),
        );
      }, timeoutMs);
      // Node returns an unref-able Timeout; browsers return a number. Unref
      // so a parked lookup cannot keep a Node process alive by itself.
      if (typeof timer === 'object') timer.unref();
    });
  }

  // -------------------------------------------------------------------------
  // Conversation walk
  // -------------------------------------------------------------------------

  /**
   * Walk the parent chain from the run's input node back to the conversation
   * root, reading already-folded projections off the Tree's nodes.
   *
   * Strategy:
   *  - Ensure the Tree has enough history hydrated by driving
   *    `loadHistoryPages` until the input node has been observed and its
   *    parent chain to root (or `maxRuns` reply runs back) is reachable.
   *  - Walk parent pointers via the Tree's `getNodeByCodecMessageId`.
   *  - Concatenate `codec.getMessages(node.projection)` per node, root first.
   *
   * Hydration is mutex-protected so concurrent `loadConversation` calls
   * share one fetch.
   * @param runId - The current run's id (for the tail run's projection lookup).
   * @param assistantParentFallback - The current run's input node codec-message-id.
   * @param signal - AbortSignal; rejects with InvalidArgument when aborted.
   * @param maxRuns - Optional bound on the parent walk; counts reply RunNodes.
   * @returns The branch's messages (root-first) and the current run's projection.
   */
  private async _walkConversation(
    runId: string,
    assistantParentFallback: string | undefined,
    signal: AbortSignal,
    maxRuns: number | undefined,
  ): Promise<{ messages: TMessage[]; projection: TProjection }> {
    if (signal.aborted) {
      throw new Ably.ErrorInfo(
        `unable to load conversation; run ${runId} was cancelled`,
        ErrorCode.InvalidArgument,
        400,
      );
    }

    await this._hydrateAncestors(runId, assistantParentFallback, signal, maxRuns);

    const chain = walkAncestorChain(this._tree, assistantParentFallback, maxRuns);
    const messages: TMessage[] = [];
    for (const node of chain) {
      for (const m of this._codec.getMessages(node.projection)) {
        messages.push(m.message);
      }
    }

    const runNode = this._tree.getRunNode(runId);
    if (runNode !== undefined && !chain.some((n) => n.kind === 'run' && n.runId === runId)) {
      for (const m of this._codec.getMessages(runNode.projection)) {
        messages.push(m.message);
      }
    }

    return { messages, projection: runNode?.projection ?? this._codec.init() };
  }

  /**
   * Drive `loadHistoryPages` to populate the Tree with enough ancestor
   * coverage to walk from `anchor` to root (or `maxRuns` reply runs back).
   * Mutex-protected: concurrent callers share a single in-flight fetch.
   *
   * Pages fold into the Tree via `_foldWire`.
   *
   * History exhaustion is best-effort: if the channel has no more history
   * but the chain still needs ancestors, the walk stops at what's available
   * (and `_historyExhausted` short-circuits further fetches for this attach
   * epoch). Fetch FAILURES are not best-effort: the caller that owns the
   * failing fetch rejects (truncating the conversation silently would feed
   * the LLM partial history with no signal); other callers sharing the mutex
   * are isolated from it and issue their own fetch.
   * @param runId - The current run's id (its node must be present in the Tree before the walk is complete).
   * @param anchor - The input codec-message-id to walk from. Undefined means
   *   no walk is needed (current run only).
   * @param signal - AbortSignal.
   * @param maxRuns - Optional bound on the ancestor walk.
   * @throws {Ably.ErrorInfo} `InvalidArgument` when `signal` aborts;
   *   `HistoryFetchFailed` — or the underlying Ably code when the failure
   *   carried one — (original as `cause`) when this caller's own history
   *   fetch fails after retries.
   */
  private async _hydrateAncestors(
    runId: string,
    anchor: string | undefined,
    signal: AbortSignal,
    maxRuns: number | undefined,
  ): Promise<void> {
    // Check whether the Tree already has what we need: the current run node
    // exists AND (no anchor OR anchor's chain reaches root / maxRuns).
    const needsFetch = (): boolean => {
      if (this._tree.getRunNode(runId) === undefined) return true;
      if (anchor === undefined) return false;
      if (this._tree.getNodeByCodecMessageId(anchor) === undefined) return true;
      const chain = walkAncestorChain(this._tree, anchor, maxRuns);
      const reachedRoot = chain.length > 0 && chain[0]?.parentCodecMessageId === undefined;
      const reachedLimit = maxRuns !== undefined && countReplyRuns(chain) >= maxRuns;
      return !reachedRoot && !reachedLimit;
    };

    // Loop until the Tree has enough for THIS caller's anchor + maxRuns, the
    // caller's signal fires, history is exhausted, or this caller's own fetch
    // fails. Awaiting another caller's in-flight fetch may not be enough: an
    // earlier caller can early-exit at its own `needsFetch()` and leave a
    // shorter chain than we need. After sharing, we re-check; if still not
    // satisfied, we start our own fetch under a fresh mutex slot.
    while (needsFetch()) {
      if (signal.aborted) {
        throw new Ably.ErrorInfo('unable to hydrate ancestors; signal aborted', ErrorCode.InvalidArgument, 400);
      }
      // A previous walk (any caller, this attach epoch) already drove history
      // to exhaustion — fetching again cannot reveal more. Best-effort stop.
      if (this._historyExhausted) break;
      if (this._hydrationMutex !== undefined) {
        await this._hydrationMutex;
        continue;
      }
      // This caller owns the new mutex slot. The shared IIFE never rejects —
      // followers awaiting it must not alias this caller's failure — so the
      // owner records its own error in `fetchError` and rethrows it from its
      // own frame after the await.
      let fetchError: Ably.ErrorInfo | undefined;
      this._hydrationMutex = (async (): Promise<void> => {
        // Captured so a continuity-loss Tree swap mid-walk abandons the
        // fold — a page fetched against the pre-loss attach epoch must not
        // pollute the fresh Tree. (The swap also aborts run signals, but
        // that check only runs between pages, after a fold.)
        const treeAtStart = this._tree;
        try {
          const cursor = await loadHistoryPages(this._channel, {
            pageLimit: 200,
            untilAttach: true,
            signal,
            logger: this._logger,
          });
          while (cursor.hasNext()) {
            if (signal.aborted) return;
            const chunk = await cursor.next();
            if (!chunk) break;
            if (this._tree !== treeAtStart) return;
            // Ably returns history pages newest-first; fold in chronological
            // order so codec projections build oldest-to-newest.
            for (const wire of chunk.toReversed()) {
              this._foldWire(wire);
            }
            // Early exit when the Tree has enough for the walk.
            if (!needsFetch()) return;
          }
          // The loop also exits via `hasNext()` turning false on signal abort,
          // and via `!chunk` after a swap/abort — neither means the channel's
          // history was actually exhausted. Only record exhaustion when the
          // walk genuinely ran out of pages in the current attach epoch.
          if (!signal.aborted && this._tree === treeAtStart) {
            this._historyExhausted = true;
          }
        } catch (error) {
          fetchError = wrapHistoryError('hydrate ancestors', error);
          // Error level: the owner always rethrows this from loadConversation.
          this._logger?.error('AgentSession._hydrateAncestors(); history fetch failed', {
            runId,
            error: errorMessage(error),
          });
        } finally {
          this._hydrationMutex = undefined;
        }
      })();
      await this._hydrationMutex;
      if (fetchError !== undefined) throw fetchError;
    }
  }

  // -------------------------------------------------------------------------
  // Run creation
  // -------------------------------------------------------------------------

  private _createRun(invocation: Invocation, runtime: RunRuntime<TOutput>): Run<TOutput, TProjection, TMessage> {
    // The run-id is not carried in the invocation body — the agent mints it.
    // Mint a provisional id now (or take the `runtime.runId` override for
    // tests / in-process drivers) — this IS the id for a fresh run. A
    // continuation overrides it in `Run.start()` with the existing run-id read
    // off the triggering input event's message headers (the run it re-enters).
    // Mirrors the invocationId mint below.
    let runId = runtime.runId ?? crypto.randomUUID();
    // The agent mints the invocation id — one per HTTP request that invokes
    // it. A per-run override (runtime.invocationId) supports deterministic ids
    // in tests and in-process drivers.
    const invocationId = runtime.invocationId ?? crypto.randomUUID();
    const inputEventLookupTimeoutMs = this._inputEventLookupTimeoutMs;
    const { onMessage, onCancelled, onCancel, onError: runOnError, signal: externalSignal } = runtime;

    const controller = new AbortController();
    let state = RunState.INITIALIZED;

    // Compose the internal controller signal with the external signal (e.g.
    // req.signal) so platform-level cancellation (request cancellation, function
    // timeout) cancels the run through the same path as Ably cancel messages.
    const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;

    // Spec: AIT-ST3a — register immediately so `close()` aborts an in-flight
    // start() and a post-lookup cancel can fire the AbortSignal. Keyed by the
    // provisional run-id; a continuation re-keys to the real id in start()
    // once the triggering input reveals it.
    const registration: RegisteredRun = {
      runId,
      invocationId,
      controller,
      signal,
      onCancel,
      onError: runOnError,
    };
    this._registeredRuns.set(runId, registration);

    // Capture instance members as locals so arrow functions close over them
    // without needing `this` (avoids unicorn/no-this-assignment).
    const logger = this._logger;
    const runManager = this._runManager;
    const codec = this._codec;
    const channel = this._channel;
    const registeredRuns = this._registeredRuns;
    const runIdByInputCodecMessageId = this._runIdByInputCodecMessageId;
    const deferredCancels = this._deferredCancels;
    const requireConnected = this._requireConnected.bind(this);
    const findInputEvent = this._findInputEvent.bind(this);
    const walkConversation = this._walkConversation.bind(this);
    const pullDeferredCancel = this._pullDeferredCancel.bind(this);
    const inputEventId = invocation.inputEventId;

    // Per-run metadata resolved from the input-event lookup result. The first
    // matched message message's headers carry the run's `clientId`, `parent`, and
    // `forkOf`, and — for a continuation — the `run-id` it re-enters (a fresh
    // input carries none; the client stamps a run-id only when re-entering a
    // run it already knows). Its Ably-level publisher `clientId` becomes the
    // `inputClientId` re-stamped on the agent's own publishes.
    let resolvedClientId: string | undefined;
    let resolvedInputClientId: string | undefined;
    let resolvedParent: string | undefined;
    let resolvedForkOf: string | undefined;
    let resolvedRegenerates: string | undefined;
    let resolvedInputCodecMessageId: string | undefined;
    let resolvedContinuation = false;
    let firstLookupHeaders: Record<string, string> | undefined;

    // `Run.view.messages` is a LIVE read against the session's Tree:
    // returns the trigger node's currently-folded messages, reflecting any
    // amendments (tool resolutions etc.) that have arrived since
    // `Run.start()`. No internal `viewMessages` array — the Tree is the
    // single source of truth. The trigger node may be an input node (fresh
    // send) or a reply run (continuation re-entry with run-id on the
    // triggering message); both expose a projection the codec can read.
    //
    // Resolved via an arrow accessor so the closure picks up `this._tree`
    // after a continuity-loss swap; capturing `this._tree` into a local at
    // run-creation time would silently keep returning data from the
    // abandoned Tree.
    const getTree = (): DefaultTree<TInput, TOutput, TProjection> => this._tree;
    const view: RunView<TMessage> = {
      get messages() {
        if (resolvedInputCodecMessageId === undefined) return [];
        const node = getTree().getNodeByCodecMessageId(resolvedInputCodecMessageId);
        if (!node) return [];
        const sourceSerial = node.kind === 'input' ? node.serial : node.startSerial;
        const sourceForkOf = node.kind === 'input' ? node.forkOf : undefined;
        return codec.getMessages(node.projection).map((m) => ({
          kind: 'message' as const,
          message: m.message,
          codecMessageId: m.codecMessageId,
          parentId: node.parentCodecMessageId,
          forkOf: sourceForkOf,
          headers: {},
          serial: sourceSerial,
        }));
      },
    };
    /**
     * The reply run's structural-parent fallback, computed once in
     * `Run.start()` once the input-event lookup resolves the triggering
     * input's codec-message-id, and consumed by every `Run.pipe()` publish.
     * A per-stream `streamOpts.parent` still overrides it. Storing it here
     * keeps it stable across pipes and decouples the assistant's structural
     * parent from the run-start message's own `parent`.
     */
    let assistantParentFallback: string | undefined;
    /**
     * Remove this run from the session's routing maps. Drops the
     * `_registeredRuns` entry plus the `input-codec-message-id → run-id`
     * reverse index (and any stale deferred cancel still buffered for that
     * input), keeping the cancel-routing state consistent when the run ends,
     * suspends, or its start fails.
     */
    const deregisterRun = (): void => {
      registeredRuns.delete(runId);
      if (resolvedInputCodecMessageId !== undefined) {
        runIdByInputCodecMessageId.delete(resolvedInputCodecMessageId);
        deferredCancels.delete(resolvedInputCodecMessageId);
      }
    };

    const run: Run<TOutput, TProjection, TMessage> = {
      get runId() {
        return runId;
      },
      get invocationId() {
        return invocationId;
      },
      get abortSignal() {
        return signal;
      },
      get view() {
        return view;
      },
      get messages() {
        // Always derive live from the Tree. Walks the parent chain
        // from the run's structural-parent anchor and concatenates each
        // ancestor's projection, then appends the current reply run's
        // messages at the tail. Uses `assistantParentFallback` (which falls
        // back to the input message's `parent` for regenerate carriers whose
        // own codec-message-id has no Tree node) — same anchor
        // `loadConversation` uses. No cache: every read reflects the latest
        // folded state. `getTree()` dereferences `this._tree` live so a
        // continuity-loss Tree swap is observed instead of returning stale
        // data from the abandoned tree.
        const tree = getTree();
        const chain = assistantParentFallback === undefined ? [] : walkAncestorChain(tree, assistantParentFallback);
        const messages: TMessage[] = [];
        for (const node of chain) {
          for (const m of codec.getMessages(node.projection)) messages.push(m.message);
        }
        const runNode = tree.getRunNode(runId);
        if (runNode !== undefined && !chain.some((n) => n.kind === 'run' && n.runId === runId)) {
          for (const m of codec.getMessages(runNode.projection)) messages.push(m.message);
        }
        return messages;
      },

      // Spec: AIT-ST4, AIT-ST4a, AIT-ST4b
      start: async (): Promise<void> => {
        logger?.trace('Run.start();', { runId, inputEventId });

        await requireConnected('start');

        // Spec: AIT-ST4a
        if (signal.aborted) {
          throw new Ably.ErrorInfo(
            `unable to start run; run ${runId} was cancelled before start()`,
            ErrorCode.InvalidArgument,
            400,
          );
        }
        if (state !== RunState.INITIALIZED) return;
        state = RunState.STARTED;

        // Look up the triggering input event on the channel so the agent
        // can read the user's message and per-run metadata (parent, forkOf,
        // continuation flag) before publishing run-start. Skip when
        // inputEventLookupTimeoutMs === 0 (tests and in-process drivers) or
        // when no inputEventId is set (invocation requires no channel lookup).
        if (inputEventId && inputEventLookupTimeoutMs > 0) {
          try {
            const found = await findInputEvent({
              invocationId,
              runId,
              expectedEventIds: [inputEventId],
              timeoutMs: inputEventLookupTimeoutMs,
              signal,
            });
            if (found.firstHeaders !== undefined) firstLookupHeaders = found.firstHeaders;
            if (found.firstClientId !== undefined) resolvedInputClientId = found.firstClientId;
          } catch (error) {
            const errInfo =
              error instanceof Ably.ErrorInfo
                ? error
                : new Ably.ErrorInfo(
                    `unable to look up input event; ${errorMessage(error)}`,
                    ErrorCode.InputEventNotFound,
                    504,
                  );
            // The rejection bubbles up to the developer's HTTP handler,
            // which surfaces the failure as a non-2xx response — that is
            // the signal the client sees. No channel publish: an
            // `ai-run-end` without a preceding `ai-run-start` would break
            // the lifecycle invariant for other channel observers.
            deregisterRun();
            logger?.error('Run.start(); input-event lookup failed', { runId, invocationId });
            throw errInfo;
          }
        }

        // Resolve per-run metadata from the first matched message message's
        // headers — they carry `clientId`, `parent`, and `forkOf`.
        // Continuations of a suspended run pick up the suspended assistant's
        // parent in the same headers (the continuation message parents off
        // the assistant). A `run-id` on the triggering input marks a
        // continuation (re-entry via `ai-run-resume`); a fresh input carries
        // none and opens the run with `ai-run-start`.
        const sourceHeaders = firstLookupHeaders;
        if (sourceHeaders) {
          resolvedClientId = sourceHeaders[HEADER_RUN_CLIENT_ID];
          resolvedParent = sourceHeaders[HEADER_PARENT];
          resolvedForkOf = sourceHeaders[HEADER_FORK_OF];
          resolvedRegenerates = sourceHeaders[HEADER_MSG_REGENERATE];
          resolvedInputCodecMessageId = sourceHeaders[HEADER_CODEC_MESSAGE_ID];

          // The triggering input's run-id (if any) IS this run's identity.
          // Present → a continuation re-entering that run: adopt the id,
          // overriding the provisional one minted at construction, and re-key
          // the registration so cancel routing / deregistration resolve to the
          // real run. Absent → a fresh run: the provisional id stands and the
          // run opens with run-start.
          const wireRunId = sourceHeaders[HEADER_RUN_ID];
          resolvedContinuation = wireRunId !== undefined;
          if (wireRunId !== undefined && wireRunId !== runId) {
            registeredRuns.delete(runId);
            runId = wireRunId;
            registration.runId = runId;
            registeredRuns.set(runId, registration);
          }
        }

        // Compute the reply run's structural-parent fallback: the triggering
        // user message's codec-message-id ONLY if that codec-message-id is
        // backed by a real node in the Tree (i.e. the message decoded into at
        // least one input event); otherwise — for regenerate carriers that
        // are wire-only signals with no input events — fall back to the
        // input message's own `parent` header.
        assistantParentFallback =
          resolvedInputCodecMessageId !== undefined &&
          this._tree.getNodeByCodecMessageId(resolvedInputCodecMessageId) !== undefined
            ? resolvedInputCodecMessageId
            : resolvedParent;

        // The triggering input's codec-message-id is now resolved, so the
        // `input-codec-message-id → run` linkage exists: index it for live
        // cancels and pull any cancel that arrived before the run was known
        // (a fresh-send cancel published before the agent minted this run-id).
        // Honouring it here may abort the controller before run-start; that is
        // fine — the abort propagates through the same signal a normal cancel
        // would use.
        if (resolvedInputCodecMessageId !== undefined) {
          runIdByInputCodecMessageId.set(resolvedInputCodecMessageId, runId);
          await pullDeferredCancel(registration, resolvedInputCodecMessageId);
        }

        try {
          await runManager.startRun(runId, resolvedClientId, controller, {
            // Stamp the reply run's STRUCTURAL parent (its input node, M_user) —
            // the same value the output path stamps — not the input message's own
            // parent. Makes `parent` structural on every message so the Tree's two
            // creation paths agree regardless of arrival order. Valid only now
            // that M_user is a separate input node (the two-node flip).
            parent: assistantParentFallback,
            forkOf: resolvedForkOf,
            regenerates: resolvedRegenerates,
            invocationId,
            inputClientId: resolvedInputClientId,
            inputCodecMessageId: resolvedInputCodecMessageId,
            continuation: resolvedContinuation,
          });
        } catch (error) {
          const errInfo = new Ably.ErrorInfo(
            `unable to publish run-start for run ${runId}; ${errorMessage(error)}`,
            ErrorCode.RunLifecycleError,
            500,
            error instanceof Ably.ErrorInfo ? error : undefined,
          );
          logger?.error('Run.start(); failed to publish run-start', { runId });
          throw errInfo;
        }

        logger?.debug('Run.start(); run started', { runId, inputEventId });
      },

      loadConversation: async (options?: LoadConversationOptions): Promise<TMessage[]> => {
        logger?.trace('Run.loadConversation();', { runId });
        await requireConnected('loadConversation');
        // No cache. Drives Tree hydration via `walkConversation`
        // and computes a fresh snapshot of the parent-chain messages at
        // return time. After this call, `Run.messages` continues to work
        // as a live Tree read.
        const { messages } = await walkConversation(runId, assistantParentFallback, signal, options?.maxRuns);
        return messages;
      },

      // Spec: AIT-ST6, AIT-ST6a, AIT-ST6b, AIT-ST6b1, AIT-ST6b2, AIT-ST6b3, AIT-ST6c
      pipe: async (stream: ReadableStream<TOutput>, streamOpts?: PipeOptions<TOutput>): Promise<StreamResult> => {
        logger?.trace('Run.pipe();', { runId });

        await requireConnected('pipe');

        if (state === RunState.INITIALIZED) {
          throw new Ably.ErrorInfo(
            `unable to pipe stream; start() must be called before pipe() (run ${runId})`,
            ErrorCode.InvalidArgument,
            400,
          );
        }

        const runOwnerClientId = runManager.getClientId(runId);

        // The assistant message's parent: an explicit per-stream
        // `streamOpts.parent` from the caller, else the reply run's
        // structural-parent fallback computed once at run-start
        // (`assistantParentFallback` — the triggering user message, or the
        // input message's own parent for regenerate messages that produced no
        // MessageNodes). Owning the default here means agent routes don't have
        // to pass `{ parent: lastUserCodecMessageId }` to keep tree threading
        // correct; edit-then-regenerate sibling resolution relies on the
        // user→assistant chain being explicit.
        const assistantParent = streamOpts?.parent ?? assistantParentFallback;
        const assistantForkOf = streamOpts?.forkOf ?? resolvedForkOf;
        // Echo `msg-regenerate` on the assistant message so that a
        // client receiving the assistant chunk before `ai-run-start`
        // (e.g. via history pagination across a page boundary, or a lost
        // lifecycle publish) can still populate `RunNode.regeneratesCodecMessageId`
        // when creating the Run from headers. Mirrors the symmetric
        // behaviour for `assistantForkOf` on edit runs.
        const assistantRegenerates = resolvedRegenerates;

        const codecMessageId = crypto.randomUUID();
        const defaultHeaders = buildTransportHeaders({
          role: 'assistant',
          runId,
          codecMessageId,
          runClientId: runOwnerClientId,
          parent: assistantParent,
          forkOf: assistantForkOf,
          invocationId,
          inputClientId: resolvedInputClientId,
          inputCodecMessageId: resolvedInputCodecMessageId,
          regenerates: assistantRegenerates,
        });
        const encoder = codec.createEncoder(channel, {
          extras: { headers: defaultHeaders },
          onMessage,
          messageId: codecMessageId,
        });

        const result = await pipeStream(stream, encoder, signal, onCancelled, streamOpts?.resolveWriteOptions, logger);

        if (result.error) {
          const errInfo = new Ably.ErrorInfo(
            `unable to pipe response for run ${runId}; ${result.error.message}`,
            ErrorCode.StreamError,
            500,
            result.error instanceof Ably.ErrorInfo ? result.error : undefined,
          );
          logger?.error('Run.pipe(); stream error', { runId });
          runOnError?.(errInfo);
        }

        logger?.debug('Run.pipe(); stream finished', { runId, reason: result.reason });
        return result;
      },

      suspend: async (): Promise<void> => {
        logger?.trace('Run.suspend();', { runId });

        await requireConnected('suspend');

        if (state === RunState.INITIALIZED) {
          throw new Ably.ErrorInfo(
            `unable to suspend run; start() must be called before suspend() (run ${runId})`,
            ErrorCode.InvalidArgument,
            400,
          );
        }
        // ENDED is the terminal state for either an end or a suspend on this
        // Run instance; a second terminal call is a no-op.
        if (state === RunState.ENDED) return;
        state = RunState.ENDED;

        try {
          await runManager.suspendRun(runId, invocationId, resolvedInputClientId, resolvedInputCodecMessageId);
        } catch (error) {
          const errInfo = new Ably.ErrorInfo(
            `unable to publish run-suspend for run ${runId}; ${errorMessage(error)}`,
            ErrorCode.RunLifecycleError,
            500,
            error instanceof Ably.ErrorInfo ? error : undefined,
          );
          logger?.error('Run.suspend(); failed to publish run-suspend', { runId });
          throw errInfo;
        } finally {
          deregisterRun();
        }

        logger?.debug('Run.suspend(); run suspended', { runId });
      },

      // Spec: AIT-ST7, AIT-ST7a, AIT-ST7b
      end: async (reason: RunEndReason): Promise<void> => {
        logger?.trace('Run.end();', { runId, reason });

        await requireConnected('end');

        if (state === RunState.INITIALIZED) {
          throw new Ably.ErrorInfo(
            `unable to end run; start() must be called before end() (run ${runId})`,
            ErrorCode.InvalidArgument,
            400,
          );
        }
        if (state === RunState.ENDED) return;
        state = RunState.ENDED;

        try {
          await runManager.endRun(runId, reason, invocationId, resolvedInputClientId, resolvedInputCodecMessageId);
        } catch (error) {
          const errInfo = new Ably.ErrorInfo(
            `unable to publish run-end for run ${runId}; ${errorMessage(error)}`,
            ErrorCode.RunLifecycleError,
            500,
            error instanceof Ably.ErrorInfo ? error : undefined,
          );
          logger?.error('Run.end(); failed to publish run-end', { runId });
          throw errInfo;
        } finally {
          deregisterRun();
        }

        logger?.debug('Run.end(); run ended', { runId, reason });
      },
    };

    return run;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an agent (server-side) session bound to the given Realtime client
 * and channel name. The caller owns the client's lifecycle; the session
 * owns its channel.
 * @param options - Session configuration.
 * @returns A new {@link AgentSession} instance.
 */
export const createAgentSession = <
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
>(
  options: AgentSessionOptions<TInput, TOutput, TProjection, TMessage>,
): AgentSession<TOutput, TProjection, TMessage> => new DefaultAgentSession(options);
