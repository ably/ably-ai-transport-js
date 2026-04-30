import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import { EventEmitter } from '../../event-emitter.js';
import { Headers, readHeader, WireMessages } from '../../headers.js';
import type { Logger } from '../../logger.js';
import { LogLevel, makeLogger } from '../../logger.js';
import type { RealtimeWithOptions } from '../../realtime-extensions.js';
import { VERSION } from '../../version.js';
import type { Accumulator, AnyCodec, CodecEvent, CodecMessage, CodecPart, Decoder } from '../codec/index.js';
import type { Run, RunStatus } from '../run/index.js';
import type { MessageNode, TreeInternal } from '../tree/index.js';
import { DefaultTree } from '../tree/index.js';
import type { ClientView } from '../view/index.js';
import { DefaultView } from '../view/index.js';
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
 * transition into via `applyRunEnd`. Phase 5 only accepts `'complete'`;
 * later phases widen this guard alongside the writer surfaces that
 * produce `'aborted'` and `'failed'`.
 * @param value The raw header value.
 * @returns True when `value` is a recognised run-end status.
 */
const isRunEndStatus = (value: string | undefined): value is RunStatus => value === 'complete';

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
 * Long-lived handle on a durable session from the agent's perspective.
 *
 * Phase 2 surface — connect/close lifecycle and error events. `createRun`,
 * `tree`, and `writer` from the RFC are deferred to later phases.
 */
export interface AgentSession {
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
class DefaultSession<C extends AnyCodec> implements ClientSession<C>, AgentSession {
  readonly sessionName: string;

  private readonly _realtime: Ably.Realtime;
  private readonly _logger: Logger;
  private readonly _channelManager: ChannelManager;
  private readonly _emitter: EventEmitter<SessionEvents>;
  private readonly _codec: C;
  private readonly _tree: TreeInternal<CodecMessage<C>>;
  private readonly _views = new Set<DefaultView<CodecMessage<C>>>();
  private readonly _writer: DefaultSessionWriter<C>;

  private _decoder?: Decoder<CodecPart<C>, CodecEvent<C>>;
  private _accumulator?: Accumulator<CodecPart<C>, CodecMessage<C>, CodecEvent<C>>;

  private _connectPromise?: Promise<void>;
  private _stateListener?: (change: Ably.ChannelStateChange) => void;
  private _messageListener?: (message: Ably.InboundMessage) => void;
  private _closed = false;

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

    this._messageListener = (message: Ably.InboundMessage) => {
      this._handleInboundMessage(message);
    };
    await channel.subscribe(this._messageListener);

    this._logger.debug('DefaultSession.connect(); channel attached and subscribed');
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
    if (message.name === WireMessages.RunEnd) {
      this._handleRunEnd(message);
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
      // Phase 2 only routes streaming parts. Codec events land in later phases
      // alongside the writer surfaces that produce them.
      if (value.kind !== 'part') {
        continue;
      }

      const messageId = value.messageId ?? wireMessageId;
      this._accumulator.processPart(value.part, messageId);
      const composed = this._accumulator.getMessage(messageId);
      if (composed === undefined) {
        continue;
      }

      // Phase 2's tree is append-only — the accumulator above has already
      // recorded this part, but the tree gains an update path in a later phase.
      // Skip the duplicate insert; the accumulator state stays current.
      if (this._tree.messages.some((node) => node.id === messageId)) {
        continue;
      }

      const node: MessageNode<CodecMessage<C>> = {
        id: messageId,
        role,
        clientId,
        message: composed,
        serial,
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

    const run: Run<CodecMessage<C>> = { id: runId, status: 'active', initiatorClientId };
    this._tree.applyRunStart(run);
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
    const view = new DefaultView<CodecMessage<C>>({ tree: this._tree, logger: this._logger });
    this._views.add(view);
    return view;
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
 * the channel.
 *
 * The codec is held on the session for forward compatibility but is unused
 * in this scaffold (the agent-side writer and `createRun` land in later
 * phases).
 * @param options Wiring for the client, session name, codec, and optional logger.
 * @returns A not-yet-connected {@link AgentSession}.
 */
export const createAgentSession = <C extends AnyCodec>(options: SessionOptions<C>): AgentSession =>
  new DefaultSession<C>(options, 'agent');
