/**
 * The Temporal worker plugin.
 *
 * Registers the framing activities so a consumer never writes or names them, and
 * so the workflow-side shim can proxy them by type. Only `configureWorker` is
 * implemented: a replay worker runs no activities, and the shim lives in the
 * consumer's own workflow bundle because their workflow module imports it, so
 * replay needs nothing from here.
 */

import type { WorkerOptions, WorkerPlugin } from '@temporalio/worker';

import { createFramingActivities, type FramingActivitiesOptions } from './activities.js';
import type { FramingActivities } from './workflow/activity-types.js';

/** Options for {@link createAblyTransportPlugin}. */
export type AblyTransportPluginOptions<TInput, TOutput> = FramingActivitiesOptions<TInput, TOutput>;

/**
 * A Temporal worker plugin that registers Ably AI Transport's framing
 * activities.
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
}

class DefaultAblyTransportPlugin implements AblyTransportPlugin {
  private readonly _activities: FramingActivities;

  readonly name = '@ably/ai-transport';

  constructor(options: { activities: FramingActivities }) {
    this._activities = options.activities;
  }

  configureWorker(options: WorkerOptions): WorkerOptions {
    // Plugin activities last, so the SDK's registration wins a name clash. A
    // consumer keeping their own `openRun` must rename it.
    return { ...options, activities: { ...options.activities, ...this._activities } };
  }
}

/**
 * Create the Temporal worker plugin.
 *
 * Pass the result in `Worker.create({ plugins: [...] })`. The consumer's own
 * activities still go in `activities` as usual; the plugin adds to them.
 * @template TInput - The codec's input-event domain type.
 * @template TOutput - The codec's output-event domain type.
 * @param options - Codec, client factory, and paging behaviour.
 * @returns The plugin to register on a worker.
 */
export const createAblyTransportPlugin = <TInput, TOutput>(
  options: AblyTransportPluginOptions<TInput, TOutput>,
): AblyTransportPlugin => new DefaultAblyTransportPlugin({ activities: createFramingActivities(options) });
