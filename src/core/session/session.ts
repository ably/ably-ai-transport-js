import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import { EventEmitter } from '../../event-emitter.js';
import { Headers, readHeader, WireMessages } from '../../headers.js';
import type { Logger } from '../../logger.js';
import { LogLevel, makeLogger } from '../../logger.js';
import type { RealtimeWithOptions } from '../../realtime-extensions.js';
import { VERSION } from '../../version.js';
import type { Accumulator, AnyCodec, CodecEvent, CodecMessage, CodecPart, Decoder } from '../codec/index.js';
import type { Invocation } from '../invocation/index.js';
import type { AgentRun, Run, RunStatus, RunSuspendStatus } from '../run/index.js';
import { DefaultAgentRun } from '../run/index.js';
import type { StepStatus } from '../step/index.js';
import type { ControlSignalType, MessageNode, TreeInternal } from '../tree/index.js';
import { DefaultTree } from '../tree/index.js';
import type { ClientView } from '../view/index.js';
import { DefaultClientView, DefaultView } from '../view/index.js';
import { ChannelManager } from './channel-manager.js';
import type { SessionWriter } from './writer.js';
import { DefaultSessionWriter } from './writer.js';

/**
 * Options shared by {@link createClientSession} and {@link createAgentSession}.
 *
 * Parameterised by the codec — `C extends Codec<TPart, TMessage, TEvent>` —
 * so callers name the session variant with a single type argument. The
 * factory functions infer `C` from `options.codec`, so call sites rarely
 * need to write it explicitly.
 *
 * Note: `storageReader` and `storageWriter` from the RFC are not yet
 * implemented and are intentionally omitted from this scaffold.
 */
export interface SessionOptions<C extends AnyCodec> {
  /**
   * The Ably Realtime client. The SDK derives the channel(s) it needs from
   * the session name. Taking a client (rather than a pre-constructed channel)
   * lets the SDK tag it with an `ably-agent` header for usage attribution and
   * leaves room to evolve a session into multiple channels in future without
   * a breaking change.
   */
  client: Ably.Realtime;

  /**
   * The session name. Today this is used as the name of the single channel
   * backing the session; in future a session may span multiple channels and
   * the SDK will derive those channel names from this value.
   */
  sessionName: string;

  /** Codec that translates between domain parts and channel operations. */
  codec: C;

  /** Logger instance. */
  logger?: Logger;
}

/**
 * Events emitted by a session.
 * @internal
 */
interface SessionEvents {
  /** Emitted when the session encounters an unrecoverable error. */
  error: Ably.ErrorInfo;
}

/**
 * Narrow a wire `x-ably-status` value to a {@link RunStatus} the tree can
 * transition into via `applyRunEnd`. Accepts `'complete'`, `'failed'`,
 * and `'aborted'` — the abort row of {@link AgentRun.end}'s classifier
 * produces `'aborted'` when the bound step's `signal.reason` is `ABORTED`.
 * @param value The raw header value.
 * @returns True when `value` is a recognised run-end status.
 */
const isRunEndStatus = (value: string | undefined): value is RunStatus =>
  value === 'complete' || value === 'failed' || value === 'aborted';

/**
 * Narrow a wire `x-ably-status` value to the suspend reasons accepted on
 * `x-ably-run-suspend`. Only `'paused'` is supported in this iteration;
 * `'awaiting-input'` lands additively when HITL is implemented.
 * @param value The raw header value.
 * @returns True when `value` is a recognised run-suspend status.
 */
const isRunSuspendStatus = (value: string | undefined): value is RunSuspendStatus => value === 'paused';

/**
 * Narrow a wire `x-ably-status` value to a {@link StepStatus} the tree can
 * transition into via `applyStepEnd`. Accepts `'complete'`, `'failed'`,
 * and `'aborted'`; pause/supersession statuses land alongside those
 * surfaces in later phases.
 * @param value The raw header value.
 * @returns True when `value` is a recognised step-end status.
 */
const isStepEndStatus = (value: string | undefined): value is StepStatus =>
  value === 'complete' || value === 'failed' || value === 'aborted';

/**
 * Translate a {@link WireMessages} control-signal wire name into the
 * {@link ControlSignalType} discriminator carried on
 * {@link ControlSignal.type}. Returns `undefined` for non-signal wire
 * names so the dispatcher can warn.
 * @param name The Ably message name to translate.
 * @returns The control-signal type, or `undefined` if the name is not
 *   a known control-signal wire.
 */
const wireMessageNameToControlSignalType = (name: string | undefined): ControlSignalType | undefined => {
  switch (name) {
    case WireMessages.Abort: {
      return 'abort';
    }
    case WireMessages.Pause: {
      return 'pause';
    }
    case WireMessages.Resume: {
      return 'resume';
    }
    case WireMessages.Retry: {
      return 'retry';
    }
    default: {
      return undefined;
    }
  }
};

/**
 * Long-lived handle on a durable session from the client's perspective.
 *
 * Phase 2 surface — `createView()` returns a {@link ClientView} that
 * projects the session's tree. The codec-aware writer (`writer`) and the
 * direct `tree` accessor from the RFC are deferred to later phases.
 *
 * Parameterised by the session's codec — `C extends Codec<TPart, TMessage,
 * TEvent>` — so `createView()` returns the right `ClientView<C>` variant.
 */
export interface ClientSession<C extends AnyCodec> {
  /** The session name, as passed to {@link createClientSession}. */
  readonly sessionName: string;

  /**
   * Subscribe to the channel for live events. Resolves when the live
   * subscription is active.
   *
   * Idempotent: calling connect() a second time is a no-op and resolves
   * immediately so that workflow retries are not hostile.
   */
  connect(): Promise<void>;

  /**
   * Unsubscribe from the channel and tear down the session. Idempotent and
   * never rejects — callers can safely call close() in error-handling paths
   * without wrapping it in try/catch. Closes every view created through
   * {@link createView} as part of teardown.
   */
  close(): Promise<void>;

  /**
   * Symbol.asyncDispose — equivalent to {@link close}. Closes subscriptions;
   * no publish side effects.
   */
  [Symbol.asyncDispose](): Promise<void>;

  /**
   * Create a read projection over the session's tree. The view starts empty
   * and fills in as the channel delivers messages — call {@link connect}
   * before relying on it. Multiple views can coexist; each has its own
   * subscriptions and `close()` lifecycle.
   * @returns A new {@link ClientView} bound to this session.
   * @throws An `Ably.ErrorInfo` with code {@link ErrorCode.SessionClosed}
   *   when called after {@link close}.
   */
  createView(): ClientView<C>;

  /**
   * Low-level write surface for publishing onto the session's channel.
   * Phase 3 exposes only `sendMessages`; later phases add additional
   * publish methods additively.
   */
  readonly writer: SessionWriter<C>;

  /**
   * Fires when the session encounters an unrecoverable error — channel
   * detach or failed state.
   * @param event The event name (only `'error'` is supported today).
   * @param handler The callback invoked with the error info.
   */
  on(event: 'error', handler: (error: Ably.ErrorInfo) => void): void;
  /**
   * Remove a previously registered `error` handler.
   * @param event The event name (only `'error'` is supported today).
   * @param handler The callback to remove.
   */
  off(event: 'error', handler: (error: Ably.ErrorInfo) => void): void;
}

/**
 * Options accepted by {@link AgentSession.createRun}, controlling how long
 * the SDK waits for the invocation's preconditions to materialise on the
 * session.
 */
export interface CreateRunOptions {
  /**
   * Reject the call after this many milliseconds if the invocation's
   * preconditions are still not met. Defaults to `60_000`. The rejection
   * surfaces as `Ably.ErrorInfo` with code
   * {@link ErrorCode.InvocationPreconditionTimeout}.
   */
  timeoutMs?: number;

  /**
   * Caller-supplied abort signal. When the signal fires, the call rejects
   * with {@link ErrorCode.InvocationPreconditionTimeout} and stops waiting
   * for preconditions. Wire `req.signal` in serverless handlers so the
   * runtime's cancellation interrupts the wait alongside any caller-driven
   * timeout.
   */
  signal?: AbortSignal;
}

/**
 * Long-lived handle on a durable session from the agent's perspective.
 *
 * Phase 7 surface — connect/close lifecycle, error events, and
 * `createRun(invocation)` for binding to a run named by the invocation.
 * `tree` and `writer` from the RFC are deferred to later phases.
 *
 * Parameterised by the session's codec — `C extends Codec<TPart, TMessage,
 * TEvent>` — so `createRun` returns the right `AgentRun<C>` variant.
 */
export interface AgentSession<C extends AnyCodec> {
  /** The session name, as passed to {@link createAgentSession}. */
  readonly sessionName: string;

  /**
   * Subscribe to the channel for live events. Resolves when the live
   * subscription is active.
   *
   * Idempotent: calling connect() a second time is a no-op and resolves
   * immediately so that workflow retries are not hostile.
   */
  connect(): Promise<void>;

  /**
   * Unsubscribe from the channel and tear down the session. Idempotent and
   * never rejects — callers can safely call close() in error-handling paths
   * without wrapping it in try/catch.
   */
  close(): Promise<void>;

  /**
   * Symbol.asyncDispose — equivalent to {@link close}. Closes subscriptions;
   * no publish side effects.
   */
  [Symbol.asyncDispose](): Promise<void>;

  /**
   * Bind to the run named by the invocation and return an
   * {@link AgentRun} the agent can read messages from, end, and dispose.
   *
   * Waits for the invocation's preconditions to be visible on the
   * session before resolving:
   *
   *   - The run named by `invocation.runId` must have been observed on the
   *     channel (an `x-ably-run-start` either replayed during {@link connect}
   *     hydration or delivered live).
   *   - When `invocation.messageId` is set, the message with that id must
   *     also be visible.
   *
   * If the preconditions are already met (typical when hydration replayed
   * them), the returned promise resolves on the next microtask. Otherwise
   * the SDK subscribes to the tree and resolves the moment all
   * preconditions land. The wait is bounded by `options.timeoutMs`
   * (default `60_000`) and may be aborted via `options.signal`.
   * @param invocation The invocation produced by `view.send().toInvocation()`
   *   on the client side.
   * @param options Optional precondition-wait controls; see
   *   {@link CreateRunOptions}.
   * @returns A promise that resolves with an {@link AgentRun} bound to
   *   `invocation.runId` once the preconditions are visible on the session.
   * @throws An `Ably.ErrorInfo` with code {@link ErrorCode.SessionClosed}
   *   when called after {@link close}.
   * @throws An `Ably.ErrorInfo` with code {@link ErrorCode.InvalidArgument}
   *   when the invocation's `sessionName` does not match this session.
   * @throws An `Ably.ErrorInfo` with code
   *   {@link ErrorCode.InvocationPreconditionTimeout} when the wait elapses
   *   or the supplied signal aborts before the preconditions are met.
   */
  createRun(invocation: Invocation, options?: CreateRunOptions): Promise<AgentRun<C>>;

  /**
   * Fires when the session encounters an unrecoverable error — channel
   * detach or failed state.
   * @param event The event name (only `'error'` is supported today).
   * @param handler The callback invoked with the error info.
   */
  on(event: 'error', handler: (error: Ably.ErrorInfo) => void): void;
  /**
   * Remove a previously registered `error` handler.
   * @param event The event name (only `'error'` is supported today).
   * @param handler The callback to remove.
   */
  off(event: 'error', handler: (error: Ably.ErrorInfo) => void): void;
}

/**
 * Default implementation backing {@link createClientSession} and
 * {@link createAgentSession}. Both factories return the same underlying
 * object today — the agent-only surface (`createRun`, run-side writer)
 * lands in later phases.
 */
class DefaultSession<C extends AnyCodec> implements ClientSession<C>, AgentSession<C> {
  readonly sessionName: string;

  private readonly _realtime: Ably.Realtime;
  private readonly _logger: Logger;
  private readonly _channelManager: ChannelManager;
  private readonly _emitter: EventEmitter<SessionEvents>;
  private readonly _codec: C;
  private readonly _tree: TreeInternal<CodecMessage<C>>;
  private readonly _views = new Set<DefaultView<CodecMessage<C>>>();
  private readonly _writer: DefaultSessionWriter<C>;
  /**
   * Aborted in {@link close} so that pending `ClientRun.when` promises
   * surface a {@link ErrorCode.RunClosed} rejection rather than hanging
   * after their owning session has shut down. Threaded into every view
   * created from this session.
   */
  private readonly _closeController = new AbortController();

  private _decoder?: Decoder<CodecPart<C>, CodecMessage<C>, CodecEvent<C>>;
  private _accumulator?: Accumulator<CodecPart<C>, CodecMessage<C>, CodecEvent<C>>;

  private _connectPromise?: Promise<void>;
  private _stateListener?: (change: Ably.ChannelStateChange) => void;
  private _messageListener?: (message: Ably.InboundMessage) => void;
  private _closed = false;
  /**
   * True while {@link _doConnect} is paging through `channel.history` and
   * replaying historical messages into the tree. Inbound live messages
   * delivered during this window are buffered into {@link _hydrationBuffer}
   * and drained after the historical replay so the tree never sees a live
   * message ahead of an older history message.
   */
  private _hydrating = false;
  private readonly _hydrationBuffer: Ably.InboundMessage[] = [];

  constructor(options: SessionOptions<C>, role: 'client' | 'agent') {
    this.sessionName = options.sessionName;
    this._realtime = options.client;
    this._codec = options.codec;

    this._logger = (options.logger ?? makeLogger({ logLevel: LogLevel.Silent })).withContext({
      component: 'Session',
      role,
      sessionName: options.sessionName,
    });
    this._emitter = new EventEmitter(this._logger);
    this._channelManager = new ChannelManager(this._realtime, this.sessionName, this._logger);
    this._tree = new DefaultTree<CodecMessage<C>>({ logger: this._logger });
    this._writer = new DefaultSessionWriter<C>({
      codec: this._codec,
      channelManager: this._channelManager,
      realtime: this._realtime,
      role: role === 'client' ? 'user' : 'assistant',
      logger: this._logger,
      isClosed: () => this._closed,
    });

    this._addAgent('ai-transport-js');
    this._logger.trace('DefaultSession(); initialized');
  }

  /**
   * Tag the underlying Ably Realtime client with an agent string for usage
   * attribution. Should be called before the realtime client establishes its
   * connection — the agent header is read by Ably at connection time.
   * @param agent The agent identifier to add.
   * @param version The version of the agent. Defaults to the SDK version.
   */
  private _addAgent(agent: string, version?: string): void {
    const realtime = this._realtime as RealtimeWithOptions;
    realtime.options.agents = { ...realtime.options.agents, [agent]: version ?? VERSION };
  }

  async connect(): Promise<void> {
    this._logger.trace('DefaultSession.connect();');

    if (this._closed) {
      throw new Ably.ErrorInfo('unable to connect; session is closed', ErrorCode.SessionClosed, 400);
    }

    if (this._connectPromise) {
      return this._connectPromise;
    }

    // Wrap the inner async helper so that a failed attach clears the cached
    // promise and lets the caller retry. async/await is preferred over .catch
    // chains per .claude/rules/PROMISES.md, so the recovery is in try/catch.
    const run = async (): Promise<void> => {
      try {
        await this._doConnect();
      } catch (error) {
        this._connectPromise = undefined;
        throw error;
      }
    };
    this._connectPromise = run();

    return this._connectPromise;
  }

  private async _doConnect(): Promise<void> {
    const channel = this._channelManager.get();

    await channel.attach();

    // Register the state listener only after attach succeeds — if attach
    // rejects, no listener is dangling on the channel for close() to clean up.
    this._stateListener = (change: Ably.ChannelStateChange) => {
      this._handleStateChange(change);
    };
    channel.on(['failed', 'detached'], this._stateListener);

    // Stand up the codec's decoder + accumulator only once we're committed to
    // running the decode loop. A failed attach above means we never call into
    // the codec, which keeps unit tests that don't exercise the decode path
    // from needing a working codec.
    this._decoder = this._codec.createDecoder();
    this._accumulator = this._codec.createAccumulator();

    // Subscribe before fetching history so live messages that arrive while we
    // page through history are not lost. Buffer them while hydrating and drain
    // after the historical replay so the tree never observes a newer live
    // message ahead of an older history one.
    this._hydrating = true;
    this._messageListener = (message: Ably.InboundMessage) => {
      if (this._hydrating) {
        this._hydrationBuffer.push(message);
        return;
      }
      this._handleInboundMessage(message);
    };
    await channel.subscribe(this._messageListener);

    try {
      await this._hydrateFromHistory(channel);
    } catch (error) {
      // Hydration is part of `connect()` — surface the failure to the caller
      // so the session is not left in a half-attached state. Detach the
      // listeners we registered above so a retried `connect()` doesn't
      // double-subscribe and double-fire `error` events.
      this._hydrating = false;
      this._hydrationBuffer.length = 0;
      // Both listeners were registered earlier in this method, so they are
      // always defined here. Detaching them makes a retried `connect()`
      // safe — otherwise the retry would double-subscribe and double-fire
      // `error` events.
      channel.off(this._stateListener);
      this._stateListener = undefined;
      channel.unsubscribe(this._messageListener);
      this._messageListener = undefined;
      const cause = error instanceof Ably.ErrorInfo ? error : undefined;
      throw new Ably.ErrorInfo(
        `unable to connect; channel history hydration failed${cause ? `: ${cause.message}` : ''}`,
        ErrorCode.HydrationFailed,
        500,
        cause,
      );
    }

    // Replay any inbound that landed during hydration. New inbounds bypass
    // the buffer since `_hydrating` is now false.
    this._hydrating = false;
    const buffered = this._hydrationBuffer.splice(0);
    for (const buffer of buffered) {
      this._handleInboundMessage(buffer);
    }

    this._logger.debug('DefaultSession.connect(); channel attached, subscribed, and hydrated', {
      buffered: buffered.length,
    });
  }

  /**
   * Page through channel history with `untilAttach: true` and replay every
   * message through the live decode loop in oldest-first order. The Ably
   * REST `history({ untilAttach: true })` query returns messages newest-first
   * with `direction: 'backwards'`, so the implementation reverses each page
   * and walks pages from oldest to newest.
   *
   * Aborts if the session is closed mid-page so a `close()` during connect
   * does not race the replay against teardown.
   * @param channel The session's realtime channel.
   */
  private async _hydrateFromHistory(channel: Ably.RealtimeChannel): Promise<void> {
    this._logger.trace('DefaultSession._hydrateFromHistory();');

    const pages: Ably.InboundMessage[][] = [];
    let page: Ably.PaginatedResult<Ably.InboundMessage> | null = await channel.history({
      untilAttach: true,
      direction: 'backwards',
      limit: 100,
    });
    while (page !== null) {
      if (this._closed) {
        return;
      }
      pages.push(page.items);
      if (!page.hasNext()) {
        break;
      }
      page = await page.next();
    }

    // pages[0] is the most recent batch; pages[pages.length - 1] is the
    // oldest. Items within each page are newest-first; iterate both axes
    // in reverse to deliver oldest-first to the decode loop.
    let replayed = 0;
    for (let p = pages.length - 1; p >= 0; p--) {
      const batch = pages[p];
      if (batch === undefined) {
        continue;
      }
      for (let i = batch.length - 1; i >= 0; i--) {
        if (this._closed) {
          return;
        }
        const item = batch[i];
        if (item === undefined) {
          continue;
        }
        this._handleInboundMessage(item);
        replayed += 1;
      }
    }

    this._logger.debug('DefaultSession._hydrateFromHistory(); replayed', { replayed });
  }

  private _handleStateChange(change: Ably.ChannelStateChange): void {
    if (this._closed) {
      return;
    }

    this._logger.warn('DefaultSession._handleStateChange();', {
      current: change.current,
      previous: change.previous,
      reason: change.reason?.message,
    });

    const reason =
      change.reason ??
      new Ably.ErrorInfo(
        `unable to maintain session; channel entered ${change.current} state`,
        ErrorCode.TransportSubscriptionError,
        500,
      );
    this._emitter.emit('error', reason);
  }

  private _handleInboundMessage(message: Ably.InboundMessage): void {
    this._logger.trace('DefaultSession._handleInboundMessage();', { serial: message.serial, name: message.name });

    if (message.name === WireMessages.RunStart) {
      this._handleRunStart(message);
      return;
    }
    if (message.name === WireMessages.RunSuspend) {
      this._handleRunSuspend(message);
      return;
    }
    if (message.name === WireMessages.RunEnd) {
      this._handleRunEnd(message);
      return;
    }
    if (message.name === WireMessages.StepStart) {
      this._handleStepStart(message);
      return;
    }
    if (message.name === WireMessages.StepEnd) {
      this._handleStepEnd(message);
      return;
    }
    if (
      message.name === WireMessages.Abort ||
      message.name === WireMessages.Pause ||
      message.name === WireMessages.Resume ||
      message.name === WireMessages.Retry
    ) {
      this._handleControlSignal(message);
      return;
    }

    if (!this._decoder || !this._accumulator) {
      // Defensive: subscribe is registered after _decoder/_accumulator are set,
      // so this should not happen. If it does, we have nothing useful to do.
      this._logger.warn('DefaultSession._handleInboundMessage(); decoder or accumulator missing');
      return;
    }

    const wireMessageId = readHeader(message, Headers.MessageId);
    if (wireMessageId === undefined) {
      this._logger.warn('DefaultSession._handleInboundMessage(); missing x-ably-msg-id', {
        serial: message.serial,
      });
      return;
    }

    const role = readHeader(message, Headers.Role);
    if (role !== 'user' && role !== 'assistant') {
      this._logger.warn('DefaultSession._handleInboundMessage(); invalid x-ably-role', {
        role,
        serial: message.serial,
      });
      return;
    }

    const clientId = readHeader(message, Headers.ClientId) ?? message.clientId;
    if (clientId === undefined) {
      this._logger.warn('DefaultSession._handleInboundMessage(); missing clientId', {
        serial: message.serial,
      });
      return;
    }

    const runId = readHeader(message, Headers.RunId);
    if (runId === undefined) {
      this._logger.warn('DefaultSession._handleInboundMessage(); missing x-ably-run-id', {
        serial: message.serial,
      });
      return;
    }

    const stepId = readHeader(message, Headers.StepId);

    const serial = message.serial;
    if (serial === undefined) {
      this._logger.warn('DefaultSession._handleInboundMessage(); inbound message missing serial');
      return;
    }

    let decoded;
    try {
      decoded = this._decoder.decode(message);
    } catch (error) {
      this._logger.error('DefaultSession._handleInboundMessage(); decode failed', { error });
      return;
    }

    for (const value of decoded) {
      const messageId = value.messageId ?? wireMessageId;
      // Streaming-part wires belong to an in-flight assistant stream; the
      // node is `streaming: true` until a step-end / run-end / abort lands
      // for the run. Complete-message wires (the user-message round-trip
      // path) reconstruct in one shot, so the node is `streaming: false`.
      let streaming: boolean;
      if (value.kind === 'part') {
        this._accumulator.processPart(value.part, messageId);
        streaming = true;
      } else if (value.kind === 'message') {
        this._accumulator.applyMessage(messageId, value.message);
        streaming = false;
      } else {
        // Phase 2 doesn't route codec events yet — they land alongside the
        // writer surfaces that produce them in a later phase.
        continue;
      }

      const composed = this._accumulator.getMessage(messageId);
      if (composed === undefined) {
        continue;
      }

      // Subsequent chunks under one msg-id update the existing node so
      // streaming codecs can land deltas as composed-message updates without
      // creating sibling nodes. The accumulator above has already absorbed
      // the value; the tree mirrors the composed state. Update preserves the
      // node's streaming flag — `streaming` only flips false on a lifecycle
      // observation (step-end / run-end / abort) routed through the tree.
      if (this._tree.messages.some((node) => node.id === messageId)) {
        this._tree.updateMessage(messageId, composed);
        continue;
      }

      // `canonical: true` is a placeholder — the tree projects from the
      // current step state (or defaults to `true` for stepless / not-yet-
      // observed-step nodes) inside applyMessage. Spec: AIT-CN2.
      const node: MessageNode<CodecMessage<C>> = {
        id: messageId,
        role,
        clientId,
        runId,
        ...(stepId === undefined ? {} : { stepId }),
        message: composed,
        streaming,
        serial,
        canonical: true,
      };
      this._tree.applyMessage(node);
    }
  }

  private _handleRunStart(message: Ably.InboundMessage): void {
    const runId = readHeader(message, Headers.RunId);
    if (runId === undefined) {
      this._logger.warn('DefaultSession._handleRunStart(); missing x-ably-run-id', {
        serial: message.serial,
      });
      return;
    }

    const initiatorClientId = readHeader(message, Headers.ClientId) ?? message.clientId;
    if (initiatorClientId === undefined) {
      this._logger.warn('DefaultSession._handleRunStart(); missing initiator clientId', {
        runId,
        serial: message.serial,
      });
      return;
    }

    const run: Run<CodecMessage<C>> = {
      id: runId,
      status: 'active',
      initiatorClientId,
      controlSignals: [],
      pauseRequested: false,
    };
    this._tree.applyRunStart(run);
  }

  private _handleRunSuspend(message: Ably.InboundMessage): void {
    // Spec: AIT-RS1, AIT-RS2.
    const runId = readHeader(message, Headers.RunId);
    if (runId === undefined) {
      this._logger.warn('DefaultSession._handleRunSuspend(); missing x-ably-run-id', {
        serial: message.serial,
      });
      return;
    }

    const status = readHeader(message, Headers.Status);
    if (!isRunSuspendStatus(status)) {
      this._logger.warn('DefaultSession._handleRunSuspend(); invalid x-ably-status', {
        runId,
        status,
        serial: message.serial,
      });
      return;
    }

    this._tree.applyRunSuspend({ runId });
  }

  private _handleStepEnd(message: Ably.InboundMessage): void {
    const stepId = readHeader(message, Headers.StepId);
    if (stepId === undefined) {
      this._logger.warn('DefaultSession._handleStepEnd(); missing x-ably-step-id', {
        serial: message.serial,
      });
      return;
    }

    const status = readHeader(message, Headers.Status);
    if (!isStepEndStatus(status)) {
      this._logger.warn('DefaultSession._handleStepEnd(); invalid x-ably-status', {
        stepId,
        status,
        serial: message.serial,
      });
      return;
    }

    this._tree.applyStepEnd({ stepId, status });
  }

  private _handleStepStart(message: Ably.InboundMessage): void {
    const runId = readHeader(message, Headers.RunId);
    if (runId === undefined) {
      this._logger.warn('DefaultSession._handleStepStart(); missing x-ably-run-id', {
        serial: message.serial,
      });
      return;
    }

    const stepId = readHeader(message, Headers.StepId);
    if (stepId === undefined) {
      this._logger.warn('DefaultSession._handleStepStart(); missing x-ably-step-id', {
        runId,
        serial: message.serial,
      });
      return;
    }

    const serial = message.serial;
    if (serial === undefined) {
      this._logger.warn('DefaultSession._handleStepStart(); inbound step-start missing serial', {
        runId,
        stepId,
      });
      return;
    }

    // A freshly observed step-start is canonical at insertion (Spec: AIT-CN2);
    // the tree's `applyStepStart` retires any prior canonical predecessors in
    // the same run.
    this._tree.applyStepStart({ id: stepId, runId, status: 'active', serial, canonical: true });
  }

  private _handleControlSignal(message: Ably.InboundMessage): void {
    const type = wireMessageNameToControlSignalType(message.name);
    if (type === undefined) {
      this._logger.warn('DefaultSession._handleControlSignal(); unrecognised name', {
        name: message.name,
        serial: message.serial,
      });
      return;
    }
    const runId = readHeader(message, Headers.RunId);
    if (runId === undefined) {
      this._logger.warn('DefaultSession._handleControlSignal(); missing x-ably-run-id', {
        type,
        serial: message.serial,
      });
      return;
    }
    const messageId = readHeader(message, Headers.MessageId);
    if (messageId === undefined) {
      this._logger.warn('DefaultSession._handleControlSignal(); missing x-ably-msg-id', {
        type,
        runId,
        serial: message.serial,
      });
      return;
    }
    const clientId = readHeader(message, Headers.ClientId) ?? message.clientId;
    if (clientId === undefined) {
      this._logger.warn('DefaultSession._handleControlSignal(); missing clientId', {
        type,
        runId,
        serial: message.serial,
      });
      return;
    }
    const stepId = readHeader(message, Headers.StepId);

    this._tree.applyControlSignal({
      type,
      runId,
      messageId,
      clientId,
      ...(stepId === undefined ? {} : { stepId }),
    });
  }

  private _handleRunEnd(message: Ably.InboundMessage): void {
    const runId = readHeader(message, Headers.RunId);
    if (runId === undefined) {
      this._logger.warn('DefaultSession._handleRunEnd(); missing x-ably-run-id', {
        serial: message.serial,
      });
      return;
    }

    const status = readHeader(message, Headers.Status);
    if (!isRunEndStatus(status)) {
      this._logger.warn('DefaultSession._handleRunEnd(); invalid x-ably-status', {
        runId,
        status,
        serial: message.serial,
      });
      return;
    }

    this._tree.applyRunEnd({ runId, status });
  }

  async close(): Promise<void> {
    this._logger.trace('DefaultSession.close();');

    if (this._closed) {
      return;
    }
    const channelResolved = this._channelManager.isResolved;
    this._closed = true;

    // Wake any pending `ClientRun.when` promises so they reject with
    // RunClosed rather than hanging after the session has shut down.
    // Fired before view teardown so the rejection lands while the run
    // handles still exist.
    this._closeController.abort();

    // Close every view created from this session before tearing down the
    // channel so consumers see a deterministic teardown order.
    for (const view of this._views) {
      view.close();
    }
    this._views.clear();

    try {
      // Only touch the channel if it was acquired — close() before connect()
      // and before any writer.publish is a true no-op on the realtime client.
      if (channelResolved) {
        const channel = this._channelManager.get();

        if (this._stateListener) {
          channel.off(this._stateListener);
          this._stateListener = undefined;
        }

        if (this._messageListener) {
          channel.unsubscribe(this._messageListener);
          this._messageListener = undefined;
        }

        try {
          await channel.detach();
        } catch (error) {
          // close() must never reject; surface detach failures via the logger.
          this._logger.warn('DefaultSession.close(); channel.detach() failed', { error });
        }

        this._channelManager.release();
      }

      this._emitter.off();
    } catch (error) {
      this._logger.warn('DefaultSession.close(); cleanup error', { error });
    }

    this._logger.debug('DefaultSession.close(); closed');
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  createView(): ClientView<C> {
    this._logger.trace('DefaultSession.createView();');
    if (this._closed) {
      throw new Ably.ErrorInfo('unable to create view; session is closed', ErrorCode.SessionClosed, 400);
    }
    const view = new DefaultClientView<C>({
      tree: this._tree,
      logger: this._logger,
      writer: this._writer,
      sessionName: this.sessionName,
      closeSignal: this._closeController.signal,
    });
    this._views.add(view);
    return view;
  }

  async createRun(invocation: Invocation, options?: CreateRunOptions): Promise<AgentRun<C>> {
    this._logger.trace('DefaultSession.createRun();', { runId: invocation.runId });
    if (this._closed) {
      throw new Ably.ErrorInfo('unable to create run; session is closed', ErrorCode.SessionClosed, 400);
    }
    if (invocation.sessionName !== this.sessionName) {
      throw new Ably.ErrorInfo(
        `unable to create run; invocation sessionName ${invocation.sessionName} does not match session ${this.sessionName}`,
        ErrorCode.InvalidArgument,
        400,
      );
    }

    await this._waitForRunPreconditions(invocation, options);

    return new DefaultAgentRun<C>({
      runId: invocation.runId,
      tree: this._tree,
      writer: this._writer,
      logger: this._logger,
      registerView: (view) => this._views.add(view),
    });
  }

  /**
   * Wait for the invocation's preconditions to be visible on the session's
   * tree — the run-start must have been observed (either via hydration or
   * live delivery), and when `invocation.messageId` is present the
   * corresponding message must also be visible.
   *
   * Resolves immediately when the preconditions are already satisfied;
   * otherwise subscribes to the tree and waits, bounded by
   * `options.timeoutMs` (default `60_000`) and `options.signal`.
   * @param invocation The invocation whose preconditions to satisfy.
   * @param options Per-call timeout and abort signal.
   */
  private async _waitForRunPreconditions(invocation: Invocation, options?: CreateRunOptions): Promise<void> {
    const isReady = (): boolean => {
      const run = this._tree.runs.find((r) => r.id === invocation.runId);
      if (run === undefined) {
        return false;
      }
      if (invocation.messageId !== undefined) {
        const messageVisible = this._tree.messages.some((m) => m.id === invocation.messageId);
        const signalVisible = run.controlSignals.some((s) => s.messageId === invocation.messageId);
        if (!messageVisible && !signalVisible) {
          return false;
        }
      }
      return true;
    };

    if (isReady()) {
      return;
    }

    if (options?.signal?.aborted === true) {
      throw this._preconditionTimeoutError(invocation, 'caller signal already aborted');
    }

    const timeoutMs = options?.timeoutMs ?? 60_000;

    // Mutable holders on a single object so the cleanup closure can capture
    // the refs while still satisfying `prefer-const` (the locals only ever
    // alias the holder; the holder fields take care of the lifetime).
    const handles: {
      unsubscribe?: () => void;
      timer?: ReturnType<typeof setTimeout>;
      onAbort?: () => void;
    } = {};

    const cleanup = (): void => {
      handles.unsubscribe?.();
      if (handles.timer !== undefined) {
        clearTimeout(handles.timer);
      }
      if (handles.onAbort !== undefined && options?.signal !== undefined) {
        options.signal.removeEventListener('abort', handles.onAbort);
      }
    };

    await new Promise<void>((resolve, reject) => {
      handles.timer = setTimeout(() => {
        cleanup();
        reject(this._preconditionTimeoutError(invocation, `timed out after ${String(timeoutMs)}ms`));
      }, timeoutMs);

      if (options?.signal !== undefined) {
        handles.onAbort = (): void => {
          cleanup();
          reject(this._preconditionTimeoutError(invocation, 'caller signal aborted'));
        };
        options.signal.addEventListener('abort', handles.onAbort, { once: true });
      }

      handles.unsubscribe = this._tree.subscribe(() => {
        if (isReady()) {
          cleanup();
          resolve();
        }
      });

      // Re-check after subscribing to close the race where the tree updated
      // between the synchronous `isReady()` above and the listener landing.
      if (isReady()) {
        cleanup();
        resolve();
      }
    });
  }

  private _preconditionTimeoutError(invocation: Invocation, reason: string): Ably.ErrorInfo {
    const messageIdSuffix = invocation.messageId === undefined ? '' : `, messageId=${invocation.messageId}`;
    return new Ably.ErrorInfo(
      `unable to create run; ${reason} waiting for invocation preconditions (runId=${invocation.runId}${messageIdSuffix})`,
      ErrorCode.InvocationPreconditionTimeout,
      408,
    );
  }

  get writer(): SessionWriter<C> {
    return this._writer;
  }

  on(event: 'error', handler: (error: Ably.ErrorInfo) => void): void {
    this._emitter.on(event, handler);
  }

  off(event: 'error', handler: (error: Ably.ErrorInfo) => void): void {
    this._emitter.off(event, handler);
  }
}

/**
 * Create a new {@link ClientSession}. The returned session is not yet live —
 * register listeners, then call {@link ClientSession.connect} to subscribe to
 * the channel.
 * @param options Wiring for the client, session name, codec, and optional logger.
 * @returns A not-yet-connected {@link ClientSession}.
 */
export const createClientSession = <C extends AnyCodec>(options: SessionOptions<C>): ClientSession<C> =>
  new DefaultSession<C>(options, 'client');

/**
 * Create a new {@link AgentSession}. The returned session is not yet live —
 * register listeners, then call {@link AgentSession.connect} to subscribe to
 * the channel and call {@link AgentSession.createRun} to bind to the run
 * named by the invocation.
 * @param options Wiring for the client, session name, codec, and optional logger.
 * @returns A not-yet-connected {@link AgentSession}.
 */
export const createAgentSession = <C extends AnyCodec>(options: SessionOptions<C>): AgentSession<C> =>
  new DefaultSession<C>(options, 'agent');
