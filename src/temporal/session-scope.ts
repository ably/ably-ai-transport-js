/**
 * The one place a Temporal activity gets a connected agent session.
 *
 * Every activity in a durable agent opens the same way: get a client, connect a
 * session for the invocation, do one thing, tear the session down. This binds
 * that shape to a codec, a client pool, a logger and the heartbeat pump once, so
 * every activity on a worker shares a single implementation and a single set of
 * connections.
 *
 * The session is detached rather than ended, which `withAgentSession` owns: a run
 * the body left open stays open on the wire, so a Temporal retry can adopt it and
 * publish a superseding step. Ending would mark the run terminal and every retry
 * would then fail.
 */

import type * as Ably from 'ably';

import type { Codec, CodecInputEvent, CodecOutputEvent } from '../core/codec/types.js';
import type { InvocationData } from '../core/transport/invocation.js';
import type { AgentSessionContext } from '../core/transport/types/agent.js';
import { withAgentSession } from '../core/transport/with-agent-session.js';
import type { Logger } from '../logger.js';
import { type ClientPool, createClientPool } from './client-pool.js';
import { withHeartbeat } from './heartbeat.js';

/** Configuration for {@link createSessionScope}. */
export interface SessionScopeOptions<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> {
  /** The codec every session in this scope encodes with. */
  codec: Codec<TInput, TOutput, TProjection, TMessage>;
  /** Builds one Ably client. Called only when the pool has none idle. */
  createClient: () => Ably.Realtime;
  /** Logger propagated into every session. */
  logger?: Logger;
  /** Connected clients the pool keeps open between activities. Defaults to 4. */
  maxIdle?: number;
}

/** A codec-bound source of connected agent sessions, backed by a client pool. */
export interface SessionScope<TOutput extends CodecOutputEvent, TProjection, TMessage> {
  /**
   * Run `body` against a connected session for `invocation`, on a leased client.
   *
   * The lease and the session are both torn down before this resolves, on the
   * success and the failure path alike.
   * @template T - The body's return type.
   * @param invocation - The invocation the session serves; its `sessionName` is the channel.
   * @param body - The work to run. Owns the run: it decides whether to create or
   *   adopt, whether to load, and publishes any run terminal itself.
   * @returns Whatever `body` returns.
   */
  inSession<T>(
    invocation: InvocationData,
    body: (context: AgentSessionContext<TOutput, TProjection, TMessage>) => Promise<T>,
  ): Promise<T>;
  /** Close every pooled connection. Call once, when the worker shuts down. */
  close(): Promise<void>;
}

class DefaultSessionScope<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> implements SessionScope<TOutput, TProjection, TMessage> {
  private readonly _codec: Codec<TInput, TOutput, TProjection, TMessage>;
  private readonly _logger: Logger | undefined;
  private readonly _scopeLogger: Logger | undefined;
  private readonly _pool: ClientPool;

  constructor(options: SessionScopeOptions<TInput, TOutput, TProjection, TMessage>) {
    this._codec = options.codec;
    this._logger = options.logger;
    this._scopeLogger = options.logger?.withContext({ component: 'SessionScope' });
    this._pool = createClientPool({
      createClient: options.createClient,
      ...(options.maxIdle !== undefined && { maxIdle: options.maxIdle }),
      ...(options.logger && { logger: options.logger }),
    });
  }

  async inSession<T>(
    invocation: InvocationData,
    body: (context: AgentSessionContext<TOutput, TProjection, TMessage>) => Promise<T>,
  ): Promise<T> {
    this._scopeLogger?.trace('SessionScope.inSession();', { sessionName: invocation.sessionName });
    // One channel per lease, which is what keeps two concurrent sessions off one
    // client's shared channel object.
    const lease = this._pool.acquire(invocation.sessionName);
    try {
      return await withHeartbeat(
        async () =>
          withAgentSession<TInput, TOutput, TProjection, TMessage, T>(
            {
              client: lease.client,
              invocation,
              codec: this._codec,
              ...(this._logger && { logger: this._logger }),
            },
            body,
          ),
        this._scopeLogger,
      );
    } finally {
      lease.release();
    }
  }

  async close(): Promise<void> {
    this._scopeLogger?.trace('SessionScope.close();');
    await this._pool.close();
  }
}

/**
 * Create the codec-bound session scope shared by a worker's activities.
 * @template TInput - The codec input event type.
 * @template TOutput - The codec output event type.
 * @template TProjection - The codec projection type.
 * @template TMessage - The codec message type.
 * @param options - Codec, client factory and pool behaviour.
 * @returns The scope. Close it when the worker shuts down.
 */
export const createSessionScope = <
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
>(
  options: SessionScopeOptions<TInput, TOutput, TProjection, TMessage>,
): SessionScope<TOutput, TProjection, TMessage> => new DefaultSessionScope(options);
