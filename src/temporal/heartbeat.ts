/**
 * Activity heartbeating.
 *
 * Heartbeating is what makes activity cancellation work. Temporal reports a
 * cancellation request only in the response to a heartbeat, so an activity that
 * never heartbeats never learns it was cancelled and the cancellation signal the
 * SDK passes into its run can never fire. It also lets Temporal tell a slow
 * activity from a hung one, which matters most while paging channel history.
 *
 * Every activity the SDK runs heartbeats for that reason, with no way to turn it
 * off: the workflow shim declares a `heartbeatTimeout`, and Temporal kills an
 * activity that outlives it without reporting. The cost is one report per
 * throttle interval, because Temporal coalesces calls made inside one — the first
 * reports at once and later ones only overwrite the pending details.
 *
 * How quickly a cancellation arrives is set by that throttle, not by the interval
 * here. Temporal uses `heartbeatTimeout * 0.8` when the activity's options declare
 * a `heartbeatTimeout`, and `defaultHeartbeatThrottleInterval` (30 seconds) when
 * they do not. The workflow shim declares one for the framing activities; a
 * consumer's own activities need it in their `proxyActivities` options.
 */

import { Context } from '@temporalio/activity';

import type { Logger } from '../logger.js';

/** How often the pump reports when the activity declares no heartbeat timeout. */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;

/** The floor on a derived interval, so a tiny timeout cannot spin the pump. */
const MIN_HEARTBEAT_INTERVAL_MS = 1000;

/**
 * How often to report for the current activity: half its declared heartbeat
 * timeout, so a report always lands well inside it.
 *
 * Reading the context can throw when there is no activity, which is the case in
 * unit tests that call an activity body directly, so fall back rather than fail.
 * @returns The interval in milliseconds.
 */
const intervalMs = (): number => {
  try {
    const timeoutMs = Context.current().info.heartbeatTimeoutMs;
    if (timeoutMs === undefined || timeoutMs <= 0) return DEFAULT_HEARTBEAT_INTERVAL_MS;
    return Math.max(MIN_HEARTBEAT_INTERVAL_MS, Math.floor(timeoutMs / 2));
  } catch {
    return DEFAULT_HEARTBEAT_INTERVAL_MS;
  }
};

/**
 * Run `body`, reporting progress to Temporal while it runs.
 * @template T - The body's return type.
 * @param body - The work to run.
 * @param logger - Reports a pump that cannot heartbeat, which is worth knowing
 *   because cancellation arrives through the same channel.
 * @returns Whatever `body` returns.
 */
export const withHeartbeat = async <T>(body: () => Promise<T>, logger?: Logger): Promise<T> => {
  // Warn once rather than per tick: a pump that fails once fails every time, and
  // the interesting fact is that this activity cannot observe a cancel.
  let warned = false;

  const timer = setInterval(() => {
    // Best-effort: a heartbeat outside an activity context, or on an activity
    // Temporal has already given up on, must not fail the work itself.
    try {
      Context.current().heartbeat();
    } catch (error) {
      if (!warned) {
        warned = true;
        logger?.warn('withHeartbeat(); heartbeat failed, so a cancellation cannot reach this activity', { error });
      }
    }
  }, intervalMs());

  try {
    return await body();
  } finally {
    clearInterval(timer);
  }
};
