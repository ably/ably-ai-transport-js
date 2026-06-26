/** Steering surface types — outcome and result of `ActiveRun.steer(...)`. */

import type { RunEndReason } from './shared.js';

/**
 * The outcome of a steering publish, derivable from the agent's response
 * messages. Each response carries a `steer-codec-message-ids` header
 * listing the steer codec-message-ids the agent's iteration loop drained
 * since the previous response. The SDK accumulates the union of these
 * lists per Run and resolves the outcome by membership when the Run's
 * terminal lifecycle event (`run-end`, or `run-suspend`) lands.
 *
 * - `consumed: true` — the steer's codec-message-id appears in the union
 *   of stamps observed on this Run's responses. The agent's iteration
 *   loop had it visible when it ran the inference that produced the
 *   stamping response. The agent may still have skipped using it in that
 *   particular inference call (the developer's snapshot choices are their
 *   own); the wire only reports up to "visible at the iteration the agent
 *   drained it on".
 * - `consumed: false` — the steer's codec-message-id never appeared on
 *   any observed response stamp before `run-end`. For a `run-suspend`
 *   this stays pending (a later resume may consume it via further
 *   stamps); for `run-end` it is terminal.
 */
export interface SteerOutcome {
  /** Whether the steer landed inside the Run's consumed-input window. */
  consumed: boolean;
  /**
   * Terminal reason of the Run, present when the outcome was determined
   * by a `run-end` event. Lets callers distinguish "consumed before
   * cancel/error" from "lost to cancel/error" without inspecting the Tree.
   * Absent when the outcome was determined by a `run-suspend`.
   */
  runTerminalReason?: RunEndReason;
}

/**
 * Result of `ActiveRun.steer(...)`. Two promises:
 *
 * - `published`: resolves when the steer message has been published to the
 *   channel. Carries the Ably-assigned `serial` of the publish for callers
 *   that want to confirm the publish landed. Rejects if the underlying
 *   publish (or the awaiting of `ActiveRun.runId`) fails.
 * - `outcome`: resolves once the SDK has folded a terminal lifecycle event
 *   (`run-end`) — or `run-suspend` for the suspending case — for this
 *   Run, and can declare consumed/not-consumed by checking whether the
 *   steer's codec-message-id is in the union of `steer-codec-message-ids`
 *   stamps observed on the Run's response messages. Rejects if the handle
 *   becomes dead before such an event arrives (e.g. the session closes).
 */
export interface SteerResult {
  /** Resolves when the steer publish lands on the channel. */
  published: Promise<{ serial: string | undefined }>;
  /** Resolves with the consumed/not-consumed outcome at the Run's next terminal event. */
  outcome: Promise<SteerOutcome>;
}
