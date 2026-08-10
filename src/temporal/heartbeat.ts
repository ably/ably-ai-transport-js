/**
 * Optional activity heartbeating.
 *
 * Temporal kills an activity that outlives its timeout, and cannot otherwise
 * tell a slow one from a hung one. Paging channel history is the slow part of a
 * framing activity, and most of that paging happens inside the transport where
 * there is no per-page hook, so the pump is time-based rather than per-page.
 *
 * Off by default: a short conversation pages once and gains nothing from the
 * extra traffic.
 */

import { Context } from '@temporalio/activity';

/** How often the pump reports progress while enabled. */
const HEARTBEAT_INTERVAL_MS = 5000;

/**
 * Run `body`, reporting progress to Temporal while it runs.
 *
 * A no-op wrapper when `enabled` is false, so a caller can wrap
 * unconditionally.
 * @template T - The body's return type.
 * @param enabled - Whether to heartbeat.
 * @param body - The work to run.
 * @returns Whatever `body` returns.
 */
export const withHeartbeat = async <T>(enabled: boolean, body: () => Promise<T>): Promise<T> => {
  if (!enabled) return body();

  const timer = setInterval(() => {
    // Best-effort: a heartbeat outside an activity context, or on an activity
    // Temporal has already given up on, must not fail the work itself.
    try {
      Context.current().heartbeat();
    } catch {
      /* not fatal — the activity's own timeout still governs */
    }
  }, HEARTBEAT_INTERVAL_MS);

  try {
    return await body();
  } finally {
    clearInterval(timer);
  }
};
