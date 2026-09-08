/**
 * Activity heartbeating for the framing activities.
 *
 * Temporal kills an activity that outlives its timeout, and cannot otherwise
 * tell a slow one from a hung one. Paging channel history is the slow part of a
 * framing activity.
 *
 * Heartbeating also carries Temporal's own cancellation to the activity.
 * `@temporalio/activity` states the rule: "Activities can only receive
 * Cancellation if they emit heartbeats or are Local Activities". So a workflow
 * cancelled through `WorkflowHandle.cancel()`, the CLI or the Web UI reaches
 * `Context.current().cancellationSignal` only while this pump is beating. A
 * worker shutdown is the one cancel that arrives without a beat, because the
 * worker raises that locally rather than learning it from the server. A
 * client's `ai-cancel` message is a different path again: the transport routes
 * that onto the run from the channel and it needs none of this.
 *
 * On by default for that reason, and gated on the activity's own heartbeat
 * timeout — see {@link beat}.
 */

import { Context } from '@temporalio/activity';

/** How often the pump reports progress while it is beating. */
const HEARTBEAT_INTERVAL_MS = 5000;

/**
 * Whether the activity in scope is permitted to heartbeat.
 *
 * Temporal's contract is per activity, not per worker: `Info.heartbeatTimeoutMs`
 * documents that "if this timeout is defined, the Activity must heartbeat
 * before the timeout is reached. The Activity must **not** heartbeat in case
 * this timeout is not defined." So the option to heartbeat is a request, and
 * the activity's own timeout decides whether it is honoured.
 *
 * The test for "defined" is a positive number, not merely a present one. An
 * activity scheduled without a heartbeat timeout reports it as `0` rather than
 * `undefined` — the proto's zero Duration survives the conversion — so an
 * `undefined` check alone would beat on exactly the activity the contract
 * forbids. A zero deadline could never be met anyway.
 * @returns True when the activity has a heartbeat timeout to beat against.
 */
const heartbeatPermitted = (): boolean => {
  try {
    const timeoutMs = Context.current().info.heartbeatTimeoutMs;
    return timeoutMs !== undefined && timeoutMs > 0;
  } catch {
    // No activity context, so there is nothing to report progress to. Treated
    // as "not permitted" rather than thrown: heartbeating is never the work.
    return false;
  }
};

/**
 * Report progress to Temporal once, if the activity's options permit it.
 *
 * Safe to call anywhere inside a framing activity, including from the
 * transport's per-page scan hook. A beat on an activity Temporal has already
 * given up on, or outside an activity context, is swallowed: the activity's own
 * timeout still governs, and a failed beat must not fail the work.
 */
export const beat = (): void => {
  if (!heartbeatPermitted()) return;
  try {
    Context.current().heartbeat();
  } catch {
    /* not fatal — the activity's own timeout still governs */
  }
};

/**
 * Run `body`, reporting progress to Temporal while it runs.
 *
 * Starts no timer when `enabled` is false, or when the activity has no
 * heartbeat timeout to beat against, so a caller can wrap unconditionally.
 * @template T - The body's return type.
 * @param enabled - Whether the caller asked for heartbeating.
 * @param body - The work to run.
 * @returns Whatever `body` returns.
 */
export const withHeartbeat = async <T>(enabled: boolean, body: () => Promise<T>): Promise<T> => {
  if (!enabled || !heartbeatPermitted()) return body();

  const timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);

  try {
    return await body();
  } finally {
    clearInterval(timer);
  }
};
