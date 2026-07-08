/**
 * Fault modes the demo can arm to exercise WDK's retry + AIT's supersede.
 *
 * Both fire on the step activity's **first attempt only** (gated on
 * `getStepMetadata().attempt`), so WDK re-runs the activity as a fresh process
 * and the retry (attempt 2) succeeds — the re-created AIT step supersedes the
 * dead attempt's output, and the turn settles once with no duplicate.
 */
export type FaultMode =
  // Throw a WDK `RetryableError` on attempt 1 — a graceful, backed-off retry.
  | 'fail-once'
  // Throw an uncaught error on attempt 1 — the closest stand-in for a worker
  // dying mid-step; WDK redelivers and re-runs the activity.
  | 'crash';
