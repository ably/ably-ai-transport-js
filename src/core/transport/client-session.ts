/**
 * Core client-side session, parameterized by codec.
 *
 * Composes the conversation Tree to handle the full client-side lifecycle.
 * `connect()` subscribes to the Ably channel (which implicitly attaches it).
 * The same subscription, decoder, and channel are reused across runs.
 *
 * The client publishes user messages directly to the channel via the shared
 * codec encoder. It does not send HTTP: waking an agent is the application's
 * concern — it POSTs `run.toInvocation().toJSON()` to its own endpoint if and
 * when it wants one woken (the Vercel ChatTransport does this for useChat
 * parity). The agent correlates the input event by the `invocation-id` header
 * and publishes run lifecycle events (run-start, run-end) plus assistant
 * chunks. The channel is the durable session record; agents that weren't
 * running at publish time can resume by reading channel rewind.
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
  HEADER_INPUT_CODEC_MESSAGE_ID,
  HEADER_INVOCATION_ID,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_RUN_ID,
  HEADER_RUN_REASON,
} from '../../constants.js';
import { ErrorCode } from '../../errors.js';
import { EventEmitter } from '../../event-emitter.js';
import type { Logger } from '../../logger.js';
import { LogLevel, makeLogger } from '../../logger.js';
import { getTransportHeaders } from '../../utils.js';
import { registerAgent } from '../agent.js';
import type { CodecInputEvent, CodecOutputEvent, Decoder, Encoder } from '../codec/types.js';
import { buildTransportHeaders, parseRunLifecycle } from './headers.js';
import { Invocation } from './invocation.js';
import type { DefaultTree } from './tree.js';
import { createTree } from './tree.js';
import type {
  ActiveRun,
  ClientSession,
  ClientSessionOptions,
  RunEndReason,
  RunStarted,
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
  private readonly _logger: Logger;

  // Typed event emitter — only 'error' remains on the session
  private readonly _emitter: EventEmitter<ClientSessionEventsMap>;

  // Sub-components
  private readonly _tree: DefaultTree<TInput, TOutput, TProjection>;
  private readonly _view: DefaultView<TInput, TOutput, TProjection, TMessage>;
  private readonly _views = new Set<DefaultView<TInput, TOutput, TProjection, TMessage>>();
  private readonly _decoder: Decoder<TInput, TOutput>;
  /**
   * Shared encoder for the lifetime of the session. The client only ever
   * uses `publishInput` (input wire), so the encoder's stream tracker map
   * stays empty across the session. Closed once on session close.
   */
  private readonly _encoder: Encoder<TInput, TOutput>;

  // Spec: AIT-CT10, AIT-CT10a
  readonly tree: Tree<TOutput, TProjection>;
  readonly view: View<TInput, TMessage>;

  // Channel subscription is established lazily on connect()
  private _connectPromise: Promise<void> | undefined;
  private readonly _onMessage: (msg: Ably.InboundMessage) => void;

  private _state = ClientSessionState.READY;
  private _hasAttachedOnce: boolean;
  private readonly _onChannelStateChange: Ably.channelEventCallback;

  /**
   * Backing settlers for each in-flight run's `ActiveRun.started` promise.
   * Resolved when the matching `ai-run-start` is observed; rejected if the
   * session closes first. There is no deadline — `send()` no longer blocks on
   * run-start.
   *
   * Keyed by the triggering input's codec-message-id — the handle the client
   * owns at send time, which the agent echoes back on run-start as
   * `input-codec-message-id`. This is uniform across fresh sends and
   * continuations (a continuation is itself an input event — tool-approval or
   * tool-result — with its own codec-message-id), so reconciliation never
   * depends on a client-minted run/invocation id. The sole exception is an
   * empty-input continuation, which publishes no input and so keys by the
   * reused `runId` instead.
   */
  private readonly _pendingRunStarts = new Map<
    string,
    { resolve: (started: RunStarted) => void; reject: (e: Ably.ErrorInfo) => void }
  >();

  constructor(options: ClientSessionOptions<TInput, TOutput, TProjection, TMessage>) {
    // Spec: AIT-CT1a, AIT-CT1a2 — register this SDK on both the connection
    // (options.agents) and channel-attach (params.agent) paths. Idempotent
    // across sessions sharing one client.
    const channelOptions = registerAgent(options.client);
    this._channel = options.client.channels.get(options.channelName, channelOptions);
    this._codec = options.codec;
    this._clientId = options.clientId;
    this._logger = (options.logger ?? makeLogger({ logLevel: LogLevel.Silent })).withContext({
      component: 'ClientSession',
    });

    this._emitter = new EventEmitter<ClientSessionEventsMap>(this._logger);
    this._hasAttachedOnce = this._channel.state === 'attached';

    // Compose sub-components
    this._tree = createTree<TInput, TOutput, TProjection>(this._codec, this._logger);
    this._view = createView<TInput, TOutput, TProjection, TMessage>({
      tree: this._tree,
      channel: this._channel,
      codec: this._codec,
      sendDelegate: this._internalSend.bind(this),
      logger: this._logger,
      onClose: () => this._views.delete(this._view),
    });
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
        this._tree.applyMessage(
          { inputs: [this._codec.createUserMessage(msg) as unknown as TInput], outputs: [] },
          seedHeaders,
        );
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
        const headers = getTransportHeaders(ablyMessage);
        const event = parseRunLifecycle(EVENT_RUN_START, headers, ablyMessage.serial);
        if (event) {
          this._tree.applyRunLifecycle(event);
          // Resolve the pending `started` for this run-start. Every send that
          // carries an input event — fresh OR continuation (a continuation is
          // itself an input event, e.g. a tool-approval or tool-result, with
          // its own codec-message-id) — armed the tracker by that triggering
          // input's codec-message-id, which the agent echoes here as
          // `input-codec-message-id`. The only input-less send is an
          // empty-input continuation, whose run-start carries no
          // `input-codec-message-id`; it falls back to the reused runId
          // (always present in this block). invocation-id is not a match key.
          const startedKey = headers[HEADER_INPUT_CODEC_MESSAGE_ID] ?? event.runId;
          const pending = this._pendingRunStarts.get(startedKey);
          if (pending) {
            this._pendingRunStarts.delete(startedKey);
            // Hand the caller the agent-minted identity it could not know at
            // send time: the runId carried on run-start and the invocation-id
            // echoed alongside it.
            pending.resolve({ runId: event.runId, invocationId: headers[HEADER_INVOCATION_ID] ?? '' });
          }
        }
        this._tree.emitAblyMessage(ablyMessage);
        return;
      }

      if (ablyMessage.name === EVENT_RUN_END) {
        const headers = getTransportHeaders(ablyMessage);
        const runId = headers[HEADER_RUN_ID];
        const invocationId = headers[HEADER_INVOCATION_ID];
        // CAST: agent always writes a valid RunEndReason; default to 'complete' for robustness
        const reason = (headers[HEADER_RUN_REASON] ?? 'complete') as RunEndReason;

        // When reason is 'error' the agent surfaces a mid-run failure
        // via the error-code / error-message headers.
        // Reify the error and emit the session error event. Consumers that
        // expose a per-run stream (e.g. the Vercel ChatTransport) error their
        // stream off this event. The agent only publishes `run-end` after it
        // has published `run-start`, so no pending-run-start tracker is
        // outstanding at this point.
        if (reason === 'error') {
          const codeRaw = headers[HEADER_ERROR_CODE];
          const parsedCode = codeRaw === undefined ? Number.NaN : Number(codeRaw);
          const code = Number.isFinite(parsedCode) ? parsedCode : ErrorCode.SessionSubscriptionError;
          const message = headers[HEADER_ERROR_MESSAGE] ?? 'agent reported an error';
          const statusCode = code >= 10000 && code < 60000 ? Math.floor(code / 100) : 500;
          const errInfo = new Ably.ErrorInfo(message, code, statusCode);
          this._logger.error('ClientSession._handleMessage(); agent error received', {
            runId,
            invocationId,
            code,
          });
          this._emitter.emit('error', errInfo);
        }

        if (runId) {
          // Every run-end is applied unconditionally. Concurrent work always
          // runs under distinct run-ids, and a resume/continuation is
          // sequential (the prior invocation's run-end is seen before the
          // next invocation starts), so there is never a competing run-end
          // for the same run-id that we'd need to disambiguate by invocation.
          //
          // `suspended` keeps the run live in the Tree so a continuation that
          // reuses the runId picks up where it left off. The `run` event fires
          // either way so consumers can react to the suspend or end.
          const event = parseRunLifecycle(EVENT_RUN_END, headers, ablyMessage.serial);
          if (event) this._tree.applyRunLifecycle(event);
        }
        this._tree.emitAblyMessage(ablyMessage);
        return;
      }

      // --- Codec-decoded events ---
      const { inputs, outputs } = this._decoder.decode(ablyMessage);
      const headers = getTransportHeaders(ablyMessage);
      const serial = ablyMessage.serial;
      const runId = headers[HEADER_RUN_ID];

      // Fold into the Tree's per-Run projection. The Tree's `output` event
      // (emitted after the fold) carries these outputs to any consumer that
      // builds a stream from them (e.g. the Vercel ChatTransport); the session
      // no longer routes outputs itself.
      if (inputs.length > 0 || outputs.length > 0 || runId) {
        this._tree.applyMessage({ inputs, outputs }, headers, serial);
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

    // Surface the loss via the session `error` event. Consumers that expose a
    // per-run stream (e.g. the Vercel ChatTransport) error their stream off
    // this event; observer-run state lives entirely in the Tree's projection
    // and stays consistent regardless of continuity loss.
    this._emitter.emit('error', err);
  }

  // ---------------------------------------------------------------------------
  // Cancel helpers
  // ---------------------------------------------------------------------------

  /**
   * Tear down local state for a fresh send whose channel publish failed.
   * Idempotent.
   * @param optimisticKeys - The Tree keys of the provisional Runs the fresh
   *   send inserted optimistically (one per non-wire-only input, keyed by its
   *   codec-message-id). Empty for a continuation, which folds into an existing
   *   Run and inserts none.
   */
  private _cleanupFailedSend(optimisticKeys: readonly string[]): void {
    for (const key of optimisticKeys) {
      // Drop the optimistic Run only if the publish never produced a
      // server-assigned serial (i.e. nothing live observed the Run). A
      // server-acked Run is part of the canonical channel state and must
      // stay; the View / observers already see it.
      const run = this._tree.getRunNode(key);
      if (run && run.startSerial === undefined) {
        this._tree.delete(key);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  // Spec: AIT-CT10b
  createView(): View<TInput, TMessage> {
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
  ): Promise<ActiveRun> {
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
    // continuation under an existing runId that carries no new inputs
    // (rare, but allowed — the run's existing input events are already on
    // the channel).
    if (input.length === 0 && !isContinuation) {
      throw new Ably.ErrorInfo(
        'unable to send; inputs array is empty (pass options.runId for continuation, or include at least one input)',
        ErrorCode.InvalidArgument,
        400,
      );
    }

    // The client no longer mints a runId for a fresh run — the agent assigns it
    // and the client adopts it from run-start. `runId` is defined only for a
    // continuation (the reused id the caller passed). A fresh send carries no
    // run-id on the wire, so the Tree forms a provisional Run keyed by the
    // triggering input's codec-message-id.
    const runId = sendOptions?.runId;

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
      /** Inputs that reference an existing codec-message without contributing fresh local content (regenerate, tool resolutions) are wire-only — no optimistic projection fold. Fresh user-messages always fold, even when they pin their own codecMessageId. */
      isWireOnly: boolean;
    }
    const items: ItemState[] = [];

    // Per-input wire prep: read routing fields off the input directly, then
    // mint per-event ids and build transport headers. Regenerate inputs are
    // wire-only (no optimistic fold); other inputs fold into the projection
    // optimistically.
    for (const entry of input) {
      const inputEventId = crypto.randomUUID();
      // Use the input's `codecMessageId` when set (e.g. tool resolution
      // targeting the prior assistant); otherwise mint a fresh id.
      const codecMessageId = entry.codecMessageId ?? crypto.randomUUID();
      codecMessageIds.add(codecMessageId);

      // Inputs that reference an existing message (regenerate, tool
      // resolutions targeting an assistant) are wire-only — no optimistic
      // fold needed because either the receiving content doesn't
      // materialise on this side (regenerate) or the target already exists
      // and will be amended when the wire echoes back.
      //
      // A fresh `user-message` is never wire-only, even when it carries a
      // `codecMessageId`: View.sendMessage threads a caller-supplied
      // TMessage.id through that field so TMessage.id == the wire
      // codec-message-id, but the message is still new content that must
      // fold into the local projection immediately. Excluding it here keeps
      // the optimistic user bubble from depending on the channel round-trip.
      const isWireOnly =
        entry.kind !== 'user-message' && (entry.kind === 'regenerate' || entry.codecMessageId !== undefined);

      // The input's own routing fields override the auto-parent /
      // sendOptions defaults. For regenerate inputs, `target` becomes the
      // `msg-regenerate` wire header; for edit inputs, it becomes
      // `fork-of`. The transport reads them directly off the input
      // without runtime classification.
      const parent = entry.parent ?? (sendOptions?.parent === undefined ? autoParent : sendOptions.parent);
      const forkOf = entry.kind === 'edit' ? entry.target : sendOptions?.forkOf;
      const regenerates = entry.kind === 'regenerate' ? entry.target : undefined;

      const headers = buildTransportHeaders({
        role: 'user',
        // Omitted for a fresh send (agent-minted runId); the reused id for a
        // continuation. No invocation-id is stamped on the wire any more.
        ...(runId !== undefined && { runId }),
        codecMessageId,
        runClientId: this._clientId,
        ...(parent !== undefined && { parent }),
        ...(forkOf !== undefined && { forkOf }),
        ...(regenerates !== undefined && { regenerates }),
        inputEventId,
        runContinue: isContinuation,
      });

      // Spec: AIT-CT3c — optimistic fold for non-wire-only inputs.
      if (!isWireOnly) {
        this._tree.applyMessage({ inputs: [entry], outputs: [] }, headers);
      }

      items.push({ input: entry, codecMessageId, headers, isWireOnly });

      // Spec: AIT-CT3e — chain subsequent inputs off the previous one when
      // auto-parenting is in effect.
      if (!isWireOnly && sendOptions?.parent === undefined && !sendOptions?.forkOf && entry.parent === undefined) {
        autoParent = codecMessageId;
      }
    }

    // The primary trigger event is the last input — the one the agent looks
    // up on the channel via `event-id`. It is surfaced on `ActiveRun` (and via
    // `toInvocation()`) so the application can point an invocation at it.
    const triggerInputEventId = items.at(-1)?.headers[HEADER_EVENT_ID] ?? '';
    // The triggering input's codec-message-id — the handle a fresh send uses
    // to correlate its `started` promise against the agent's run-start (which
    // echoes it as `input-codec-message-id`). Always defined for a fresh send
    // (which carries at least one input); undefined only for an empty-input
    // continuation, which keys by runId instead.
    const triggerCodecMessageId = items.at(-1)?.codecMessageId;

    // Arm the run-start tracker. It backs the returned `ActiveRun.started`
    // promise: the run-start handler resolves it when the agent's
    // `ai-run-start` for this send is observed; close() rejects it if the
    // session is torn down first. There is no deadline — `send()` resolves on
    // publish, and callers who want to bound the run-start wait race
    // `started` against their own timeout.
    //
    // Key by the handle the client owns at send time: the triggering input's
    // codec-message-id, which the agent echoes back on run-start as
    // `input-codec-message-id`. This is uniform across fresh sends and
    // continuations — a continuation is itself an input event (tool-approval
    // or tool-result) carrying its own codec-message-id. The sole exception
    // is an empty-input continuation, which publishes nothing: it falls back
    // to the reused runId (known to the caller) and resolves on the
    // continuation run-start, which carries no `input-codec-message-id`.
    //
    // Any send carrying input has `triggerCodecMessageId` defined, so the
    // `?? runId` fallback engages only for that empty-input continuation. The
    // arm key (here) and the resolve key (the run-start handler) stay
    // symmetric because the agent stamps `input-codec-message-id` on run-start
    // exactly when it consumed the input from the channel — i.e. whenever it
    // ran its input-event lookup, which is every path that has a remote client
    // awaiting `started`. The no-lookup agent config
    // (`inputEventLookupTimeoutMs: 0`, for in-process drivers) does not
    // consume channel input and so has no remote `started` to satisfy.
    // The executor runs synchronously, so the tracker entry is registered
    // before `new Promise` returns.
    const startedKey = triggerCodecMessageId ?? runId;
    if (startedKey === undefined) {
      // Invariant: a fresh send carries ≥1 input (validated above) so
      // `triggerCodecMessageId` is defined, and an empty-input continuation has
      // a `runId`. This guards the type and an impossible misuse.
      throw new Ably.ErrorInfo(
        'unable to send; no correlation handle (empty fresh send)',
        ErrorCode.InvalidArgument,
        400,
      );
    }
    const started = new Promise<RunStarted>((resolve, reject) => {
      this._pendingRunStarts.set(startedKey, { resolve, reject });
    });
    // Suppress unhandled-rejection warnings for callers that never await
    // `started`; the caller still observes the rejection if it does await.
    started.catch(() => {
      /* observed via run.started, if at all */
    });

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
        // The input never reached the channel — there is no run to wait on.
        // Drop the started tracker so close() doesn't later reject an orphan.
        this._pendingRunStarts.delete(startedKey);
        // Clear the optimistic provisional Runs this fresh send inserted (one
        // per non-wire-only input, each keyed by its codec-message-id). A
        // continuation folds into an existing Run and inserts none, so its
        // optimistic-key list is empty.
        const optimisticKeys = isContinuation ? [] : items.filter((i) => !i.isWireOnly).map((i) => i.codecMessageId);
        this._cleanupFailedSend(optimisticKeys);
        throw err;
      }
    })();

    // `send()` resolves once the input is published. The core never sends
    // HTTP — waking an agent is the application's concern. Callers POST
    // `run.toInvocation().toJSON()` to their endpoint if they want one woken,
    // and await `run.started` if they need to know it was picked up.
    await publishPromise;

    // The run's stable Tree key. A continuation reuses an existing run, so its
    // key is that run's key (which differs from the reused runId when the run
    // was an adopted provisional one). A fresh send carries no run-id, so the
    // Tree keyed its provisional Run by the triggering input's codec-message-id
    // (= startedKey); the agent's runId is adopted onto it from run-start.
    const runKey = runId === undefined ? startedKey : (this._tree.getRunNode(runId)?.key ?? runId);

    // Cancel handling. The client owns a run's id at send time only for a
    // continuation (the reused runId in `sendOptions`); a fresh run's id is
    // agent-minted and not known until run-start is adopted. So `cancel()`
    // publishes immediately when the id is already known, and otherwise defers
    // until run-start resolves `started`. If the session closes before
    // run-start (started rejects), there is no run to cancel.
    let knownRunId: string | undefined = sendOptions?.runId;
    let cancelRequested = false;
    // Fire-and-forget: arm the deferred cancel. A rejection means the session
    // closed before run-start, so there is nothing to cancel.
    void started.then(
      (s) => {
        knownRunId = s.runId;
        if (cancelRequested) void this.cancel(s.runId);
      },
      () => {
        /* session closed before run-start — no run to cancel */
      },
    );
    const cancel = async (): Promise<void> => {
      if (knownRunId !== undefined) {
        await this.cancel(knownRunId);
        return;
      }
      // runId not yet known — defer until run-start adoption resolves `started`.
      cancelRequested = true;
    };

    return {
      started,
      key: runKey,
      inputEventId: triggerInputEventId,
      cancel,
      optimisticCodecMessageIds: [...codecMessageIds],
      // The POST body carries only client-owned identifiers: the trigger
      // event id, the session name, and runId only for a continuation. The
      // agent's POST handler mints the invocation id (and, for a fresh run,
      // the run id).
      toInvocation: () =>
        Invocation.fromJSON({
          ...(runId !== undefined && { runId }),
          inputEventId: triggerInputEventId,
          sessionName: this._channel.name,
        }),
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
      extras: { ai: { transport: { [HEADER_RUN_ID]: runId } } },
    });

    // Publishing the cancel signal is all the core does. The consumer-facing
    // stream (if any) lives in the layer that built it — e.g. the Vercel
    // ChatTransport closes its stream on cancel — and the Tree's RunNode is
    // left intact so late agent events (a cancel append, a trailing
    // `status: cancelled`) still fold into the Run's projection.
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

    this._emitter.off();
    for (const v of this._views) v.close();
    this._views.clear();
    // Reject any in-flight `started` promises so callers awaiting run-start
    // settle rather than hang.
    if (this._pendingRunStarts.size > 0) {
      const closedErr = new Ably.ErrorInfo('unable to await run-start; session closed', ErrorCode.SessionClosed, 400);
      for (const pending of this._pendingRunStarts.values()) {
        pending.reject(closedErr);
      }
      this._pendingRunStarts.clear();
    }

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
