/**
 * The Temporal worker plugin.
 *
 * It does three jobs. It registers the framing activities, so a consumer never
 * writes or names them and the workflow-side shim can proxy them by type. It owns
 * the worker's pool of Ably connections for the life of `worker.run()`, which is
 * what `runWorker` is for. And it exposes `activity()`, the scaffold a consumer
 * wraps their own activity bodies in, bound to the same codec and the same pool.
 *
 * `configureReplayWorker` is deliberately absent: a replay worker runs no
 * activities, and the shim lives in the consumer's own workflow bundle because
 * their workflow module imports it, so replay needs nothing from here.
 */

import type { Worker, WorkerOptions, WorkerPlugin } from '@temporalio/worker';
import * as Ably from 'ably';

import type { Codec, CodecInputEvent, CodecOutputEvent } from '../core/codec/types.js';
import { ErrorCode } from '../errors.js';
import type { Logger } from '../logger.js';
import { createFramingActivities } from './activities.js';
import type { HistoryPaging, RunActivityBody, RunActivityFraming, RunActivityInput } from './run-activity.js';
import { createRunActivity } from './run-activity.js';
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
 * A Temporal worker plugin that registers Ably AI Transport's framing
 * activities, owns the worker's Ably connections, and wraps consumer activities.
 */
export interface AblyTransportPlugin<
  TOutput extends CodecOutputEvent = CodecOutputEvent,
  TProjection = unknown,
  TMessage = unknown,
> extends WorkerPlugin {
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
  /**
   * Wrap an activity body, with framing options.
   * @template TActivityInput - The activity's own input type, inferred from the body's `input` annotation.
   * @template TResult - What the activity returns to the workflow.
   * @param options - Framing options: how much conversation history to load.
   * @param body - The activity's own work, receiving the adopted run and its started step.
   * @returns The activity function to register on the worker.
   */
  activity<TActivityInput extends RunActivityInput, TResult>(
    options: RunActivityFraming,
    body: RunActivityBody<TOutput, TProjection, TMessage, TActivityInput, TResult>,
  ): (input: TActivityInput) => Promise<TResult>;
  /**
   * Wrap an activity body with the default framing.
   * @template TActivityInput - The activity's own input type, inferred from the body's `input` annotation.
   * @template TResult - What the activity returns to the workflow.
   * @param body - The activity's own work, receiving the adopted run and its started step.
   * @returns The activity function to register on the worker.
   */
  activity<TActivityInput extends RunActivityInput, TResult>(
    body: RunActivityBody<TOutput, TProjection, TMessage, TActivityInput, TResult>,
  ): (input: TActivityInput) => Promise<TResult>;
}

class DefaultAblyTransportPlugin<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> implements AblyTransportPlugin<TOutput, TProjection, TMessage> {
  private readonly _scope: SessionScope<TOutput, TProjection, TMessage>;
  private readonly _activities: FramingActivities;
  private readonly _paging: HistoryPaging;

  readonly name = '@ably/ai-transport';

  constructor(options: AblyTransportPluginOptions<TInput, TOutput, TProjection, TMessage>) {
    this._scope = createSessionScope<TInput, TOutput, TProjection, TMessage>({
      codec: options.codec,
      createClient: options.createClient,
      ...(options.logger && { logger: options.logger }),
      ...(options.maxIdle !== undefined && { maxIdle: options.maxIdle }),
    });
    this._paging = {
      ...(options.maxHistoryPages !== undefined && { maxHistoryPages: options.maxHistoryPages }),
      ...(options.historyPageSize !== undefined && { historyPageSize: options.historyPageSize }),
    };
    this._activities = createFramingActivities<TOutput, TProjection, TMessage>({
      scope: this._scope,
      ...(options.logger && { logger: options.logger }),
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

  activity<TActivityInput extends RunActivityInput, TResult>(
    options: RunActivityFraming,
    body: RunActivityBody<TOutput, TProjection, TMessage, TActivityInput, TResult>,
  ): (input: TActivityInput) => Promise<TResult>;
  activity<TActivityInput extends RunActivityInput, TResult>(
    body: RunActivityBody<TOutput, TProjection, TMessage, TActivityInput, TResult>,
  ): (input: TActivityInput) => Promise<TResult>;
  activity<TActivityInput extends RunActivityInput, TResult>(
    optionsOrBody: RunActivityFraming | RunActivityBody<TOutput, TProjection, TMessage, TActivityInput, TResult>,
    maybeBody?: RunActivityBody<TOutput, TProjection, TMessage, TActivityInput, TResult>,
  ): (input: TActivityInput) => Promise<TResult> {
    const bodyFirst = typeof optionsOrBody === 'function';
    const options = bodyFirst ? {} : optionsOrBody;
    const body = bodyFirst ? optionsOrBody : maybeBody;
    if (body === undefined) {
      throw new Ably.ErrorInfo('unable to wrap activity; body is required', ErrorCode.InvalidArgument, 400);
    }

    return createRunActivity<TOutput, TProjection, TMessage, TActivityInput, TResult>(
      this._scope,
      options,
      this._paging,
      body,
    );
  }
}

/**
 * Create the Temporal worker plugin.
 *
 * Pass the result in `Worker.create({ plugins: [...] })`, and call `activity()`
 * on it to wrap your own activity bodies. Both share one codec and one pool of
 * Ably connections. Your activities still go in `activities` as usual; the plugin
 * adds the framing ones to them.
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
): AblyTransportPlugin<TOutput, TProjection, TMessage> =>
  new DefaultAblyTransportPlugin<TInput, TOutput, TProjection, TMessage>(options);
