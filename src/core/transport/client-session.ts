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
  HEADER_EVENT_ID,
  HEADER_FORK_OF,
  HEADER_INVOCATION_ID,
  HEADER_MSG_REGENERATE,
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
import type { CodecInputEvent, CodecOutputEvent, Decoder, Encoder } from '../codec/types.js';
import { buildTransportHeaders } from './headers.js';
import type { StreamRouter } from './stream-router.js';
import { createStreamRouter } from './stream-router.js';
import type { DefaultTree } from './tree.js';
import { createTree } from './tree.js';
import type { ActiveRun, ClientSession, ClientSessionOptions, RunEndReason, SendOptions, Tree, View } from './types.js';
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
// Implementation
// ---------------------------------------------------------------------------

// Spec: AIT-CT1
class DefaultClientSession<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> implements ClientSession<TInput, TOutput, TProjection, TMessage> {
  private readonly _channel: Ably.RealtimeChannel;
  private readonly _codec: ClientSessionOptions<TInput, TOutput, TProjection, TMessage>['codec'];
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

  // Sub-components
  private readonly _tree: DefaultTree<TInput | TOutput, TProjection>;
  private readonly _view: DefaultView<TInput, TOutput, TProjection, TMessage>;
  private readonly _views = new Set<DefaultView<TInput, TOutput, TProjection, TMessage>>();
  private readonly _router: StreamRouter<TOutput>;
  private readonly _decoder: Decoder<TInput, TOutput>;
  /**
   * Shared encoder for the lifetime of the session. The client only ever
   * uses `publishInput` (input wire), so the encoder's stream tracker map
   * stays empty across the session. Closed once on session close.
   */
  private readonly _encoder: Encoder<TInput, TOutput>;

  // Spec: AIT-CT10, AIT-CT10a
  readonly tree: Tree<TProjection>;
  readonly view: View<TInput, TOutput, TProjection, TMessage>;

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

  constructor(options: ClientSessionOptions<TInput, TOutput, TProjection, TMessage>) {
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
    this._tree = createTree<TInput | TOutput, TProjection>(this._codec, this._logger);
    this._view = createView<TInput, TOutput, TProjection, TMessage>({
      tree: this._tree,
      channel: this._channel,
      codec: this._codec,
      sendDelegate: this._internalSend.bind(this),
      logger: this._logger,
      onClose: () => this._views.delete(this._view),
    });
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- isTerminal is the temporary bridge for terminal detection until LifecycleEvents land
    this._router = createStreamRouter<TOutput>(this._codec.isTerminal.bind(this._codec), this._logger);
    this._decoder = this._codec.createDecoder();
    this._encoder = this._codec.createEncoder(
      this._channel,
      this._clientId === undefined ? undefined : { clientId: this._clientId },
    );

    this._views.add(this._view);

    // Public accessors (typed as narrow interfaces)
    this.tree = this._tree;
    this.view = this._view;

    // Seed tree with initial messages — session assigns its own runId / codecMessageId
    // per seed message. Each seed message becomes a single-message Run; the
    // parent chain mirrors the original seed sequence.
    if (options.messages) {
      let prevMsgId: string | undefined;
      for (const msg of options.messages) {
        const seedRunId = crypto.randomUUID();
        const codecMessageId = crypto.randomUUID();
        const seedHeaders: Record<string, string> = {
          [HEADER_RUN_ID]: seedRunId,
          [HEADER_CODEC_MESSAGE_ID]: codecMessageId,
          [HEADER_ROLE]: 'user',
        };
        if (prevMsgId) seedHeaders[HEADER_PARENT] = prevMsgId;
        // CAST: UserMessage<TMessage> is the well-known input variant
        // produced by `codec.createUserMessage`; TInput is the codec's full
        // input union, of which UserMessage<TMessage> is one member.
        // TypeScript can't see the membership through the generic boundary.
        this._tree.applyMessage([this._codec.createUserMessage(msg) as unknown as TInput], seedHeaders);
        prevMsgId = codecMessageId;
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
          const parentRaw = headers[HEADER_PARENT];
          const forkOf = headers[HEADER_FORK_OF];
          const regenerates = headers[HEADER_MSG_REGENERATE];
          const isContinuation = headers[HEADER_RUN_CONTINUE] === 'true';
          this._tree.applyRunLifecycle(
            {
              type: EVENT_RUN_START,
              runId,
              clientId: runCid,
              invocationId: invocationId ?? '',
              ...(parentRaw !== undefined && { parent: parentRaw }),
              ...(forkOf !== undefined && { forkOf }),
              ...(regenerates !== undefined && { regenerates }),
              ...(isContinuation && { isContinuation: true }),
            },
            ablyMessage.serial,
          );
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
          // Resolution order:
          // 1. `_ownRunIds`: own runs always have the latest invocation
          //    here — set on every send (including continuations) and
          //    only cleared by a complete/error run-end. Survives
          //    `route()` closing the router stream on a `finish` chunk
          //    or consumer cancellation, which both wipe `routerActive`
          //    while the continuation's run-end is still in flight.
          // 2. `routerActive`: the bound stream's invocation. Useful for
          //    own runs whose `_ownRunIds` entry has already been
          //    cleared (e.g. an earlier complete run-end already ran).
          // 3. `latestContinuation`: the most recent continuation
          //    run-start's invocation. Observer clients have no
          //    `_ownRunIds` / `routerActive` entry, and `treeWinner`
          //    stays pinned to the original invocation (continuations
          //    don't advance it). Without this fallback, every
          //    continuation's `run-end` would be dropped on observer
          //    sessions, leaving status badges stuck on "streaming".
          // 4. `treeWinner`: serial-derived winner for observer-run gating
          //    of the ORIGINAL prompt's invocation. Only consulted when
          //    no continuation has been observed; catches losing-
          //    invocation echoes from competing agents publishing under
          //    the same runId.
          //
          // A run-end whose invocation matches none of these is dropped.
          const ownActive = this._ownRunIds.get(runId);
          const routerActive = this._router.getActiveInvocation(runId);
          const latestContinuation = this._tree.getLatestContinuationInvocation(runId);
          const treeWinner = this._tree.getWinningInvocation(runId)?.invocationId;
          const expectedInvocation = ownActive ?? routerActive ?? latestContinuation ?? treeWinner;
          if (invocationId !== undefined && expectedInvocation !== undefined && expectedInvocation !== invocationId) {
            this._logger.debug('ClientSession.runEnd; ignoring losing-invocation run-end', {
              runId,
              invocationId,
              ownActive,
              routerActive,
              latestContinuation,
              treeWinner,
            });
            this._tree.emitAblyMessage(ablyMessage);
            return;
          }
          // `suspended` keeps the run live so a continuation that reuses
          // the runId picks up where it left off. Router stream survives.
          // The `run` event still fires so listeners can react to the
          // suspend.
          if (reason !== 'suspended') {
            this._router.closeStream(runId);
            const codecMessageIds = this._runCodecMessageIds.get(runId);
            if (codecMessageIds) {
              for (const mid of codecMessageIds) this._ownCodecMessageIds.delete(mid);
              this._runCodecMessageIds.delete(runId);
            }
            this._ownRunIds.delete(runId);
          }
          this._tree.applyRunLifecycle({ type: EVENT_RUN_END, runId, clientId: runCid, reason }, ablyMessage.serial);
        }
        this._tree.emitAblyMessage(ablyMessage);
        return;
      }

      // --- Codec-decoded events ---
      const { inputs, outputs } = this._decoder.decode(ablyMessage);
      const events: (TInput | TOutput)[] = [...inputs, ...outputs];
      const headers = getHeaders(ablyMessage);
      const serial = ablyMessage.serial;
      const runId = headers[HEADER_RUN_ID];
      const invocationId = headers[HEADER_INVOCATION_ID];

      // Fold into the Tree's per-Run projection. The Tree handles
      // winning-invocation filtering and `x-ably-run-continue` carve-out.
      // This must run BEFORE router routing so the active stream's listeners
      // see the projection updates when they consume the routed events.
      if (events.length > 0 || runId) {
        this._tree.applyMessage(events, headers, serial);
      }

      // Route outputs to the active stream (if any). The router drops
      // events from a losing invocation under the same runId. Only TOutput
      // events flow on the consumer's `ActiveRun.stream`; client-published
      // inputs (echoed back on `ai-input`) are folded into the projection
      // but not routed to the stream.
      if (runId) {
        for (const output of outputs) {
          this._router.route(runId, invocationId, output);
        }
      }

      // Emit ably-message AFTER applyMessage so View subscribers can find
      // the owning Run in `_lastVisibleRunIdSet`, which is refreshed by the
      // tree 'update' events that applyMessage triggers.
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

    // As with cancellation, do not clear _ownRunIds here — late events
    // must still accumulate into the tree. The run-end handler cleans up
    // local maps.
    //
    // Only own-runs get an errored stream because only own-runs have a
    // ReadableStream<TEvent> the caller is consuming. Observer-run state
    // lives entirely in the Tree's projection and remains consistent
    // regardless of channel continuity loss; nothing on this client is
    // waiting on it.
    for (const runId of this._ownRunIds.keys()) {
      this._router.errorStream(runId, err);
    }

    this._emitter.emit('error', err);
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
      for (const codecMessageId of codecMessageIds) {
        this._ownCodecMessageIds.delete(codecMessageId);
      }
    }
    if (options.removeOptimistic) {
      // Drop the optimistic Run only if the publish never produced a
      // server-assigned serial (i.e. nothing live observed the Run). A
      // server-acked Run is part of the canonical channel state and must
      // stay; the View / observers already see it.
      const run = this._tree.getRunNode(runId);
      if (run && run.startSerial === undefined) {
        this._tree.delete(runId);
      }
    }
    this._ownRunIds.delete(runId);
    this._runCodecMessageIds.delete(runId);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  // Spec: AIT-CT10b
  createView(): View<TInput, TOutput, TProjection, TMessage> {
    if (this._state === ClientSessionState.CLOSED) {
      throw new Ably.ErrorInfo('unable to create view; session is closed', ErrorCode.SessionClosed, 400);
    }
    this._logger.trace('DefaultClientSession.createView();');
    const view = createView<TInput, TOutput, TProjection, TMessage>({
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
    input: TInput[],
    sendOptions: SendOptions | undefined,
    parentCodecMessageId: string | undefined,
  ): Promise<ActiveRun<TOutput>> {
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

    const isContinuation = sendOptions?.runId !== undefined;

    // Every send must carry at least one input. The only exception is a
    // continuation rebind under an existing runId that carries no new
    // inputs (rare, but allowed — the agent's existing prompts are
    // already on the channel).
    if (input.length === 0 && !isContinuation) {
      throw new Ably.ErrorInfo(
        'unable to send; inputs array is empty (pass options.runId for continuation, or include at least one input)',
        ErrorCode.InvalidArgument,
        400,
      );
    }

    const runId = sendOptions?.runId ?? crypto.randomUUID();
    const invocationId = crypto.randomUUID();
    this._ownRunIds.set(runId, invocationId);

    // Spec: AIT-CT3d
    // Auto-compute parent from the visible branch tail when not explicitly
    // provided. The View pre-resolves the codec-message-id of the last visible message
    // since the session is codec-agnostic and can't extract it from TMessage.
    let autoParent: string | undefined;
    if (sendOptions?.parent === undefined && !sendOptions?.forkOf) {
      autoParent = parentCodecMessageId;
    }

    const codecMessageIds = new Set<string>();
    interface ItemState {
      input: TInput;
      codecMessageId: string;
      headers: Record<string, string>;
      /** Inputs that target an existing codec-message (e.g. tool result) are wire-only — no optimistic projection fold. */
      isWireOnly: boolean;
    }
    const items: ItemState[] = [];

    // Per-input wire prep: read routing fields off the input directly, then
    // mint per-event ids and build transport headers. Regenerate inputs are
    // wire-only (no optimistic fold); other inputs fold into the projection
    // optimistically.
    for (const entry of input) {
      const eventId = crypto.randomUUID();
      // Use the input's `codecMessageId` when set (e.g. tool resolution
      // targeting the prior assistant); otherwise mint a fresh id.
      const codecMessageId = entry.codecMessageId ?? crypto.randomUUID();
      this._ownCodecMessageIds.add(codecMessageId);
      codecMessageIds.add(codecMessageId);

      // Inputs that reference an existing message (regenerate, tool
      // resolutions targeting an assistant) are wire-only — no optimistic
      // fold needed because either the receiving content doesn't
      // materialise on this side (regenerate) or the target already exists
      // and will be amended when the wire echoes back.
      const isWireOnly = entry.kind === 'regenerate' || entry.codecMessageId !== undefined;

      // The input's own routing fields override the auto-parent /
      // sendOptions defaults. For regenerate inputs, `target` becomes the
      // `x-ably-msg-regenerate` wire header; for edit inputs, it becomes
      // `x-ably-fork-of`. The transport reads them directly off the input
      // without runtime classification.
      const parent = entry.parent ?? (sendOptions?.parent === undefined ? autoParent : sendOptions.parent);
      const forkOf = entry.kind === 'edit' ? entry.target : sendOptions?.forkOf;
      const regenerates = entry.kind === 'regenerate' ? entry.target : undefined;

      const headers = buildTransportHeaders({
        role: 'user',
        runId,
        codecMessageId,
        runClientId: this._clientId,
        ...(parent !== undefined && { parent }),
        ...(forkOf !== undefined && { forkOf }),
        ...(regenerates !== undefined && { regenerates }),
        invocationId,
        eventId,
        runContinue: isContinuation,
      });

      // Spec: AIT-CT3c — optimistic fold for non-wire-only inputs.
      if (!isWireOnly) {
        this._tree.applyMessage([entry], headers);
      }

      items.push({ input: entry, codecMessageId, headers, isWireOnly });

      // Spec: AIT-CT3e — chain subsequent inputs off the previous one when
      // auto-parenting is in effect.
      if (!isWireOnly && sendOptions?.parent === undefined && !sendOptions?.forkOf && entry.parent === undefined) {
        autoParent = codecMessageId;
      }
    }

    this._runCodecMessageIds.set(runId, codecMessageIds);

    // The primary trigger event is the last input — the one the agent looks
    // up on the channel via `x-ably-event-id` and forwards in the POST body.
    const triggerEventId = items.at(-1)?.headers[HEADER_EVENT_ID] ?? '';

    // Stream setup. Fresh send opens a new stream; continuation rebinds the
    // existing one. If the suspended stream was torn down (e.g. cancel /
    // continuity loss), fall back to creating a fresh stream so the
    // continuation still completes — observers will see the events even if
    // the originally-returned readable was already drained.
    let stream: ReadableStream<TOutput>;
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

    // Publish each input in original order via the shared encoder. The
    // codec routes user-message inputs into a per-part discrete batch and
    // tool-resolution / regenerate inputs into a single discrete write —
    // all on the `ai-input` wire.
    const publishPromise = (async () => {
      try {
        for (const item of items) {
          await this._encoder.publishInput(item.input, {
            extras: { headers: item.headers },
            messageId: item.codecMessageId,
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

    // Minimal pointer body: the agent locates the triggering input event on the
    // channel via eventId and reads conversation history via loadProjection().
    const postBody: Record<string, unknown> = {
      ...resolvedBody,
      ...sendOptions?.body,
      runId,
      invocationId,
      eventId: triggerEventId,
      sessionName: this._channel.name,
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
      eventId: triggerEventId,
      invocationId,
      cancel: async () => this.cancel(runId),
      optimisticCodecMessageIds: [...codecMessageIds],
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

    // Close the local router stream so the caller's reader sees end-of-input.
    // Don't tear down the Tree's RunNode or this session's `_ownRunIds` /
    // `_runCodecMessageIds` entries here — late agent events (e.g. a cancel
    // append, a trailing `x-ably-status: cancelled`) arriving before run-end
    // must still fold into the Run's projection. The run-end handler is the
    // canonical cleanup point.
    this._router.closeStream(runId);
  }

  // Spec: AIT-CT8, AIT-CT8c, AIT-CT8d
  on(event: 'error', handler: (error: Ably.ErrorInfo) => void): () => void {
    if (this._state === ClientSessionState.CLOSED) return noopUnsubscribe;
    // CAST: the overload signature enforces the correct handler type.
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

    this._emitter.off();
    for (const v of this._views) v.close();
    this._views.clear();
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
 * or `cancel`.
 * @param options - Configuration for the client session.
 * @returns A new {@link ClientSession} instance.
 */
export const createClientSession = <
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
>(
  options: ClientSessionOptions<TInput, TOutput, TProjection, TMessage>,
): ClientSession<TInput, TOutput, TProjection, TMessage> => new DefaultClientSession(options);
