/**
 * Worker-lifetime pool of Ably clients, leased one channel at a time.
 *
 * Reusing a connected client saves an activity the WebSocket handshake and the
 * auth round trip. That matters because the churn is per-activity: a turn runs
 * several, and a worker runs up to `maxConcurrentActivityTaskExecutions` of them
 * at once.
 *
 * A lease is **exclusive, and owns one channel name**. That is the whole safety
 * argument. A session takes its channel from `client.channels.get(name)`, which
 * caches per name, and detaching a session detaches that channel — so two
 * concurrent sessions sharing a client on one channel would tear each other
 * down. An exclusive lease makes that state unreachable rather than merely
 * documented, and taking the channel name at `acquire` puts the invariant in the
 * type.
 *
 * Two properties of ably-js decide whether a client is fit to reuse, and a client
 * failing either is closed. The fallback therefore costs one handshake, which is
 * the price of not pooling at all.
 */

import * as Ably from 'ably';

import { ErrorCode } from '../errors.js';
import type { Logger } from '../logger.js';

/** Connected clients kept open between leases when the caller says nothing. */
const DEFAULT_MAX_IDLE = 4;

/**
 * How long {@link ClientPool.close} waits for one connection to report closed.
 * Bounded so a connection that never reports cannot hold up worker shutdown.
 */
const CLOSE_TIMEOUT_MS = 5000;

/** An exclusive loan of one client, for one channel. */
export interface ClientLease {
  /** The leased client. Valid until {@link ClientLease.release} is called. */
  readonly client: Ably.Realtime;
  /**
   * Hand the client back, dropping the channel this lease was taken for.
   *
   * The client is recycled when it is still fit, and closed otherwise. Call it
   * once; a second call throws, because a released client may already belong to
   * another lease.
   * @throws {@link Ably.ErrorInfo} with {@link ErrorCode.InvalidArgument} when the lease was already released.
   */
  release(): void;
}

/** A pool of Ably clients, leased per activity. */
export interface ClientPool {
  /**
   * Lease a client for one channel.
   *
   * Never blocks and never caps concurrency: a burst larger than the pool builds
   * fresh clients rather than queueing. During a burst the open count reaches
   * peak concurrency; between bursts it settles at `maxIdle`.
   * @param channelName - The single channel this lease is for.
   * @returns The lease. Release it when the work is done.
   * @throws {@link Ably.ErrorInfo} with {@link ErrorCode.SessionClosed} when the pool is closed.
   */
  acquire(channelName: string): ClientLease;
  /**
   * Close every client the pool holds and wait for their connections to tear
   * down. Idempotent.
   */
  close(): Promise<void>;
}

/** Configuration for {@link createClientPool}. */
export interface ClientPoolOptions {
  /** Builds one client. Called whenever no idle client is available. */
  createClient: () => Ably.Realtime;
  /**
   * How many connected clients to keep open between leases. `0` closes every
   * client on release, which disables reuse. Defaults to 4.
   */
  maxIdle?: number;
  /** Logger for recycle decisions. */
  logger?: Logger;
}

class DefaultClientPool implements ClientPool {
  private readonly _createClient: () => Ably.Realtime;
  private readonly _maxIdle: number;
  private readonly _logger: Logger | undefined;

  /** Connected clients available for the next lease. */
  private readonly _idle: Ably.Realtime[] = [];
  /** Clients currently on loan, so `close` knows not to expect them back. */
  private readonly _leased = new Set<Ably.Realtime>();
  /** In-flight teardowns, retained only so `close` can await them. */
  private readonly _teardowns = new Set<Promise<void>>();
  private _closed = false;

  constructor(options: ClientPoolOptions) {
    const maxIdle = options.maxIdle ?? DEFAULT_MAX_IDLE;
    if (!Number.isInteger(maxIdle) || maxIdle < 0) {
      throw new Ably.ErrorInfo(
        `unable to create client pool; maxIdle must be a non-negative integer, got ${String(maxIdle)}`,
        ErrorCode.InvalidArgument,
        400,
      );
    }
    this._createClient = options.createClient;
    this._maxIdle = maxIdle;
    this._logger = options.logger?.withContext({ component: 'ClientPool' });
  }

  acquire(channelName: string): ClientLease {
    if (this._closed) {
      throw new Ably.ErrorInfo('unable to acquire client; pool is closed', ErrorCode.SessionClosed, 400);
    }
    this._logger?.trace('ClientPool.acquire();', { channelName, idle: this._idle.length });

    const client = this._takeIdle() ?? this._createClient();
    this._leased.add(client);

    let released = false;
    return {
      client,
      release: (): void => {
        if (released) {
          throw new Ably.ErrorInfo('unable to release lease; it was already released', ErrorCode.InvalidArgument, 400);
        }
        released = true;
        this._leased.delete(client);
        this._recycle(client, channelName);
      },
    };
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this._logger?.trace('ClientPool.close();', { idle: this._idle.length, leased: this._leased.size });

    for (const client of this._idle.splice(0)) this._closeClient(client);

    // `runWorker`'s teardown runs after the worker has finished shutting down, by
    // which point Temporal has cancelled every activity and its lease is back —
    // so this loop is normally empty. A lease still out means an activity is
    // wedged, and leaking its socket would stop the process exiting, so close it
    // and say so.
    if (this._leased.size > 0) {
      this._logger?.warn('ClientPool.close(); closing clients that are still leased', { leased: this._leased.size });
    }
    for (const client of this._leased) this._closeClient(client);
    this._leased.clear();

    // `Promise.all` consumes the iterable before it awaits anything, so this
    // snapshots the teardowns even though each one removes itself as it settles.
    await Promise.all(this._teardowns);
  }

  /**
   * Take the newest idle client that is still connected, closing any that
   * degraded while parked.
   *
   * A connection can drop at any time, including while nobody holds it, and the
   * checks `_recycle` applies say why an unconnected client must not be handed
   * out. Nothing evicts a parked client when its connection changes, so the check
   * belongs here too.
   * @returns A connected client, or undefined when none is available.
   */
  private _takeIdle(): Ably.Realtime | undefined {
    for (let client = this._idle.pop(); client !== undefined; client = this._idle.pop()) {
      if (client.connection.state === 'connected') return client;
      this._logger?.debug('ClientPool._takeIdle(); discarding a parked client that lost its connection', {
        state: client.connection.state,
      });
      this._closeClient(client);
    }
    return undefined;
  }

  /**
   * Decide whether a returned client is fit to reuse, and either pool it or
   * close it.
   * @param client - The returned client.
   * @param channelName - The channel this lease was taken for.
   */
  private _recycle(client: Ably.Realtime, channelName: string): void {
    // ably-js drops the channel synchronously only when it is already
    // INITIALIZED, DETACHED or FAILED; any other state defers the delete into a
    // promise callback. A client re-leased inside that window would hand the next
    // session the doomed channel object, and its later removal from
    // `channels.all` silently stops inbound messages reaching it — the session
    // attaches and then hears nothing. So require the drop to have happened.
    // The happy path passes: the session's teardown awaits its detach, so the
    // channel is DETACHED by the time this runs.
    client.channels.release(channelName);
    const channelSurvived = client.channels.all[channelName] !== undefined;

    // Only a connected client is worth keeping. On a suspended or closed
    // connection the next attach rejects outright, and on a disconnected one it
    // stays pending with no timeout until the connection recovers or degrades —
    // far more than the handshake this reuse saves.
    const state = client.connection.state;
    const reusable = !this._closed && !channelSurvived && state === 'connected';

    if (!reusable || this._idle.length >= this._maxIdle) {
      this._logger?.debug('ClientPool._recycle(); closing client', {
        channelName,
        channelSurvived,
        state,
        idle: this._idle.length,
      });
      this._closeClient(client);
      return;
    }

    this._logger?.trace('ClientPool._recycle(); client pooled', { channelName, idle: this._idle.length + 1 });
    this._idle.push(client);
  }

  /**
   * Close a client and retain its teardown so {@link close} can await it.
   * @param client - The client to close.
   */
  private _closeClient(client: Ably.Realtime): void {
    // Register before closing, so a connection that reports closed synchronously
    // is still observed.
    const teardown = this._awaitClosed(client);
    this._teardowns.add(teardown);
    // Fire-and-forget: the promise is retained only for `close` to await, and
    // `_awaitClosed` never rejects, so nothing here can go unhandled.
    void teardown.finally(() => {
      this._teardowns.delete(teardown);
    });
    client.close();
  }

  /**
   * Resolve once a client's connection reports closed or failed, or the timeout
   * expires. Never rejects.
   * @param client - The client being closed.
   */
  private async _awaitClosed(client: Ably.Realtime): Promise<void> {
    const { connection } = client;
    if (connection.state === 'closed' || connection.state === 'failed') return;

    await new Promise<void>((resolve) => {
      const onSettled = (): void => {
        clearTimeout(timer);
        connection.off(onSettled);
        resolve();
      };
      // `on` rather than `once`: only `on` takes a list of events, and
      // `onSettled` deregisters itself, so it fires at most once either way.
      connection.on(['closed', 'failed'], onSettled);
      const timer = setTimeout(() => {
        connection.off(onSettled);
        this._logger?.warn('ClientPool._awaitClosed(); connection did not report closed in time');
        resolve();
      }, CLOSE_TIMEOUT_MS);
    });
  }
}

/**
 * Create a pool of Ably clients leased one channel at a time.
 * @param options - The client factory, how many clients to keep idle, and a logger.
 * @returns The pool. Close it when the process is shutting down.
 * @throws {@link Ably.ErrorInfo} with {@link ErrorCode.InvalidArgument} when `maxIdle` is not a non-negative integer.
 */
export const createClientPool = (options: ClientPoolOptions): ClientPool => new DefaultClientPool(options);
