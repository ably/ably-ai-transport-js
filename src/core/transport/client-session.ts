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
// Also augments RealtimeChannel with `.object` (ably/liveobjects side-effect).
import type * as AblyObjects from 'ably/liveobjects';

import {
  EVENT_RUN_END,
  HEADER_CODEC_MESSAGE_ID,
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
import { errorCause, errorMessage, getTransportHeaders } from '../../utils.js';
import { registerAgent } from '../agent.js';
import { resolveChannelModes } from '../channel-options.js';
import type { Codec, CodecInputEvent, CodecOutputEvent, Encoder } from '../codec/types.js';
import { buildCancelMessage, type CancelTarget } from './cancel-envelope.js';
import type { WireApplier } from './decode-fold.js';
import { buildRunEndError, buildTransportHeaders } from './headers.js';
import { createHistoryHydrator, type HistoryHydrator } from './history-hydrator.js';
import { Invocation } from './invocation.js';
import { createMaterialisation } from './materialisation.js';
import {
  bestEffortDetach,
  continuityLostError,
  handleWireMessage,
  isContinuityLost,
  requireConnected,
  SessionState,
  subscribeAndAttach,
} from './session-support.js';
import type { DefaultTree } from './tree.js';
import type {
  ActiveRun,
  ClientSession,
  ClientSessionOptions,
  ClientView,
  RunEndReason,
  SendOptions,
  Tree,
} from './types.js';
import { createClientView } from './view.js';

/**
 * Returned from `on()` when the session is already closed — the subscription
 * is silently ignored since no further events will fire.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional no-op
const noopUnsubscribe = (): void => {};

/**
 * Whether an input references an existing codec-message rather than
 * introducing fresh local content. Regenerate signals and inputs that pin an
 * existing `codecMessageId` (tool resolutions, approval responses) are
 * wire-only: they ride the channel without an optimistic projection fold. A
 * fresh `user-message` is never wire-only — it is the one input kind that
 * introduces a new message — even on the rare path where it pins its own
 * `codecMessageId`.
 * @param input - The input to classify.
 * @returns True when the input is wire-only (references an existing message).
 */
const isWireOnlyInput = (input: CodecInputEvent): boolean =>
  input.kind !== 'user-message' && (input.kind === 'regenerate' || input.codecMessageId !== undefined);

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
  private readonly _client: Ably.Realtime;
  private readonly _codec: Codec<TInput, TOutput, TProjection, TMessage>;
  private readonly _logger: Logger;

  // Typed event emitter — the session emits only 'error'; all data events live on Tree/View
  private readonly _emitter: EventEmitter<ClientSessionEventsMap>;

  // Sub-components
  private readonly _tree: DefaultTree<TInput, TOutput, TProjection>;
  private readonly _view: ClientView<TInput, TMessage>;
  private readonly _views = new Set<ClientView<TInput, TMessage>>();
  /**
   * The Tree's single decode-and-apply engine, binding the session's one
   * decoder instance. Shared by the live decode loop and every View's history
   * replay so an attach-boundary in-flight stream is continued (not
   * re-started) by hydration, and re-delivered content decodes to nothing.
   */
  private readonly _applier: WireApplier;
  /**
   * The session's shared history hydrator over the Tree/applier. Injected into
   * every View so the channel is paged once across views, and `hasOlder()`
   * reflects real cursor exhaustion.
   */
  private readonly _hydrator: HistoryHydrator;
  /**
   * Shared encoder for the lifetime of the session. The client only ever
   * uses `publishInput` (input wire), so the encoder's stream tracker map
   * stays empty across the session. Closed once on session close.
   */
  private readonly _encoder: Encoder<TInput, TOutput>;

  // Spec: AIT-CT10, AIT-CT10a
  readonly tree: Tree<TOutput, TProjection>;
  readonly view: ClientView<TInput, TMessage>;

  // Channel subscription is established lazily on connect()
  private _connectPromise: Promise<void> | undefined;
  private readonly _onMessage: (msg: Ably.InboundMessage) => void;

  private _state = SessionState.READY;
  private _hasAttachedOnce: boolean;
  private readonly _onChannelStateChange: Ably.channelEventCallback;

  /**
   * Backing settlers for each in-flight run's `ActiveRun.runId` promise.
   * Resolved with the agent-minted run-id when the matching `ai-run-start`
   * (fresh send) or `ai-run-resume` (continuation) is observed; rejected if
   * the session closes first. There is no deadline —
   * `send()` resolves on publish and does not block on run-start.
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
    const channelOptions: Ably.ChannelOptions = registerAgent(options.client, options.codec);
    // Spec: AIT-CT23 — request object modes etc. when channelModes opts in.
    const modes = resolveChannelModes(options.channelModes);
    if (modes) channelOptions.modes = modes;
    this._channel = options.client.channels.get(options.channelName, channelOptions);
    this._client = options.client;
    this._codec = options.codec;
    this._logger = (options.logger ?? makeLogger({ logLevel: LogLevel.Silent })).withContext({
      component: 'ClientSession',
    });

    this._emitter = new EventEmitter<ClientSessionEventsMap>(this._logger);
    this._hasAttachedOnce = this._channel.state === 'attached';

    // Compose sub-components
    const { tree, applier } = createMaterialisation(this._codec, this._logger);
    this._tree = tree;
    this._applier = applier;
    this._hydrator = createHistoryHydrator({
      channel: this._channel,
      tree: this._tree,
      applier: this._applier,
      logger: this._logger,
    });
    this._view = createClientView<TInput, TOutput, TProjection, TMessage>({
      tree: this._tree,
      codec: this._codec,
      hydrator: this._hydrator,
      sendDelegate: this._internalSend.bind(this),
      logger: this._logger,
      onClose: () => this._views.delete(this._view),
    });
    this._encoder = this._codec.createEncoder(this._channel);

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
        this._tree.applyMessage({ inputs: [this._codec.createUserMessage(msg)], outputs: [] }, seedHeaders);
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
  // Public accessors
  // ---------------------------------------------------------------------------

  // Spec: AIT-CT21
  get presence(): Ably.RealtimePresence {
    return this._channel.presence;
  }

  // Spec: AIT-CT22
  get object(): AblyObjects.RealtimeObject {
    return this._channel.object;
  }

  // ---------------------------------------------------------------------------
  // Public connection API
  // ---------------------------------------------------------------------------

  // Spec: AIT-CT2
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- preserve reference equality across calls
  connect(): Promise<void> {
    if (this._state === SessionState.CLOSED) {
      return Promise.reject(new Ably.ErrorInfo('unable to connect; session is closed', ErrorCode.SessionClosed, 400));
    }
    if (this._connectPromise) return this._connectPromise;

    this._logger.trace('DefaultClientSession.connect();');
    // Subscribe before attach (RTL7g) — subscribe implicitly attaches the channel.
    this._connectPromise = subscribeAndAttach(
      this._channel,
      this._onMessage,
      this._logger,
      'DefaultClientSession',
      (error) => {
        this._emitter.emit('error', error);
      },
    );
    return this._connectPromise;
  }

  /**
   * The session's identity, read from the Ably client's `auth.clientId`. Read
   * lazily (never cached at construction): under token auth the client only
   * learns its clientId once the connection reaches CONNECTED, which is
   * guaranteed by the time any write runs — every write awaits `connect()`,
   * and the channel cannot attach before the connection is CONNECTED. A
   * connection with no concrete identity (anonymous, or a wildcard `*` token)
   * resolves to `undefined`, so no run/input client id is stamped.
   * @returns The client's concrete identity, or `undefined` if it has none.
   */
  // Spec: AIT-CT1b
  private _resolveClientId(): string | undefined {
    const clientId = this._client.auth.clientId;
    return clientId && clientId !== '*' ? clientId : undefined;
  }

  private async _requireConnected(method: string): Promise<void> {
    return requireConnected(this._connectPromise, method);
  }

  // ---------------------------------------------------------------------------
  // Message subscription handler
  // ---------------------------------------------------------------------------

  private _handleMessage(ablyMessage: Ably.InboundMessage): void {
    if (this._state === SessionState.CLOSED) return;

    handleWireMessage(
      () => {
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
            const errInfo = buildRunEndError(headers);
            this._logger.error('ClientSession._handleMessage(); agent error received', {
              runId: headers[HEADER_RUN_ID],
              invocationId: headers[HEADER_INVOCATION_ID],
              code: errInfo.code,
            });
            this._emitter.emit('error', errInfo);
          }
        }

        // Reconstruct the tree via the Tree's single decode-and-apply engine —
        // the same applier (and decoder instance) the Views' history replay
        // uses, so the live loop can't drift from it and an attach-boundary
        // stream isn't double-decoded.
        const event = this._applier.apply(ablyMessage);

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
        // owning node in `_lastVisibleNodeKeySet` (keyed by run-id for reply runs
        // and codec-message-id for inputs), which is refreshed by the tree
        // 'update' events the apply triggers.
        this._tree.emitAblyMessage(ablyMessage);
      },
      (error) => {
        this._emitter.emit('error', error);
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Channel state change handler
  // ---------------------------------------------------------------------------

  // Spec: AIT-CT19, AIT-CT19a
  private _handleChannelStateChange(stateChange: Ably.ChannelStateChange): void {
    if (this._state === SessionState.CLOSED) return;

    const { current, resumed } = stateChange;

    // Track the initial attach so we don't treat it as a discontinuity
    if (current === 'attached' && !this._hasAttachedOnce) {
      this._hasAttachedOnce = true;
      return;
    }

    if (!isContinuityLost(stateChange)) return;

    this._logger.error('ClientSession._handleChannelStateChange(); channel continuity lost', {
      current,
      resumed,
      previous: stateChange.previous,
    });

    const err = continuityLostError(stateChange, 'deliver events');

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
   * @param codecMessageId - The codec-message-id of the failed send's
   *   optimistic input node (the client mints no run-id, so the optimistic
   *   insert is keyed by its codec-message-id).
   */
  private _cleanupFailedSend(codecMessageId: string): void {
    // Drop the optimistic input node only if the publish never produced a
    // server-assigned serial (i.e. nothing live observed it). A server-acked
    // node is part of the canonical channel state and must stay; the View /
    // observers already see it. A fresh send's optimistic insert is an input
    // node (keyed by codec-message-id).
    const node = this._tree.getNodeByCodecMessageId(codecMessageId);
    if (node?.kind === 'input' && node.serial === undefined) {
      // An input node's key is its codec-message-id, so delete by it directly.
      this._tree.delete(node.codecMessageId);
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  // Spec: AIT-CT10b
  createView(): ClientView<TInput, TMessage> {
    if (this._state === SessionState.CLOSED) {
      throw new Ably.ErrorInfo('unable to create view; session is closed', ErrorCode.SessionClosed, 400);
    }
    this._logger.trace('DefaultClientSession.createView();');
    const view = createClientView<TInput, TOutput, TProjection, TMessage>({
      tree: this._tree,
      codec: this._codec,
      hydrator: this._hydrator,
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
    if (this._state === SessionState.CLOSED) {
      throw new Ably.ErrorInfo('unable to send; session is closed', ErrorCode.SessionClosed, 400);
    }
    await this._requireConnected('send');
    // CAST: re-check after await — close() may have been called while waiting for connect.
    // TypeScript's control flow narrows _state after the first check, but the
    // await yields and close() can mutate _state concurrently.
    if ((this._state as SessionState) === SessionState.CLOSED) {
      throw new Ably.ErrorInfo('unable to send; session is closed', ErrorCode.SessionClosed, 400);
    }

    // Spec: AIT-CT20
    const state = this._channel.state;
    if (state !== 'attached' && state !== 'attaching') {
      throw new Ably.ErrorInfo(`unable to send; channel is ${state}`, ErrorCode.ChannelNotReady, 400);
    }

    this._logger.trace('ClientSession._internalSend();');

    // The agent mints run-ids, not the client. A fresh send carries no run-id
    // (the agent mints it and echoes it on run-start); only a continuation
    // reuses the existing run-id the caller passed.
    const runId = sendOptions?.runId;

    // Spec: AIT-CT3d
    // Auto-compute parent from the visible branch tail when not explicitly
    // provided. The View pre-resolves the codec-message-id of the last visible message
    // since the session is codec-agnostic and can't extract it from TMessage.
    let autoParent: string | undefined;
    if (sendOptions?.parent === undefined && !sendOptions?.forkOf) {
      autoParent = parentCodecMessageId;
    }

    // A send carries at most one new message: exactly one input may introduce
    // fresh local content (a `user-message`). The remaining inputs are
    // wire-only references to existing messages (a regenerate signal, or the
    // tool resolutions of a single assistant turn). Reject a send that would
    // introduce more than one new message before any optimistic fold or
    // publish, so partial state never lands.
    if (input.filter((entry) => !isWireOnlyInput(entry)).length > 1) {
      throw new Ably.ErrorInfo(
        'unable to send; a send may introduce at most one new message',
        ErrorCode.InvalidArgument,
        400,
      );
    }

    // The codec-message-id of the send's one optimistic (non-wire-only) input,
    // if any — the input node that needs removing if the publish fails. A
    // continuation carries only wire-only inputs, so it stays undefined.
    let optimisticCodecMessageId: string | undefined;
    interface ItemState {
      input: TInput;
      codecMessageId: string;
      inputEventId: string;
      headers: Record<string, string>;
    }
    const items: ItemState[] = [];

    // Per-input wire prep: read routing fields off the input directly, then
    // mint per-event ids and build transport headers. Wire-only inputs
    // (regenerate, tool resolutions) skip the optimistic fold; the one
    // non-wire-only input folds into the projection optimistically.
    for (const entry of input) {
      const inputEventId = crypto.randomUUID();
      // Use the input's `codecMessageId` when set (e.g. tool resolution
      // targeting the prior assistant); otherwise mint a fresh id.
      const codecMessageId = entry.codecMessageId ?? crypto.randomUUID();

      // Inputs that reference an existing message (regenerate, tool
      // resolutions targeting an assistant) are wire-only — no optimistic
      // fold needed because either the receiving content doesn't
      // materialise on this side (regenerate) or the target already exists
      // and will be amended when the wire echoes back.
      //
      // A fresh `user-message` is never wire-only, even on the rare path
      // where it carries an explicit `codecMessageId`: it is new content that
      // must fold into the local projection immediately. Excluding it here
      // keeps the optimistic user bubble from depending on the channel
      // round-trip. (The session mints the codec-message-id for fresh user
      // messages; the caller's `message.id` is preserved but never used as
      // the correlation key.)
      const isWireOnly = isWireOnlyInput(entry);

      // The input's own routing fields override the auto-parent /
      // sendOptions defaults. For regenerate inputs, `target` becomes the
      // `msg-regenerate` wire header. The fork anchor comes from
      // `sendOptions.forkOf` (set by `View.edit`). The transport reads
      // these directly without runtime classification.
      const parent = entry.parent ?? (sendOptions?.parent === undefined ? autoParent : sendOptions.parent);
      const forkOf = sendOptions?.forkOf;
      const regenerates = entry.kind === 'regenerate' ? entry.target : undefined;

      const headers = buildTransportHeaders({
        role: 'user',
        runId,
        codecMessageId,
        runClientId: this._resolveClientId(),
        ...(parent !== undefined && { parent }),
        ...(forkOf !== undefined && { forkOf }),
        ...(regenerates !== undefined && { regenerates }),
        inputEventId,
      });

      // Spec: AIT-CT3c — optimistic fold for the one non-wire-only input.
      if (!isWireOnly) {
        this._tree.applyMessage({ inputs: [entry], outputs: [] }, headers);
        optimisticCodecMessageId = codecMessageId;
      }

      items.push({ input: entry, codecMessageId, inputEventId, headers });
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
          });
        }
      } catch (error) {
        const cause = errorCause(error);
        const isPermission = cause?.statusCode === 401 || cause?.statusCode === 403;
        const err = new Ably.ErrorInfo(
          isPermission
            ? `unable to publish events; missing publish capability on the channel`
            : `unable to publish events; ${errorMessage(error)}`,
          isPermission ? ErrorCode.InsufficientCapability : ErrorCode.SessionSendFailed,
          isPermission ? 401 : 500,
          cause,
        );
        this._emitter.emit('error', err);
        // The input never reached the channel — there is no run to wait on.
        // Drop the run-start tracker so close() doesn't later reject an orphan.
        this._pendingRunStarts.delete(startedKey);
        // Continuations didn't insert an optimistic node, so there is nothing
        // to clear for them — only a fresh send's optimistic input node needs
        // removing, keyed by its codec-message-id (the client mints no runId).
        if (optimisticCodecMessageId !== undefined) this._cleanupFailedSend(optimisticCodecMessageId);
        throw err;
      }
    })();

    // `send()` resolves once the input is published. The core never sends
    // HTTP — waking an agent is the application's concern. Callers POST
    // `run.toInvocation().toJSON()` to their endpoint if they want one woken,
    // and await `run.runId` if they need to know it was picked up.
    await publishPromise;

    return {
      inputCodecMessageId: startedKey,
      runId: runIdPromise,
      inputEventId: triggerInputEventId,
      // The agent mints the run-id, so a fresh run has none until run-start.
      // Cancel synchronously by the triggering input's codec-message-id (the
      // handle the client owns at send time, = `inputCodecMessageId`): the
      // agent resolves it to the run once its input-event lookup completes, and
      // buffers a cancel that arrives before then so an early cancel is honoured
      // rather than dropped. A continuation additionally carries its known
      // run-id so the agent can match the run directly.
      cancel: async () => {
        await this._publishCancel({
          inputCodecMessageId: startedKey,
          ...(runId !== undefined && { runId }),
        });
      },
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
   *   codec-message-id (the `ActiveRun.inputCodecMessageId`) it owns at send
   *   time; the agent resolves it to the run once its input-event lookup
   *   completes, buffering a cancel that arrives before then.
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
   *   `inputCodecMessageId` must be set (see {@link CancelTarget}).
   */
  private async _publishCancel(target: CancelTarget): Promise<void> {
    if (this._state === SessionState.CLOSED) return;
    await this._requireConnected('cancel');
    // CAST: re-check after await — close() may have been called while waiting for connect.
    if ((this._state as SessionState) === SessionState.CLOSED) return;
    this._logger.debug('ClientSession._publishCancel();', {
      runId: target.runId,
      inputCodecMessageId: target.inputCodecMessageId,
    });

    await this._channel.publish(buildCancelMessage(target));
  }

  // Spec: AIT-CT8, AIT-CT8c, AIT-CT8d
  on(event: 'error', handler: (error: Ably.ErrorInfo) => void): () => void {
    if (this._state === SessionState.CLOSED) return noopUnsubscribe;
    // CAST: the overload signature enforces the correct handler type.
    const cb = handler;
    this._emitter.on(event, cb);
    return () => {
      this._emitter.off(event, cb);
    };
  }

  // Spec: AIT-CT12, AIT-CT12b, AIT-CT10c
  async close(): Promise<void> {
    if (this._state === SessionState.CLOSED) return;
    this._state = SessionState.CLOSED;
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
    // The client only uses the discrete input path (publishInput), so this is
    // typically a no-op, but it releases any internal resources cleanly.
    try {
      await this._encoder.close();
    } catch {
      // Swallow: encoder close is best-effort during teardown
    }

    await bestEffortDetach(this._channel, this._connectPromise, this._logger, 'ClientSession');
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
