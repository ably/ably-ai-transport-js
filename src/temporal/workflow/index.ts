/**
 * Workflow-side shim for the Ably AI Transport Temporal plugin.
 *
 * Import this from workflow code. It proxies the framing activities the plugin
 * registers, so a workflow reads as run lifecycle rather than `proxyActivities`
 * plumbing:
 *
 * ```ts
 * await withRun(input.invocation, async (run) => {
 *   let outcome = await myInference(run.ids);
 *   // ...
 * });
 * ```
 *
 * Everything here runs inside Temporal's workflow sandbox, so this module must
 * stay deterministic and must not import anything worker-side. `ably` and
 * `@temporalio/activity` are unavailable here; the only runtime dependency is
 * `@temporalio/workflow`. The activity contract arrives as types alone.
 *
 * The plugin must be registered on the worker, otherwise Temporal fails the
 * first framing activity with "activity type not registered".
 */

import { type ActivityOptions, CancellationScope, proxyActivities, workflowInfo } from '@temporalio/workflow';

import type { InvocationData } from '../../core/transport/invocation.js';
import type { RunEndReason } from '../../core/transport/types/shared.js';
import type { RunIdentity } from '../../core/transport/types/transport.js';
import type { FramingActivities } from './activity-types.js';

/**
 * Activity options per framing activity, each merged over `default`, which is in
 * turn merged over the SDK's own defaults.
 */
export interface RunActivityOptions {
  /** Applied to every framing activity unless overridden below. */
  default?: ActivityOptions;
  /** Overrides for opening the run. */
  openRun?: ActivityOptions;
  /** Overrides for publishing the run's terminal. */
  endRun?: ActivityOptions;
  /** Overrides for suspending the run. */
  suspendRun?: ActivityOptions;
  /** Overrides for the failure-path cleanup. */
  cleanupRun?: ActivityOptions;
}

/** Options for {@link openRun} and {@link withRun}. */
export interface OpenRunOptions {
  /**
   * The run's invocation id. Used as the run id too, so a fresh-process retry
   * re-enters the same run. Defaults to the workflow id.
   *
   * Whatever is passed must be stable across retries and distinct per turn, so
   * the default only holds where one workflow serves one turn. A workflow
   * serving several turns keeps one workflow id across all of them, and must
   * pass a per-turn id here or every turn folds onto the first one's run.
   */
  invocationId?: string;
  /** Per-activity timeouts and retry policies. */
  activityOptions?: RunActivityOptions;
}

/**
 * A handle on an open run, held in workflow state.
 *
 * Carries plain data plus calls that schedule activities. It never holds a live
 * Ably session — each activity builds and tears down its own.
 */
export interface RunHandle {
  /** The run's identity, to thread through the application's own activities. */
  readonly ids: RunIdentity;
  /**
   * Publish the run's terminal.
   *
   * Costs a fresh adopt and load, because the activity is a new process. Ending
   * inside an activity that already has the run loaded is free, and is the
   * cheaper of the two styles.
   * @param params - The terminal to publish.
   * @param params.reason - The terminal reason.
   * @param params.errorMessage - Message for the published error, used only when `reason` is `'error'`.
   */
  end(params: { reason: RunEndReason; errorMessage?: string }): Promise<void>;
  /**
   * Publish `ai-run-suspend`.
   *
   * Fails if a step is still open, since suspending mid-step would strand the
   * step bracket.
   */
  suspend(): Promise<void>;
  /**
   * Best-effort failure cleanup: end the run as `error` so a waiting client
   * unsticks. Does nothing if the run already finished or is parked suspended.
   * @param errorMessage - Message for the published error.
   */
  cleanup(errorMessage?: string): Promise<void>;
}

/** Applied to the three activities the workflow drives deliberately. */
const DEFAULT_ACTIVITY_OPTIONS: ActivityOptions = {
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 3 },
};

/**
 * Cleanup is best-effort and must not hold up a terminate: one attempt, tight
 * timeout.
 */
const CLEANUP_ACTIVITY_OPTIONS: ActivityOptions = {
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 1 },
};

/**
 * Resolve one activity's options: the SDK default, then the caller's `default`,
 * then their per-activity override.
 * @param name - Which framing activity the options are for.
 * @param base - The SDK default for this activity.
 * @param overrides - The caller's per-activity options.
 * @returns The merged options to hand to `proxyActivities`.
 */
const optionsFor = (
  name: keyof FramingActivities,
  base: ActivityOptions,
  overrides: RunActivityOptions | undefined,
): ActivityOptions => ({ ...base, ...overrides?.default, ...overrides?.[name] });

/**
 * Open a run: create it, locate its trigger, and publish its opening event.
 *
 * "Open" covers two cases. A fresh turn creates a run and publishes
 * `ai-run-start`. A continuation RESUMES the run its trigger names, publishing
 * `ai-run-resume` — so this does not always mean a new run. The SDK tells them
 * apart from the trigger's `run-id` header, which is also why the run-id pinning
 * below only applies to a fresh run.
 * @param invocation - The invocation the client POSTed.
 * @param options - Activity options, and the invocation id to pin the run to.
 * @returns A handle on the open run.
 */
export const openRun = async (invocation: InvocationData, options: OpenRunOptions = {}): Promise<RunHandle> => {
  const overrides = options.activityOptions;
  // One proxy per activity so each carries its own options. Read each function
  // off its proxy by name — `proxyActivities` returns a Proxy with no own
  // properties, so spreading it would yield nothing. Concrete `Pick`s rather
  // than a generic helper: Temporal's proxy return type is conditional on the
  // activity signature and does not resolve through a type parameter.
  const activities = {
    openRun: proxyActivities<Pick<FramingActivities, 'openRun'>>(
      optionsFor('openRun', DEFAULT_ACTIVITY_OPTIONS, overrides),
    ).openRun,
    endRun: proxyActivities<Pick<FramingActivities, 'endRun'>>(
      optionsFor('endRun', DEFAULT_ACTIVITY_OPTIONS, overrides),
    ).endRun,
    suspendRun: proxyActivities<Pick<FramingActivities, 'suspendRun'>>(
      optionsFor('suspendRun', DEFAULT_ACTIVITY_OPTIONS, overrides),
    ).suspendRun,
    cleanupRun: proxyActivities<Pick<FramingActivities, 'cleanupRun'>>(
      optionsFor('cleanupRun', CLEANUP_ACTIVITY_OPTIONS, overrides),
    ).cleanupRun,
  };

  const ids = await activities.openRun({
    invocation,
    invocationId: options.invocationId ?? workflowInfo().workflowId,
  });

  return {
    ids,
    end: async (params) => {
      await activities.endRun({
        ids,
        invocation,
        reason: params.reason,
        ...(params.errorMessage !== undefined && { errorMessage: params.errorMessage }),
      });
    },
    suspend: async () => {
      await activities.suspendRun({ ids, invocation });
    },
    cleanup: async (errorMessage) => {
      await activities.cleanupRun({ ids, invocation, ...(errorMessage !== undefined && { errorMessage }) });
    },
  };
};

/**
 * Open a run, run `body` against it, and make a best-effort attempt to close the
 * run if `body` fails.
 *
 * That attempt is the point: an unclosed run leaves the client waiting on a
 * stream that never ends, and remembering to clean up by hand is the easiest
 * part of a durable agent to forget. It runs in a non-cancellable scope, so a
 * cancelled or terminated workflow still closes its run, and its own failure is
 * swallowed so `body`'s error reaches Temporal unmasked.
 *
 * Best-effort, not guaranteed, and deliberately so. Cleanup gets one attempt
 * with a short timeout — retrying would let a hanging cleanup hold up a
 * terminate — and it no-ops when the run is already terminal or parked
 * suspended. It also only fires on a throw: a `body` that returns without
 * publishing a terminal leaves the run open.
 *
 * On success nothing is published: the application publishes its own terminal,
 * which is free inside an activity that already has the run loaded.
 * @template T - The body's return type.
 * @param invocation - The invocation the client POSTed.
 * @param body - The turn's work. Receives the run handle.
 * @returns Whatever `body` returns.
 */
export function withRun<T>(invocation: InvocationData, body: (run: RunHandle) => Promise<T>): Promise<T>;
/**
 * Open a run with explicit options, run `body` against it, and make a
 * best-effort attempt to close the run if `body` fails.
 * @template T - The body's return type.
 * @param invocation - The invocation the client POSTed.
 * @param options - Activity options, and the invocation id to pin the run to.
 * @param body - The turn's work. Receives the run handle.
 * @returns Whatever `body` returns.
 */
export function withRun<T>(
  invocation: InvocationData,
  options: OpenRunOptions,
  body: (run: RunHandle) => Promise<T>,
): Promise<T>;
export async function withRun<T>(
  invocation: InvocationData,
  ...rest: [(run: RunHandle) => Promise<T>] | [OpenRunOptions, (run: RunHandle) => Promise<T>]
): Promise<T> {
  const [options, body] = rest.length === 1 ? [{}, rest[0]] : rest;

  // Deliberately outside the try: if opening fails there is no run to clean up.
  const run = await openRun(invocation, options);

  try {
    return await body(run);
  } catch (error) {
    await CancellationScope.nonCancellable(async () => {
      try {
        await run.cleanup(error instanceof Error ? error.message : 'workflow failed');
      } catch {
        /* best-effort — `body`'s error is the one that matters */
      }
    });
    throw error;
  }
}

export type {
  CleanupRunInput,
  EndRunInput,
  FramingActivities,
  OpenRunInput,
  SuspendRunInput,
} from './activity-types.js';
