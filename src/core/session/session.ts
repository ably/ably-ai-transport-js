import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import { EventEmitter } from '../../event-emitter.js';
import type { Logger } from '../../logger.js';
import { LogLevel, makeLogger } from '../../logger.js';
import type { RealtimeWithOptions } from '../../realtime-extensions.js';
import { VERSION } from '../../version.js';
import type { AnyCodec } from '../codec/index.js';
import { ChannelManager } from './channel-manager.js';

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
 * Long-lived handle on a durable session from the client's perspective.
 *
 * Note: codec-aware reads (`tree`, `createView`) and the `writer` from the
 * RFC are not yet implemented and are intentionally omitted from this
 * scaffold. The codec type parameter from the RFC will be reintroduced once
 * those members land — today the session does not project the codec type
 * onto its surface.
 */
export interface ClientSession {
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
 * Long-lived handle on a durable session from the agent's perspective.
 *
 * Note: codec-aware reads (`tree`), `createRun`, and the `writer` from the
 * RFC are not yet implemented and are intentionally omitted from this
 * scaffold. The codec type parameter from the RFC will be reintroduced once
 * those members land.
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
 * {@link createAgentSession}. The two factories return the same underlying
 * object today — the differences land when codec-aware reads and writer
 * surfaces are introduced.
 */
class DefaultSession implements ClientSession, AgentSession {
  readonly sessionName: string;

  private readonly _realtime: Ably.Realtime;
  private readonly _logger: Logger;
  private readonly _channelManager: ChannelManager;
  private readonly _emitter: EventEmitter<SessionEvents>;

  private _connectPromise?: Promise<void>;
  private _stateListener?: (change: Ably.ChannelStateChange) => void;
  private _closed = false;
  private _channelInUse = false;

  constructor(options: SessionOptions<AnyCodec>, role: 'client' | 'agent') {
    this.sessionName = options.sessionName;
    this._realtime = options.client;

    this._logger = (options.logger ?? makeLogger({ logLevel: LogLevel.Silent })).withContext({
      component: 'Session',
      role,
      sessionName: options.sessionName,
    });
    this._emitter = new EventEmitter(this._logger);
    this._channelManager = new ChannelManager(this._realtime, this.sessionName, this._logger);

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
    this._channelInUse = true;

    await channel.attach();

    // Register the state listener only after attach succeeds — if attach
    // rejects, no listener is dangling on the channel for close() to clean up.
    this._stateListener = (change: Ably.ChannelStateChange) => {
      this._handleStateChange(change);
    };
    channel.on(['failed', 'detached'], this._stateListener);

    this._logger.debug('DefaultSession.connect(); channel attached');
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

  async close(): Promise<void> {
    this._logger.trace('DefaultSession.close();');

    if (this._closed) {
      return;
    }
    const channelInUse = this._channelInUse;
    this._closed = true;

    try {
      // Only touch the channel if connect() was attempted — otherwise close()
      // before connect() is a true no-op on the realtime client.
      if (channelInUse) {
        const channel = this._channelManager.get();

        if (this._stateListener) {
          channel.off(this._stateListener);
          this._stateListener = undefined;
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
 *
 * The codec is held on the session for forward compatibility but is unused
 * in this scaffold (no codec-aware reads or writes are implemented yet).
 * @param options Wiring for the client, session name, codec, and optional logger.
 * @returns A not-yet-connected {@link ClientSession}.
 */
export const createClientSession = <C extends AnyCodec>(options: SessionOptions<C>): ClientSession =>
  new DefaultSession(options, 'client');

/**
 * Create a new {@link AgentSession}. The returned session is not yet live —
 * register listeners, then call {@link AgentSession.connect} to subscribe to
 * the channel.
 *
 * The codec is held on the session for forward compatibility but is unused
 * in this scaffold (no codec-aware reads or writes are implemented yet).
 * @param options Wiring for the client, session name, codec, and optional logger.
 * @returns A not-yet-connected {@link AgentSession}.
 */
export const createAgentSession = <C extends AnyCodec>(options: SessionOptions<C>): AgentSession =>
  new DefaultSession(options, 'agent');
