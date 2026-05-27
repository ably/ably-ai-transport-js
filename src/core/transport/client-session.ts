/**
 * Core client-side session, parameterized by codec.
 *
 * Composes StreamRouter and Tree to handle the full client-side lifecycle.
 * `connect()` subscribes to the Ably channel (which implicitly attaches it).
 * The same subscription, decoder, and channel are reused across runs.
 *
 * The client publishes user messages directly to the channel via the shared
 * codec encoder, and POSTs an HTTP invocation in parallel. The agent
 * correlates the prompt by the `x-ably-invocation-id` header and publishes
 * run lifecycle events (run-start, run-end) plus assistant chunks. The
 * channel is the durable session record; agents that weren't running at
 * publish time can resume by reading channel rewind.
 */

import * as Ably from 'ably';

import {
  EVENT_CANCEL,
  EVENT_RUN_END,
  EVENT_RUN_START,
  HEADER_CODEC_MESSAGE_ID,
  HEADER_ERROR_CODE,
  HEADER_ERROR_MESSAGE,
  HEADER_FORK_OF,
  HEADER_INVOCATION_ID,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_CONTINUE,
  HEADER_RUN_ID,
  HEADER_RUN_REASON,
} from '../../constants.js';
import { ErrorCode } from '../../errors.js';
import { EventEmitter } from '../../event-emitter.js';
import type { Logger } from '../../logger.js';
import { LogLevel, makeLogger } from '../../logger.js';
import { getHeaders } from '../../utils.js';
import { registerAgent } from '../agent.js';
import type { Decoder, Encoder, ReducerMeta } from '../codec/types.js';
import { buildTransportHeaders } from './headers.js';
import type { StreamRouter } from './stream-router.js';
import { createStreamRouter } from './stream-router.js';
import type { DefaultTree } from './tree.js';
import { createTree } from './tree.js';
import type {
  ActiveRun,
  ClientSession,
  ClientSessionOptions,
  MessageNode,
  RunEndReason,
  RunLifecycleEvent,
  SendOptions,
  Tree,
  View,
} from './types.js';
import { createView, type DefaultView } from './view.js';

/**
 * Returned from `on()` when the session is already closed — the subscription
 * is silently ignored since no further events will fire.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional no-op
const noopUnsubscribe = (): void => {};

// ---------------------------------------------------------------------------
// Internal state machine
// ---------------------------------------------------------------------------

enum ClientSessionState {
  READY = 'ready',
  CLOSED = 'closed',
}

// ---------------------------------------------------------------------------
// Event map for the session's typed EventEmitter
// ---------------------------------------------------------------------------

interface ClientSessionEventsMap {
  error: Ably.ErrorInfo;
}

// ---------------------------------------------------------------------------
// Per-run observer state — consolidated to avoid parallel-map bookkeeping
// ---------------------------------------------------------------------------

interface RunObserverState<TProjection> {
  headers: Record<string, string>;
  serial: string | undefined;
  projection: TProjection;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

// Spec: AIT-CT1
class DefaultClientSession<TEvent, TProjection, TMessage> implements ClientSession<TEvent, TProjection, TMessage> {
  private readonly _channel: Ably.RealtimeChannel;
  private readonly _codec: ClientSessionOptions<TEvent, TProjection, TMessage>['codec'];
  private readonly _clientId: string | undefined;
  private readonly _api: string;
  private readonly _credentials: RequestCredentials | undefined;
  private readonly _headersFn: (() => Record<string, string>) | undefined;
  private readonly _bodyFn: (() => Record<string, unknown>) | undefined;
  private readonly _fetchFn: typeof globalThis.fetch;
  private readonly _logger: Logger;

  // Typed event emitter — only 'error' remains on the session
  private readonly _emitter: EventEmitter<ClientSessionEventsMap>;

  // Relay detection — tracks codec-message-ids of optimistic inserts for reconciliation
  private readonly _ownCodecMessageIds = new Set<string>();
  /**
   * Active runs initiated by this session: runId → most-recent invocationId.
   * Cleared on run-end. Used by the auto-cancel-duplicate path to identify
   * the prior invocation when the developer manually retries under the same
   * runId.
   */
  private readonly _ownRunIds = new Map<string, string>();

  // Track codecMessageIds per run for cleanup on run-end
  private readonly _runCodecMessageIds = new Map<string, Set<string>>();

  // Per-run observer state: headers, serial, and accumulator in one map.
  // A single .delete(runId) cleans up all three.
  private readonly _runObservers = new Map<string, RunObserverState<TProjection>>();

  // Callbacks to resolve pending waitForRun promises on close, preventing leaked subscriptions.
  private readonly _closeResolvers: (() => void)[] = [];

  // Sub-components
  private readonly _tree: DefaultTree<TMessage>;
  private readonly _view: DefaultView<TEvent, TProjection, TMessage>;
  private readonly _views = new Set<DefaultView<TEvent, TProjection, TMessage>>();
  private readonly _router: StreamRouter<TEvent>;
  private readonly _decoder: Decoder<TEvent>;
  /**
   * Shared encoder for the lifetime of the session. The client only ever uses
   * `writeMessages` (discrete publish path), so the encoder's stream tracker
   * map stays empty across the session. Closed once on session close.
   */
  private readonly _encoder: Encoder<TEvent>;

  // Spec: AIT-CT10, AIT-CT10a
  readonly tree: Tree<TMessage>;
  readonly view: View<TEvent, TProjection, TMessage>;

  // Channel subscription is established lazily on connect()
  private _connectPromise: Promise<void> | undefined;
  private readonly _onMessage: (msg: Ably.InboundMessage) => void;

  private _state = ClientSessionState.READY;
  private _hasAttachedOnce: boolean;
  private readonly _onChannelStateChange: Ably.channelEventCallback;

  /** Default deadline for the agent's `ai-run-start` to arrive after a `send()`. */
  private readonly _runStartDeadlineMs: number;

  /**
   * Pending send() promises awaiting `ai-run-start` for their invocation.
   * Keyed by invocation-id (which is unique per send). Resolved on run-start
   * receive; rejected on deadline lapse.
   */
  private readonly _pendingRunStarts = new Map<
    string,
    { resolve: () => void; reject: (e: Ably.ErrorInfo) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(options: ClientSessionOptions<TEvent, TProjection, TMessage>) {
    // Spec: AIT-CT1a, AIT-CT1a2 — register this SDK on both the connection
    // (options.agents) and channel-attach (params.agent) paths. Idempotent
    // across sessions sharing one client.
    const channelOptions = registerAgent(options.client);
    this._channel = options.client.channels.get(options.channelName, channelOptions);
    this._codec = options.codec;
    this._clientId = options.clientId;
    this._api = options.api;
    this._credentials = options.credentials;
    // CAST: TS can't narrow options.headers/body inside a closure because the outer
    // object is mutable. The truthiness check on the preceding line guarantees non-nullish.
    this._headersFn =
      typeof options.headers === 'function'
        ? options.headers
        : options.headers
          ? () => options.headers as Record<string, string>
          : undefined;
    this._bodyFn =
      typeof options.body === 'function'
        ? options.body
        : options.body
          ? () => options.body as Record<string, unknown>
          : undefined;
    this._fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this._runStartDeadlineMs = options.runStartDeadlineMs ?? 30000;
    this._logger = (options.logger ?? makeLogger({ logLevel: LogLevel.Silent })).withContext({
      component: 'ClientSession',
    });

    this._emitter = new EventEmitter<ClientSessionEventsMap>(this._logger);
    this._hasAttachedOnce = this._channel.state === 'attached';

    // Compose sub-components
    this._tree = createTree<TMessage>(this._logger);
    this._view = createView<TEvent, TProjection, TMessage>({
      tree: this._tree,
      channel: this._channel,
      codec: this._codec,
      sendDelegate: this._internalSend.bind(this),
      logger: this._logger,
      onClose: () => this._views.delete(this._view),
    });
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- isTerminal is the temporary bridge for terminal detection until LifecycleEvents land
    this._router = createStreamRouter<TEvent>(this._codec.isTerminal.bind(this._codec), this._logger);
    this._decoder = this._codec.createDecoder();
    this._encoder = this._codec.createEncoder(
      this._channel,
      this._clientId === undefined ? undefined : { clientId: this._clientId },
    );

    this._views.add(this._view);

    // Public accessors (typed as narrow interfaces)
    this.tree = this._tree;
    this.view = this._view;

    // Seed tree with initial messages — session assigns its own codecMessageId
    if (options.messages) {
      let prevCodecMessageId: string | undefined;
      for (const msg of options.messages) {
        const codecMessageId = crypto.randomUUID();
        const seedHeaders: Record<string, string> = { [HEADER_CODEC_MESSAGE_ID]: codecMessageId };
        if (prevCodecMessageId) seedHeaders[HEADER_PARENT] = prevCodecMessageId;
        this._tree.upsert(codecMessageId, msg, seedHeaders);
        prevCodecMessageId = codecMessageId;
      }
    }

    // Spec: AIT-CT2
    // Listener function reference — bound now so it can be unsubscribed on close.
    this._onMessage = (ablyMessage: Ably.InboundMessage) => {
      this._handleMessage(ablyMessage);
    };

    // Listen for channel state changes that break message continuity.
    // _hasAttachedOnce is seeded from the channel's current state so that
    // pre-attached channels are handled correctly. It distinguishes the
    // initial attach (expected) from a genuine discontinuity.
    this._onChannelStateChange = (stateChange: Ably.ChannelStateChange) => {
      this._handleChannelStateChange(stateChange);
    };
    this._channel.on(this._onChannelStateChange);
  }

  // ---------------------------------------------------------------------------
  // Public connection API
  // ---------------------------------------------------------------------------

  // Spec: AIT-CT2
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- preserve reference equality across calls
  connect(): Promise<void> {
    if (this._state === ClientSessionState.CLOSED) {
      return Promise.reject(new Ably.ErrorInfo('unable to connect; session is closed', ErrorCode.SessionClosed, 400));
    }
    if (this._connectPromise) return this._connectPromise;

    this._logger.trace('DefaultClientSession.connect();');
    // Subscribe before attach (RTL7g) — subscribe implicitly attaches the channel.
    this._connectPromise = this._channel.subscribe(this._onMessage).then(
      () => {
        this._logger.debug('DefaultClientSession.connect(); subscribed and attached');
      },
      (error: unknown) => {
        const errInfo = new Ably.ErrorInfo(
          `unable to subscribe to channel; ${error instanceof Error ? error.message : String(error)}`,
          ErrorCode.SessionSubscriptionError,
          500,
          error instanceof Ably.ErrorInfo ? error : undefined,
        );
        this._logger.error('DefaultClientSession.connect(); subscribe failed');
        this._emitter.emit('error', errInfo);
        throw errInfo;
      },
    );
    return this._connectPromise;
  }

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

  // ---------------------------------------------------------------------------
  // Message subscription handler
  // ---------------------------------------------------------------------------

  private _handleMessage(ablyMessage: Ably.InboundMessage): void {
    if (this._state === ClientSessionState.CLOSED) return;

    try {
      // Spec: AIT-CT16a
      // --- Run lifecycle events from the agent ---
      if (ablyMessage.name === EVENT_RUN_START) {
        const headers = getHeaders(ablyMessage);
        const runId = headers[HEADER_RUN_ID];
        const runCid = headers[HEADER_RUN_CLIENT_ID] ?? '';
        const invocationId = headers[HEADER_INVOCATION_ID];
        if (runId) {
          this._tree.trackRun(runId, runCid);
          const parentRaw = headers[HEADER_PARENT];
          const forkOf = headers[HEADER_FORK_OF];
          const isContinuation = headers[HEADER_RUN_CONTINUE] === 'true';
          this._tree.emitRun({
            type: EVENT_RUN_START,
            runId,
            clientId: runCid,
            ...(parentRaw !== undefined && { parent: parentRaw }),
            ...(forkOf !== undefined && { forkOf }),
            ...(isContinuation && { isContinuation: true }),
          });
          if (invocationId) {
            const pending = this._pendingRunStarts.get(invocationId);
            if (pending) {
              clearTimeout(pending.timer);
              this._pendingRunStarts.delete(invocationId);
              pending.resolve();
            }
          }
        }
        this._tree.emitAblyMessage(ablyMessage);
        return;
      }

      if (ablyMessage.name === EVENT_RUN_END) {
        const headers = getHeaders(ablyMessage);
        const runId = headers[HEADER_RUN_ID];
        const runCid = headers[HEADER_RUN_CLIENT_ID] ?? '';
        const invocationId = headers[HEADER_INVOCATION_ID];
        // CAST: agent always writes a valid RunEndReason; default to 'complete' for robustness
        const reason = (headers[HEADER_RUN_REASON] ?? 'complete') as RunEndReason;

        // When reason is 'error' the agent surfaces a mid-run failure
        // via the x-ably-error-code / x-ably-error-message headers.
        // Reify the error, route it to the active stream, and emit the
        // session error event before falling through to the regular
        // run-end teardown. The agent only publishes `run-end` after it
        // has published `run-start`, so no pending-run-start tracker is
        // outstanding at this point.
        if (reason === 'error') {
          const codeRaw = headers[HEADER_ERROR_CODE];
          const parsedCode = codeRaw === undefined ? Number.NaN : Number(codeRaw);
          const code = Number.isFinite(parsedCode) ? parsedCode : ErrorCode.SessionSubscriptionError;
          const message = headers[HEADER_ERROR_MESSAGE] ?? 'agent reported an error';
          const statusCode = code >= 10000 && code < 60000 ? Math.floor(code / 100) : 500;
          const errInfo = new Ably.ErrorInfo(message, code, statusCode);
          if (runId) this._router.errorStream(runId, errInfo);
          this._logger.error('ClientSession._handleMessage(); agent error received', {
            runId,
            invocationId,
            code,
          });
          this._emitter.emit('error', errInfo);
        }

        if (runId) {
          // Defensive run-end gating: when a run has multiple invocations
          // (e.g. developer manually retried under the same runId, OR the
          // run was suspended and continued under a fresh invocation), only
          // the currently-bound invocation's run-end should terminate the
          // local run state.
          //
          // For own runs the router holds the most recent invocation —
          // either the most-recent send's, or the rebound continuation's.
          // For observer runs the router has no entry, so we fall through
          // to the Tree's serial-derived winning-invocation map.
          //
          // A run-end whose invocation matches neither source is dropped as
          // a losing-invocation echo.
          const routerActive = this._router.getActiveInvocation(runId);
          const treeWinner = this._tree.getWinningInvocation(runId)?.invocationId;
          if (
            invocationId !== undefined &&
            ((routerActive !== undefined && routerActive !== invocationId) ||
              (routerActive === undefined && treeWinner !== undefined && treeWinner !== invocationId))
          ) {
            this._logger.debug('ClientSession.runEnd; ignoring losing-invocation run-end', {
              runId,
              invocationId,
              routerActive,
              treeWinner,
            });
            this._tree.emitAblyMessage(ablyMessage);
            return;
          }
          // `suspended` keeps the run live so a continuation that reuses
          // the runId picks up where it left off. Router stream, observer
          // state, and tree run-tracking survive. The `run` event still
          // fires so listeners can react to the suspend.
          if (reason !== 'suspended') {
            this._router.closeStream(runId);
            this._runObservers.delete(runId);
            this._tree.untrackRun(runId);
            const codecMessageIds = this._runCodecMessageIds.get(runId);
            if (codecMessageIds) {
              for (const mid of codecMessageIds) this._ownCodecMessageIds.delete(mid);
              this._runCodecMessageIds.delete(runId);
            }
            this._ownRunIds.delete(runId);
          }
          this._tree.emitRun({ type: EVENT_RUN_END, runId, clientId: runCid, reason });
        }
        this._tree.emitAblyMessage(ablyMessage);
        return;
      }

      // --- Codec-decoded events ---
      const events = this._decoder.decode(ablyMessage);
      const headers = getHeaders(ablyMessage);
      const serial = ablyMessage.serial;
      const codecMessageId = headers[HEADER_CODEC_MESSAGE_ID];
      // Wire `HEADER_CODEC_MESSAGE_ID` is THE routing key for the reducer's
      // per-message-id fold path. Events that modify a previously-published
      // message (client tool outputs, approval responses, agent
      // approved-tool outputs) carry the original message's id here.
      const routingCodecMessageId = codecMessageId;

      // Always update observer headers, even when the decoder produces no events.
      // This ensures header transitions (e.g. x-ably-status: streaming → cancelled)
      // are captured for events that the decoder suppresses (AIT-CD8: cancelled
      // stream appends emit no events but still carry the updated status header).
      const runId = headers[HEADER_RUN_ID];
      if (runId) {
        this._updateRunObserverHeaders(runId, headers, serial);
      }

      for (const event of events) {
        this._handleEvent(event, headers, { serial: serial ?? '', messageId: routingCodecMessageId });
      }

      // Emit ably-message AFTER decode/upsert so that View subscribers can
      // find the node in _lastVisibleIds (which is refreshed by tree 'update'
      // events triggered during upsert).
      this._tree.emitAblyMessage(ablyMessage);
    } catch (error) {
      const cause = error instanceof Ably.ErrorInfo ? error : undefined;
      this._emitter.emit(
        'error',
        new Ably.ErrorInfo(
          `unable to process channel message; ${error instanceof Error ? error.message : String(error)}`,
          ErrorCode.SessionSubscriptionError,
          500,
          cause,
        ),
      );
    }
  }

  /**
   * Handle a decoded TEvent: route to the active stream (own run) and fold into
   * the observer's projection. Observer cleanup happens on `run-end` (with a
   * non-suspended reason) in `_handleMessage` — keeping observer state alive
   * past a stream-terminal event lets late amend events (e.g. tool-output
   * resolutions) fold into the same assistant message.
   * @param event - The decoded TEvent.
   * @param headers - Ably headers from the wire message.
   * @param meta - Reducer meta — serial and codec-message-id for routing.
   */
  private _handleEvent(event: TEvent, headers: Record<string, string>, meta: ReducerMeta): void {
    const runId = headers[HEADER_RUN_ID];
    if (!runId) return;

    const invocationId = headers[HEADER_INVOCATION_ID];

    // Active own run — route to the ReadableStream. Events from a different
    // invocation under the same runId (a losing retry) are dropped by the
    // router. Note: the router closes its stream on terminal events (per
    // `isTerminal`), but the observer state below stays alive until run-end.
    if (this._router.route(runId, invocationId, event)) {
      this._accumulateAndEmit(runId, event, meta);
      return;
    }

    // Spec: AIT-CT16
    // Observer run — fold into projection and emit.
    this._accumulateAndEmit(runId, event, meta);
  }

  // ---------------------------------------------------------------------------
  // Channel state change handler
  // ---------------------------------------------------------------------------

  // Spec: AIT-CT19, AIT-CT19a
  private _handleChannelStateChange(stateChange: Ably.ChannelStateChange): void {
    if (this._state === ClientSessionState.CLOSED) return;

    const { current, resumed } = stateChange;

    // Track the initial attach so we don't treat it as a discontinuity
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

    this._logger.error('ClientSession._handleChannelStateChange(); channel continuity lost', {
      current,
      resumed,
      previous: stateChange.previous,
    });

    const err = new Ably.ErrorInfo(
      `unable to deliver events; channel continuity lost (${current}${current === 'attached' ? ', resumed: false' : ''})`,
      ErrorCode.ChannelContinuityLost,
      500,
      stateChange.reason,
    );

    // As with cancellation (_closeRunStream), do not clear _ownRunIds
    // or _runObservers here — late events must still accumulate into the
    // tree. The run-end handler cleans up observers.
    for (const runId of this._ownRunIds.keys()) {
      this._router.errorStream(runId, err);
    }

    this._emitter.emit('error', err);
  }

  // ---------------------------------------------------------------------------
  // Observer accumulation
  // ---------------------------------------------------------------------------

  /**
   * Ensure a RunObserverState exists for runId, updating headers and serial as new events arrive.
   * @param runId - The run to track.
   * @param headers - Headers from the current event.
   * @param serial - Ably serial from the current event.
   */
  private _updateRunObserverHeaders(runId: string, headers: Record<string, string>, serial: string | undefined): void {
    const existing = this._runObservers.get(runId);
    if (existing) {
      if (Object.keys(headers).length > 0) {
        Object.assign(existing.headers, headers);
      }
      // Always advance the serial so the tree node sorts after all
      // earlier messages in the run (e.g. user-message relays that
      // arrive before the assistant response).
      if (serial !== undefined) {
        existing.serial = serial;
      }
    } else {
      this._runObservers.set(runId, {
        headers: { ...headers },
        serial,
        projection: this._codec.init(),
      });
    }
  }

  /**
   * Fold an event into the run's projection and emit the matching message.
   * Wraps `fold` in try/catch — a throwing reducer is treated as a
   * developer/codec bug: emit a session-level error, drop the event, leave
   * projection state unchanged for that event.
   * @param runId - The run this event belongs to.
   * @param event - The decoded TEvent.
   * @param meta - Reducer meta (serial + codec-message-id).
   */
  private _accumulateAndEmit(runId: string, event: TEvent, meta: ReducerMeta): void {
    const observer = this._runObservers.get(runId);
    if (!observer) return;

    try {
      observer.projection = this._codec.fold(observer.projection, event, meta);
    } catch (error) {
      this._logger.error('ClientSession._accumulateAndEmit(); fold threw', { runId, error });
      this._emitter.emit(
        'error',
        new Ably.ErrorInfo(
          `unable to fold event; ${error instanceof Error ? error.message : String(error)}`,
          ErrorCode.SessionSubscriptionError,
          500,
          error instanceof Ably.ErrorInfo ? error : undefined,
        ),
      );
      return;
    }

    const messages = this._codec.getMessages(observer.projection);
    if (messages.length === 0) return;

    // Locate the projection message this event belongs to:
    // - Normal echo (user msg or assistant chunk): the wire `HEADER_CODEC_MESSAGE_ID`
    //   matches an owner in the projection. Use it.
    // - Tool-resolution redirect: the wire `HEADER_CODEC_MESSAGE_ID` is the
    //   continuation's own tree codecMessageId, but the reducer redirected the
    //   payload onto a prior assistant (and added the continuation codecMessageId
    //   to `consumedCodecMessageIds`, filtering it from `getMessages`). The fallback
    //   `.at(-1)` lands on the mutated assistant.
    const wireCodecMessageId = observer.headers[HEADER_CODEC_MESSAGE_ID];
    // CAST: TMessage is opaque to the core session, but the projection
    // lookup needs to match by domain `id` (the codec sets each message's
    // `id` to the wire codec-message-id). Tracked for removal via the codec-method
    // follow-up noted below.
    const message =
      wireCodecMessageId === undefined
        ? messages.at(-1)
        : (messages.find((m) => (m as { id?: string }).id === wireCodecMessageId) ?? messages.at(-1));
    if (!message) return;

    let cloned: TMessage;
    try {
      cloned = structuredClone(message);
    } catch {
      // structuredClone can fail if the message contains non-cloneable
      // values (e.g. functions). Fall back to the reference — the tree
      // upsert below copies headers independently.
      cloned = message;
    }

    // Distinguish the two upsert keys via role:
    // - Wire role 'user' + projection fallback is role 'assistant' →
    //   tool-resolution redirect. Upsert at the assistant's id (= its
    //   tree codecMessageId by reducer convention) so the existing assistant tree
    //   node updates instead of a phantom node being created at the
    //   consumed continuation codecMessageId. Preserve the existing tree headers
    //   so the assistant's `parent` / `forkOf` / `role` aren't overwritten
    //   by the continuation wire's headers.
    // - Otherwise (normal echo, includes user-msg echo where UIMessage.id
    //   != wireCodecMessageId because the codec keeps the domain id distinct from
    //   the wire's `x-ably-codec-message-id`) → upsert at `wireCodecMessageId`. The optimistic
    //   insert used the same key; the echo converges with that node.
    //
    // TODO(follow-up): this is a residual codec-specific peek in the core
    // layer (mirrors the send-path duck-type that this refactor removed).
    // To eliminate it cleanly the codec needs to expose "which projection
    // codecMessageId did this fold land on?" — proposed for a follow-up PR.
    const wireRole = observer.headers[HEADER_ROLE];
    // CAST: TMessage is opaque to the core session, but the tool-resolution
    // redirect (see comment above) needs to read its `role` to distinguish
    // a user-message echo from an assistant-redirected fold. Tracked for
    // removal via a codec-method follow-up.
    const messageRole = (message as { role?: string }).role;
    const isRedirect = wireRole === 'user' && messageRole === 'assistant';

    if (isRedirect) {
      // CAST: see `messageRole` cast above — same follow-up applies.
      const actualCodecMessageId = (message as { id?: string }).id;
      if (!actualCodecMessageId) return;
      const existing = this._tree.getHeaders(actualCodecMessageId);
      const upsertHeaders = existing
        ? { ...existing }
        : { ...observer.headers, [HEADER_CODEC_MESSAGE_ID]: actualCodecMessageId };
      this._tree.upsert(actualCodecMessageId, cloned, upsertHeaders, observer.serial);
    } else {
      if (wireCodecMessageId === undefined) return;
      this._tree.upsert(wireCodecMessageId, cloned, { ...observer.headers }, observer.serial);
    }
  }

  // ---------------------------------------------------------------------------
  // Cancel helpers
  // ---------------------------------------------------------------------------

  /**
   * Tear down local state for a run that failed before run-start could
   * complete. Idempotent.
   * @param runId - The runId of the failed send.
   * @param options - Cleanup options.
   * @param options.removeOptimistic - When true, delete optimistic tree
   *   nodes for this send that haven't been acked yet (no serial). Set on
   *   publish-leg failure (channel never received the message); leave
   *   false on POST-leg failure (channel accepted it — keep local state
   *   in sync with what observers see).
   */
  private _cleanupFailedSend(runId: string, options: { removeOptimistic: boolean }): void {
    const codecMessageIds = this._runCodecMessageIds.get(runId);
    if (codecMessageIds) {
      if (options.removeOptimistic) {
        for (const codecMessageId of codecMessageIds) {
          const node = this._tree.getNode(codecMessageId);
          if (node && node.serial === undefined) {
            this._tree.delete(codecMessageId);
          }
        }
      }
      for (const codecMessageId of codecMessageIds) {
        this._ownCodecMessageIds.delete(codecMessageId);
      }
    }
    this._ownRunIds.delete(runId);
    this._runCodecMessageIds.delete(runId);
    this._runObservers.delete(runId);
    this._tree.untrackRun(runId);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  // Spec: AIT-CT10b
  createView(): View<TEvent, TProjection, TMessage> {
    if (this._state === ClientSessionState.CLOSED) {
      throw new Ably.ErrorInfo('unable to create view; session is closed', ErrorCode.SessionClosed, 400);
    }
    this._logger.trace('DefaultClientSession.createView();');
    const view = createView<TEvent, TProjection, TMessage>({
      tree: this._tree,
      channel: this._channel,
      codec: this._codec,
      sendDelegate: this._internalSend.bind(this),
      logger: this._logger,
      onClose: () => this._views.delete(view),
    });
    this._views.add(view);
    return view;
  }

  // Spec: AIT-CT3, AIT-CT4
  private async _internalSend(
    input: { event: TEvent; domainMessageId?: string }[],
    sendOptions: SendOptions | undefined,
    history: MessageNode<TMessage>[],
  ): Promise<ActiveRun<TEvent>> {
    if (this._state === ClientSessionState.CLOSED) {
      throw new Ably.ErrorInfo('unable to send; session is closed', ErrorCode.SessionClosed, 400);
    }
    await this._requireConnected('send');
    // CAST: re-check after await — close() may have been called while waiting for connect.
    // TypeScript's control flow narrows _state after the first check, but the
    // await yields and close() can mutate _state concurrently.
    if ((this._state as ClientSessionState) === ClientSessionState.CLOSED) {
      throw new Ably.ErrorInfo('unable to send; session is closed', ErrorCode.SessionClosed, 400);
    }

    // Spec: AIT-CT20
    const state = this._channel.state;
    if (state !== 'attached' && state !== 'attaching') {
      throw new Ably.ErrorInfo(`unable to send; channel is ${state}`, ErrorCode.ChannelNotReady, 400);
    }

    this._logger.trace('ClientSession._internalSend();');

    // Classify each event up front; reject if any are unrecognized by the
    // codec. Events split into two send-path shapes:
    //
    // - `user-message`: a fresh user prompt OR a continuation tool resolution
    //   (tool output / approval response). Both ride the same wire path
    //   and the same optimistic-fold path; the reducer inline-detects tool
    //   resolutions and folds them onto the prior assistant.
    // - `regenerate`: a wire-only event that carries `parent`/`forkOf`
    //   headers but materialises no TMessage (`View.regenerate` starts
    //   a new run forked off an assistant without re-publishing the
    //   user). The client mints `codecMessageId`/`eventId` for the wire and the
    //   agent's prompt-lookup catches it; no tree-upsert or optimistic
    //   projection fold happens.
    type ClassifiedItem =
      | {
          kind: 'user-message';
          event: TEvent;
          /**
           * Caller-supplied wire `x-ably-codec-message-id` override (e.g. a continuation
           * tool resolution targeting the prior assistant's tree key). When
           * set, the SDK uses this as the wire codec-message-id and the optimistic
           * fold's `meta.messageId` instead of minting a fresh UUID.
           */
          domainMessageId?: string;
          /** Allocated below in the optimistic-insert phase. */
          state?: { codecMessageId: string; headers: Record<string, string> };
        }
      | {
          kind: 'regenerate';
          event: TEvent;
          parent: string;
          forkOf: string;
          /** Allocated below in the publish-headers phase. */
          state?: { codecMessageId: string; headers: Record<string, string> };
        };
    const classified: ClassifiedItem[] = [];
    for (const entry of input) {
      const cls = this._codec.classifyEvent(entry.event);
      if (cls.kind === 'other') {
        throw new Ably.ErrorInfo(
          'unable to send; codec did not classify event as user-message or regenerate',
          ErrorCode.InvalidArgument,
          400,
        );
      }
      if (cls.kind === 'regenerate') {
        classified.push({ kind: 'regenerate', event: entry.event, parent: cls.parent, forkOf: cls.forkOf });
      } else {
        classified.push({
          kind: 'user-message',
          event: entry.event,
          ...(entry.domainMessageId !== undefined && { domainMessageId: entry.domainMessageId }),
        });
      }
    }

    const isContinuation = sendOptions?.runId !== undefined;

    // Every send must carry at least one classified event — either a user
    // message (fresh prompt or continuation tool resolution) or a regenerate
    // event. The only exception is a continuation rebind under an existing
    // runId that carries no new tool resolutions (rare, but allowed — the
    // agent's existing prompts are already on the channel).
    if (input.length === 0 && !isContinuation) {
      throw new Ably.ErrorInfo(
        'unable to send; events array is empty (pass options.runId for continuation, or include at least one user-message / regenerate event)',
        ErrorCode.InvalidArgument,
        400,
      );
    }

    const runId = sendOptions?.runId ?? crypto.randomUUID();
    const invocationId = sendOptions?.invocationId ?? crypto.randomUUID();
    this._ownRunIds.set(runId, invocationId);

    if (!isContinuation) {
      this._tree.trackRun(runId, this._clientId ?? '');
    }

    // The View pre-computed the visible branch before calling this delegate,
    // so preInsertHistory reflects the state before any optimistic inserts.
    const preInsertHistory = history;

    // Spec: AIT-CT3d
    // Auto-compute parent from the current thread if not explicitly provided.
    // Continuations rely on this rule too — `preInsertHistory.at(-1)` is the
    // suspended assistant, so tool-resolution user-messages parent off it
    // without any explicit `sendOptions.parent`.
    let autoParent: string | undefined;
    if (sendOptions?.parent === undefined && !sendOptions?.forkOf) {
      const lastNode = preInsertHistory.at(-1);
      if (lastNode) {
        autoParent = lastNode.codecMessageId;
      }
    }

    const codecMessageIds = new Set<string>();
    // One event-id minted per user-message item. The invocation body
    // carries the list so the agent looks up exactly these prompts on the
    // channel via `x-ably-event-id`.
    const eventIds: string[] = [];

    // Optimistic tree insert per classified item.
    for (const item of classified) {
      if (item.kind === 'regenerate') {
        // Regenerate events publish wire-only. Mint a fresh codecMessageId/eventId,
        // build headers from the event's parent/forkOf (not from
        // autoParent / sendOptions), then leave tree and projection
        // untouched. The agent's prompt-lookup picks the event up by
        // its eventId and reads parent/forkOf from these headers.
        const codecMessageId = crypto.randomUUID();
        const eventId = crypto.randomUUID();
        this._ownCodecMessageIds.add(codecMessageId);
        codecMessageIds.add(codecMessageId);
        eventIds.push(eventId);

        const regenerateHeaders = buildTransportHeaders({
          role: 'user',
          runId,
          codecMessageId,
          runClientId: this._clientId,
          parent: item.parent,
          forkOf: item.forkOf,
          invocationId,
          eventId,
          runContinue: isContinuation,
        });
        item.state = { codecMessageId, headers: regenerateHeaders };
        continue;
      }

      // Caller-supplied `domainMessageId` (e.g. chat-transport's
      // continuation tool resolution targeting the prior assistant's
      // tree key) takes precedence over the SDK-minted fresh id. When
      // set, the wire's `x-ably-codec-message-id` matches the existing
      // assistant's tree key so the reducer's direct-fold path runs
      // instead of the cross-message redirect-by-toolCallId fallback.
      const codecMessageId = item.domainMessageId ?? crypto.randomUUID();
      const eventId = crypto.randomUUID();
      this._ownCodecMessageIds.add(codecMessageId);
      codecMessageIds.add(codecMessageId);
      eventIds.push(eventId);

      const resolvedParent = sendOptions?.parent === undefined ? autoParent : sendOptions.parent;

      const optimisticHeaders = buildTransportHeaders({
        role: 'user',
        runId,
        codecMessageId,
        runClientId: this._clientId,
        parent: resolvedParent,
        forkOf: sendOptions?.forkOf,
        invocationId,
        eventId,
        runContinue: isContinuation,
      });

      // Spec: AIT-CT3c
      // Optimistic update via the reducer. Fresh user prompts and tool
      // resolutions both flow through the same path: fold the event into
      // the run's projection, then upsert from the projection. The reducer
      // handles fresh prompts by appending a UIMessage; tool resolutions
      // are redirected onto the prior assistant via `consumedCodecMessageIds`. The
      // session stays codec-agnostic — no peek inside TMessage.
      // eslint-disable-next-line unicorn/no-useless-undefined -- `_updateRunObserverHeaders` distinguishes "no serial yet" from a known serial via `undefined`.
      this._updateRunObserverHeaders(runId, optimisticHeaders, undefined);
      this._accumulateAndEmit(runId, item.event, { serial: '', messageId: codecMessageId });

      item.state = { codecMessageId, headers: optimisticHeaders };

      // Spec: AIT-CT3e — chain subsequent user messages off the previous one.
      if (sendOptions?.parent === undefined && !sendOptions?.forkOf) {
        autoParent = codecMessageId;
      }
    }

    this._runCodecMessageIds.set(runId, codecMessageIds);

    // Stream setup. Fresh send opens a new stream; continuation rebinds the
    // existing one. If the suspended stream was torn down (e.g. cancel /
    // continuity loss), fall back to creating a fresh stream so the
    // continuation still completes — observers will see the events even if
    // the originally-returned readable was already drained.
    let stream: ReadableStream<TEvent>;
    if (isContinuation) {
      const existing = this._router.rebindStream(runId, invocationId);
      stream = existing ?? this._router.createStream(runId, invocationId);
    } else {
      stream = this._router.createStream(runId, invocationId);
    }

    // Arm a pending-run-start tracker keyed by invocationId. The run-start
    // handler resolves it; the deadline timer rejects it. A `runStartDeadlineMs`
    // of 0 disables the wait entirely — tests and in-process drivers use it.
    const waitForRunStart = this._runStartDeadlineMs > 0;
    const runStartPromise: Promise<void> = waitForRunStart
      ? new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            if (!this._pendingRunStarts.has(invocationId)) return;
            this._pendingRunStarts.delete(invocationId);
            const err = new Ably.ErrorInfo(
              `unable to start run; no run-start for invocation ${invocationId} within ${String(this._runStartDeadlineMs)}ms`,
              ErrorCode.RunStartDeadlineExceeded,
              504,
            );
            this._logger.warn('ClientSession.send(); runStartDeadlineMs exceeded', {
              runId,
              invocationId,
            });
            this._router.errorStream(runId, err);
            reject(err);
          }, this._runStartDeadlineMs);
          this._pendingRunStarts.set(invocationId, { resolve, reject, timer });
        })
      : Promise.resolve();

    runStartPromise.catch(() => {
      /* handled below via await; suppress unhandled-rejection warning */
    });

    const failPending = (err: Ably.ErrorInfo): void => {
      const pending = this._pendingRunStarts.get(invocationId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this._pendingRunStarts.delete(invocationId);
      pending.reject(err);
    };

    // Publish each event in original order via the shared encoder. The codec
    // routes user-message events into a per-part discrete batch and
    // tool-resolution events (tool outputs / approval responses) into a
    // single discrete write — both ride the same `role: 'user'` wire path.
    const publishPromise = (async () => {
      try {
        for (const item of classified) {
          if (!item.state) {
            // Defensive: every item gains a state above.
            throw new Ably.ErrorInfo(
              'unable to send; user-message item missing optimistic state',
              ErrorCode.InvalidArgument,
              500,
            );
          }
          await this._encoder.publish(item.event, {
            extras: { headers: item.state.headers },
            messageId: item.state.codecMessageId,
            ...(this._clientId !== undefined && { clientId: this._clientId }),
          });
        }
      } catch (error) {
        const cause = error instanceof Ably.ErrorInfo ? error : undefined;
        const isPermission = cause?.statusCode === 401 || cause?.statusCode === 403;
        const err = new Ably.ErrorInfo(
          isPermission
            ? `unable to publish events; missing publish capability on the channel`
            : `unable to publish events; ${error instanceof Error ? error.message : String(error)}`,
          isPermission ? ErrorCode.InsufficientCapability : ErrorCode.SessionSendFailed,
          isPermission ? 401 : 500,
          cause,
        );
        this._emitter.emit('error', err);
        this._router.errorStream(runId, err);
        failPending(err);
        // Continuations didn't insert optimistic nodes, so removeOptimistic
        // is moot for them — only fresh sends need to clear their inserts.
        this._cleanupFailedSend(runId, { removeOptimistic: !isContinuation });
        throw err;
      }
    })();

    const resolvedHeaders = this._headersFn?.() ?? {};
    const resolvedBody = this._bodyFn?.() ?? {};

    // History as projection-folded TMessage[]. The tree stores each node's
    // codec-folded `.message`, so projecting the selected branch is just
    // a per-node `.message` extraction — no re-fold required. The agent
    // feeds this straight to the LLM as prior conversation context.
    const postHistory = preInsertHistory.map((n) => n.message);

    const postBody: Record<string, unknown> = {
      ...resolvedBody,
      history: postHistory,
      ...sendOptions?.body,
      runId,
      invocationId,
      eventIds,
    };

    const postHeaders: Record<string, string> = {
      ...resolvedHeaders,
      ...sendOptions?.headers,
    };

    // Spec: AIT-CT3a, AIT-CT3b
    this._fetchFn(this._api, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...postHeaders,
      },
      body: JSON.stringify(postBody),
      ...(this._credentials ? { credentials: this._credentials } : {}),
    })
      .then((response) => {
        if (!response.ok) {
          const err = new Ably.ErrorInfo(
            `unable to send; HTTP POST to ${this._api} returned ${String(response.status)} ${response.statusText}`,
            ErrorCode.SessionSendFailed,
            response.status,
          );
          this._emitter.emit('error', err);
          this._router.errorStream(runId, err);
          failPending(err);
          // POST failed AFTER the channel publish completed. Keep optimistic
          // nodes so the local tree mirrors what observers see; only clear
          // active-run maps.
          this._cleanupFailedSend(runId, { removeOptimistic: false });
        }
      })
      .catch((error: unknown) => {
        const cause = error instanceof Ably.ErrorInfo ? error : undefined;
        const err = new Ably.ErrorInfo(
          `unable to send; HTTP POST to ${this._api} failed: ${error instanceof Error ? error.message : String(error)}`,
          ErrorCode.SessionSendFailed,
          500,
          cause,
        );
        this._emitter.emit('error', err);
        this._router.errorStream(runId, err);
        failPending(err);
        this._cleanupFailedSend(runId, { removeOptimistic: false });
      });

    await publishPromise;
    await runStartPromise;

    return {
      stream,
      runId,
      invocationId,
      cancel: async () => this.cancel(runId),
      optimisticCodecMessageIds: [...codecMessageIds],
      eventIds: [...eventIds],
    };
  }

  // Spec: AIT-CT7, AIT-CT7a
  async cancel(runId: string): Promise<void> {
    if (this._state === ClientSessionState.CLOSED) return;
    await this._requireConnected('cancel');
    // CAST: re-check after await — close() may have been called while waiting for connect.
    if ((this._state as ClientSessionState) === ClientSessionState.CLOSED) return;
    this._logger.debug('ClientSession.cancel();', { runId });

    await this._channel.publish({
      name: EVENT_CANCEL,
      extras: { headers: { [HEADER_RUN_ID]: runId } },
    });

    // Close the local router stream. Do NOT clear `_runObservers` — the
    // observer must remain alive so that late agent events (e.g. cancel
    // append, `x-ably-status: cancelled`) arriving before run-end are still
    // accumulated into the message store. The run-end handler cleans up
    // observers.
    this._router.closeStream(runId);
  }

  // Spec: AIT-CT18
  async waitForRun(runId: string): Promise<void> {
    if (this._state === ClientSessionState.CLOSED) return;
    await this._requireConnected('waitForRun');
    // CAST: re-check after await — close() may have been called while waiting for connect.
    if ((this._state as ClientSessionState) === ClientSessionState.CLOSED) return;

    // Short-circuit if the run is not active in any client's run set.
    let active = false;
    for (const runIds of this._tree.getActiveRunIds().values()) {
      if (runIds.has(runId)) {
        active = true;
        break;
      }
    }
    if (!active) return;

    this._logger.debug('ClientSession.waitForRun();', { runId });

    return new Promise<void>((resolve) => {
      let resolvedFlag = false;
      const done = (): void => {
        if (resolvedFlag) return;
        resolvedFlag = true;
        unsub();
        const idx = this._closeResolvers.indexOf(done);
        if (idx !== -1) this._closeResolvers.splice(idx, 1);
        resolve();
      };

      const unsub = this._tree.on('run', (event: RunLifecycleEvent) => {
        if (event.type !== EVENT_RUN_END) return;
        if (event.runId === runId) done();
      });

      // Resolve on session close to prevent leaked subscriptions
      this._closeResolvers.push(done);
    });
  }

  // Spec: AIT-CT8, AIT-CT8c, AIT-CT8d
  on(event: 'error', handler: (error: Ably.ErrorInfo) => void): () => void {
    if (this._state === ClientSessionState.CLOSED) return noopUnsubscribe;
    const cb = handler;
    this._emitter.on(event, cb);
    return () => {
      this._emitter.off(event, cb);
    };
  }

  // Spec: AIT-CT12, AIT-CT12b, AIT-CT10c
  async close(): Promise<void> {
    if (this._state === ClientSessionState.CLOSED) return;
    this._state = ClientSessionState.CLOSED;
    this._logger.info('ClientSession.close();');

    if (this._connectPromise) {
      this._channel.unsubscribe(this._onMessage);
    }
    this._channel.off(this._onChannelStateChange);

    // Close any remaining active streams
    for (const runId of this._ownRunIds.keys()) {
      this._router.closeStream(runId);
    }

    this._runObservers.clear();
    this._emitter.off();
    for (const v of this._views) v.close();
    this._views.clear();
    for (const resolve of this._closeResolvers) resolve();
    this._closeResolvers.length = 0;
    // Reject any in-flight pending run-starts and clear their timers so the
    // owning send() promises settle rather than hang.
    if (this._pendingRunStarts.size > 0) {
      const closedErr = new Ably.ErrorInfo('unable to await run-start; session closed', ErrorCode.SessionClosed, 400);
      for (const pending of this._pendingRunStarts.values()) {
        clearTimeout(pending.timer);
        pending.reject(closedErr);
      }
      this._pendingRunStarts.clear();
    }
    this._ownRunIds.clear();
    this._ownCodecMessageIds.clear();
    this._runCodecMessageIds.clear();

    // Best-effort encoder close — flushes any pending stream operations.
    // The client only uses the discrete path (writeMessages), so this is
    // typically a no-op, but it releases any internal resources cleanly.
    try {
      await this._encoder.close();
    } catch {
      // Swallow: encoder close is best-effort during teardown
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a client-side session that manages conversation state over an Ably channel.
 *
 * The caller owns the client's lifecycle; the session owns its channel.
 * The session is created in a not-yet-connected state — callers must
 * `await session.connect()` before `send`, `regenerate`, `edit`, `update`,
 * `cancel`, or `waitForRun`.
 * @param options - Configuration for the client session.
 * @returns A new {@link ClientSession} instance.
 */
export const createClientSession = <TEvent, TProjection, TMessage>(
  options: ClientSessionOptions<TEvent, TProjection, TMessage>,
): ClientSession<TEvent, TProjection, TMessage> => new DefaultClientSession(options);
