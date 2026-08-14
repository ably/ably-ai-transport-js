/**
 * The Temporal worker plugin.
 *
 * It does two jobs. It registers the framing activities, so a consumer never
 * writes or names them and the workflow-side shim can proxy them by type. It owns
 * the worker's pool of Ably connections for the life of `worker.run()`, which is
 * what `runWorker` is for.
 *
 * `configureReplayWorker` is deliberately absent: a replay worker runs no
 * activities, and the shim lives in the consumer's own workflow bundle because
 * their workflow module imports it, so replay needs nothing from here.
 */

import type { Worker, WorkerOptions, WorkerPlugin } from '@temporalio/worker';
import type * as Ably from 'ably';

import type { Codec, CodecInputEvent, CodecOutputEvent } from '../core/codec/types.js';
import type { Logger } from '../logger.js';
import { createFramingActivities } from './activities.js';
import { createSessionScope, type SessionScope } from './session-scope.js';
import type { FramingActivities } from './workflow/activity-types.js';

/** Options for {@link createAblyTransportPlugin}. */
export interface AblyTransportPluginOptions<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> {
  /** The codec every session on this worker encodes with. */
  codec: Codec<TInput, TOutput, TProjection, TMessage>;
  /**
   * Builds one Ably client. Called only when the connection pool has none idle,
   * so it is not once per activity. The SDK never reads your environment or
   * constructs clients for you.
   */
  createClient: () => Ably.Realtime;
  /** Logger propagated into every session. */
  logger?: Logger;
  /** Report progress to Temporal while an activity runs. Defaults to false. */
  heartbeat?: boolean;
  /**
   * How many connected Ably clients to keep open between activities. `0` closes
   * every client on release, which disables connection reuse. Defaults to 4.
   */
  maxIdle?: number;
  /** Most history pages `openRun` fetches before giving up. */
  maxHistoryPages?: number;
  /** CodecMessages revealed per history page. */
  historyPageSize?: number;
}

/**
 * A Temporal worker plugin that registers Ably AI Transport's framing activities
 * and owns the worker's Ably connections.
 */
export interface AblyTransportPlugin extends WorkerPlugin {
  /** Identifies the plugin in Temporal's worker diagnostics. */
  readonly name: string;
  /**
   * Adds the framing activities to the worker's registration.
   * @param options - The worker options assembled so far.
   * @returns The options with the framing activities registered.
   */
  configureWorker(options: WorkerOptions): WorkerOptions;
  /**
   * Runs the worker, closing the pooled Ably connections once it stops.
   * @param worker - The worker Temporal built.
   * @param next - Runs the worker.
   */
  runWorker(worker: Worker, next: (worker: Worker) => Promise<void>): Promise<void>;
}

class DefaultAblyTransportPlugin<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> implements AblyTransportPlugin {
  private readonly _scope: SessionScope<TOutput, TProjection, TMessage>;
  private readonly _activities: FramingActivities;

  readonly name = '@ably/ai-transport';

  constructor(options: AblyTransportPluginOptions<TInput, TOutput, TProjection, TMessage>) {
    this._scope = createSessionScope<TInput, TOutput, TProjection, TMessage>({
      codec: options.codec,
      createClient: options.createClient,
      ...(options.logger && { logger: options.logger }),
      ...(options.heartbeat !== undefined && { heartbeat: options.heartbeat }),
      ...(options.maxIdle !== undefined && { maxIdle: options.maxIdle }),
    });
    this._activities = createFramingActivities<TOutput, TProjection, TMessage>({
      scope: this._scope,
      ...(options.logger && { logger: options.logger }),
      ...(options.heartbeat !== undefined && { heartbeat: options.heartbeat }),
      ...(options.maxHistoryPages !== undefined && { maxHistoryPages: options.maxHistoryPages }),
      ...(options.historyPageSize !== undefined && { historyPageSize: options.historyPageSize }),
    });
  }

  configureWorker(options: WorkerOptions): WorkerOptions {
    // Plugin activities last, so the SDK's registration wins a name clash. A
    // consumer keeping their own `openRun` must rename it.
    return { ...options, activities: { ...options.activities, ...this._activities } };
  }

  async runWorker(worker: Worker, next: (worker: Worker) => Promise<void>): Promise<void> {
    try {
      await next(worker);
    } finally {
      // Reached after the worker has finished shutting down, so every activity
      // has been cancelled and handed its connection back.
      await this._scope.close();
    }
  }
}

/**
 * Create the Temporal worker plugin.
 *
 * Pass the result in `Worker.create({ plugins: [...] })`. Your activities still go
 * in `activities` as usual; the plugin adds the framing ones to them.
 * @template TInput - The codec input event type.
 * @template TOutput - The codec output event type.
 * @template TProjection - The codec projection type.
 * @template TMessage - The codec message type.
 * @param options - Codec, client factory, heartbeat, pool and paging behaviour.
 * @returns The plugin to register on a worker.
 */
export const createAblyTransportPlugin = <
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
>(
  options: AblyTransportPluginOptions<TInput, TOutput, TProjection, TMessage>,
): AblyTransportPlugin => new DefaultAblyTransportPlugin<TInput, TOutput, TProjection, TMessage>(options);
