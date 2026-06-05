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
 * parity). The agent locates the triggering input event by its `event-id`
 * header and publishes run lifecycle events (run-start, run-end) plus assistant
 * chunks, minting and stamping the invocation-id itself. The channel is the
 * durable session record; agents that weren't running at publish time can
 * resume by reading channel rewind.
 */

import * as Ably from 'ably';

import {
  EVENT_CANCEL,
  EVENT_RUN_END,
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
import { applyWireMessage } from './decode-fold.js';
import { buildTransportHeaders } from './headers.js';
import { Invocation } from './invocation.js';
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
   * Backing settlers for each in-flight run's `ActiveRun.runId` promise.
   * Resolved with the agent-minted run-id when the matching `ai-run-start` is
   * observed; rejected if the session closes first. There is no deadline —
   * `send()` no longer blocks on run-start.
   *
   * Keyed by the triggering input's codec-message-id — the handle the client
   * owns at send time, which the agent echoes back on run-start as
   * `input-codec-message-id`. This is uniform across fresh sends and
   * continuations (a continuation is itself an input event — tool-approval or
   * tool-result — with its own codec-message-id), so reconciliation never
   * depends on a client-minted run/invocation id.
   */
  private readonly _pendingRunStarts = new Map<
    string,
    { resolve: (runId: string) => void; reject: (e: Ably.ErrorInfo) => void }
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

    // Seed tree with initial messages — the session assigns a codecMessageId
    // per seed message. Each seed becomes a run-less input node (no run-id —
    // the client never mints one); the parent chain mirrors the original seed
    // sequence (a user→user input chain the Tree threads kind-blind).
    if (options.messages) {
      let prevMsgId: string | undefined;
      for (const msg of options.messages) {
        const codecMessageId = crypto.randomUUID();
        const seedHeaders: Record<string, string> = {
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
      // Live-only: surface an agent error carried on a run-end BEFORE applying
      // it, preserving the original 'error'-before-tree-'run' emit ordering.
      // Consumers that expose a per-run stream (e.g. the Vercel ChatTransport)
      // error their stream off this event. The agent only publishes run-end
      // after run-start, so no pending-run-start tracker is outstanding.
      if (ablyMessage.name === EVENT_RUN_END) {
        const headers = getTransportHeaders(ablyMessage);
        // CAST: agent always writes a valid RunEndReason; default to 'complete' for robustness
        const reason = (headers[HEADER_RUN_REASON] ?? 'complete') as RunEndReason;
        if (reason === 'error') {
          const codeRaw = headers[HEADER_ERROR_CODE];
          const parsedCode = codeRaw === undefined ? Number.NaN : Number(codeRaw);
          const code = Number.isFinite(parsedCode) ? parsedCode : ErrorCode.SessionSubscriptionError;
          const message = headers[HEADER_ERROR_MESSAGE] ?? 'agent reported an error';
          const statusCode = code >= 10000 && code < 60000 ? Math.floor(code / 100) : 500;
          const errInfo = new Ably.ErrorInfo(message, code, statusCode);
          this._logger.error('ClientSession._handleMessage(); agent error received', {
            runId: headers[HEADER_RUN_ID],
            invocationId: headers[HEADER_INVOCATION_ID],
            code,
          });
          this._emitter.emit('error', errInfo);
        }
      }

      // Reconstruct the tree via the shared decode-fold engine — the same path
      // the View's history replay uses, so the live loop can't drift from it.
      const event = applyWireMessage(this._tree, this._decoder, ablyMessage);

      // Live-only: resolve the pending `runId` promise on a fresh run-start or
      // a continuation run-resume. Key by the echoed `input-codec-message-id`
      // — the mirror of the arming key on `_pendingRunStarts` (see that
      // field's JSDoc). Every send carries at least one input, so the agent
      // always echoes it.
      if (event && (event.type === 'start' || event.type === 'resume')) {
        const startedKey = getTransportHeaders(ablyMessage)[HEADER_INPUT_CODEC_MESSAGE_ID];
        if (startedKey !== undefined) {
          const pending = this._pendingRunStarts.get(startedKey);
          if (pending) {
            this._pendingRunStarts.delete(startedKey);
            // Resolve the run handle's `runId` promise with the agent-minted id.
            pending.resolve(event.runId);
          }
        }
      }

      // Emit ably-message AFTER the apply so View subscribers can find the
      // owning Run in `_lastVisibleRunIdSet`, which is refreshed by the tree
      // 'update' events the apply triggers.
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
   * Tear down local state for a send whose channel publish failed.
   * Idempotent.
   * @param codecMessageIds - The codec-message-ids of the failed send's
   *   optimistic input nodes (the client mints no run-id, so the optimistic
   *   inserts are keyed by their codec-message-ids).
   */
  private _cleanupFailedSend(codecMessageIds: string[]): void {
    for (const codecMessageId of codecMessageIds) {
      // Drop the optimistic input node only if the publish never produced a
      // server-assigned serial (i.e. nothing live observed it). A server-acked
      // node is part of the canonical channel state and must stay; the View /
      // observers already see it. A fresh send's optimistic inserts are input
      // nodes (keyed by codec-message-id).
      const node = this._tree.getNodeByCodecMessageId(codecMessageId);
      if (node?.kind === 'input' && node.serial === undefined) {
        this._tree.deleteByCodecMessageId(codecMessageId);
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

    // The client no longer mints run-ids. A fresh send carries no run-id (the
    // agent mints it and echoes it on run-start); only a continuation reuses
    // the existing run-id the caller passed.
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
      inputEventId: string;
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
        runId,
        codecMessageId,
        runClientId: this._clientId,
        ...(parent !== undefined && { parent }),
        ...(forkOf !== undefined && { forkOf }),
        ...(regenerates !== undefined && { regenerates }),
        inputEventId,
      });

      // Spec: AIT-CT3c — optimistic fold for non-wire-only inputs.
      if (!isWireOnly) {
        this._tree.applyMessage({ inputs: [entry], outputs: [] }, headers);
      }

      items.push({ input: entry, codecMessageId, inputEventId, headers, isWireOnly });

      // Spec: AIT-CT3e — chain subsequent inputs off the previous one when
      // auto-parenting is in effect.
      if (!isWireOnly && sendOptions?.parent === undefined && !sendOptions?.forkOf && entry.parent === undefined) {
        autoParent = codecMessageId;
      }
    }

    // The trigger event is the last input — the one the agent looks up on the
    // channel via `event-id`, surfaced on `ActiveRun` (and via `toInvocation()`)
    // so the application can point an invocation at it. Its codec-message-id is
    // the handle the client owns at send time; the agent echoes it back on
    // run-start as `input-codec-message-id`, and it keys the run-start tracker.
    const triggerItem = items.at(-1);
    if (triggerItem === undefined) {
      // Every send must carry at least one input — only new input starts or
      // continues a run. The loop above produced no items, so nothing was
      // published or folded optimistically.
      throw new Ably.ErrorInfo(
        'unable to send; inputs array is empty (include at least one input)',
        ErrorCode.InvalidArgument,
        400,
      );
    }
    const triggerInputEventId = triggerItem.inputEventId;
    const startedKey = triggerItem.codecMessageId;

    // Arm the run-start tracker backing the returned `ActiveRun.runId` promise.
    // The run-start handler resolves it with the agent-minted run-id when this
    // send's `ai-run-start` is observed; close() rejects it on teardown. No
    // deadline — `send()` resolves on publish; callers bound the wait by racing
    // `run.runId` against their own timeout.
    //
    // Key on the arming side mirrors the resolve side — see `_pendingRunStarts`
    // for the full keying invariant. The executor runs synchronously, so the
    // tracker entry is registered before `new Promise` returns.
    const runIdPromise = new Promise<string>((resolve, reject) => {
      this._pendingRunStarts.set(startedKey, { resolve, reject });
    });
    // Suppress unhandled-rejection warnings for callers that never await
    // `run.runId`; the caller still observes the rejection if it does await.
    runIdPromise.catch(() => {
      /* observed via run.runId, if at all */
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
        // Drop the run-start tracker so close() doesn't later reject an orphan.
        this._pendingRunStarts.delete(startedKey);
        // Continuations didn't insert optimistic nodes, so there is nothing to
        // clear for them — only a fresh send's optimistic input nodes need
        // removing, keyed by their codec-message-ids (the client mints no runId).
        if (!isContinuation) this._cleanupFailedSend([...codecMessageIds]);
        throw err;
      }
    })();

    // `send()` resolves once the input is published. The core never sends
    // HTTP — waking an agent is the application's concern. Callers POST
    // `run.toInvocation().toJSON()` to their endpoint if they want one woken,
    // and await `run.runId` if they need to know it was picked up.
    await publishPromise;

    return {
      key: startedKey,
      runId: runIdPromise,
      inputEventId: triggerInputEventId,
      // The agent mints the run-id, so a fresh run has none until run-start.
      // Cancel synchronously by the triggering input's codec-message-id (the
      // handle the client owns at send time, = `key`): the agent resolves it
      // to the run once its input-event lookup completes, and buffers a cancel
      // that arrives before then so an early cancel is honoured rather than
      // dropped. A continuation additionally carries its known run-id so the
      // agent can match the run directly.
      cancel: async () => {
        await this._publishCancel({
          inputCodecMessageId: startedKey,
          ...(runId !== undefined && { runId }),
        });
      },
      optimisticCodecMessageIds: [...codecMessageIds],
      toInvocation: () =>
        // The invocation body carries no run-id: run identity lives on the
        // channel (the agent mints a fresh run-id, or reads a continuation's
        // from the triggering input event, which carries the reused run-id).
        Invocation.fromJSON({
          inputEventId: triggerInputEventId,
          sessionName: this._channel.name,
        }),
    };
  }

  // Spec: AIT-CT7, AIT-CT7a
  async cancel(runId: string): Promise<void> {
    return this._publishCancel({ runId });
  }

  /**
   * Publish an `ai-cancel` signal. The agent resolves the target run by
   * whichever identifier is present:
   *
   * - `runId` — a continuation, whose run-id the caller already knows.
   * - `inputCodecMessageId` — a fresh send, whose run-id the agent mints at
   *   run-start. The client can only key the cancel by the triggering input's
   *   codec-message-id (the `ActiveRun.key`) it owns at send time; the agent
   *   resolves it to the run once its input-event lookup completes, buffering
   *   a cancel that arrives before then.
   *
   * Both may be present (a continuation knows its run-id AND published an
   * input). An `event-id` is always stamped so channel rewind redelivers the
   * cancel to a per-request / serverless agent that attaches after it was
   * published.
   *
   * Publishing the cancel signal is all the core does. The consumer-facing
   * stream (if any) lives in the layer that built it — e.g. the Vercel
   * ChatTransport closes its stream on cancel — and the Tree's RunNode is left
   * intact so late agent events (a cancel append, a trailing
   * `status: cancelled`) still fold into the Run's projection.
   * @param target - The run identifier(s) to cancel. At least one of `runId` /
   *   `inputCodecMessageId` must be set.
   * @param target.runId - The run-id to cancel (continuations).
   * @param target.inputCodecMessageId - The triggering input's
   *   codec-message-id to cancel (fresh sends, before run-start).
   */
  private async _publishCancel(target: { runId?: string; inputCodecMessageId?: string }): Promise<void> {
    if (this._state === ClientSessionState.CLOSED) return;
    await this._requireConnected('cancel');
    // CAST: re-check after await — close() may have been called while waiting for connect.
    if ((this._state as ClientSessionState) === ClientSessionState.CLOSED) return;
    this._logger.debug('ClientSession._publishCancel();', {
      runId: target.runId,
      inputCodecMessageId: target.inputCodecMessageId,
    });

    const headers: Record<string, string> = {
      // Stamp a per-cancel event-id so channel rewind redelivers this cancel
      // to an agent that attaches after it was published.
      [HEADER_EVENT_ID]: crypto.randomUUID(),
    };
    if (target.runId !== undefined) headers[HEADER_RUN_ID] = target.runId;
    if (target.inputCodecMessageId !== undefined) headers[HEADER_INPUT_CODEC_MESSAGE_ID] = target.inputCodecMessageId;

    await this._channel.publish({
      name: EVENT_CANCEL,
      extras: { ai: { transport: headers } },
    });
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
    // Reject any in-flight `run.runId` promises so callers awaiting run-start
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
