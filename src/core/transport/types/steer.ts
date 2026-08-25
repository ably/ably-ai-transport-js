/** Steering surface types — outcome and result of `ClientTransport.steer(...)`. */

import type { RunEndReason } from './shared.js';

/**
 * The outcome of a steering publish, derivable from the agent's response
 * messages. Each response carries a `steer-transport-message-ids` header listing
 * the steer transport-message-ids the agent's loop drained since the step attempt
 * that produced it opened. The SDK accumulates the union of these lists per
 * run and resolves the outcome by membership when the run's terminal lifecycle
 * event (`ai-run-end`, or `ai-run-suspend`) lands.
 *
 * - `consumed: true` — the steer's transport-message-id appears in the union of
 *   stamps observed on this run's responses. The agent's loop had it visible
 *   when it ran the inference that produced the stamping response. The agent
 *   may still have skipped using it in that particular inference call (the
 *   developer's snapshot choices are their own); the wire only reports up to
 *   "visible at the iteration the agent drained it on".
 * - `consumed: false` — the steer's transport-message-id never appeared on any
 *   observed response stamp before `ai-run-end`. For an `ai-run-suspend` this
 *   stays pending (a later resume may consume it via further stamps); for
 *   `ai-run-end` it is terminal.
 */
export interface SteerOutcome {
  /** Whether the steer landed inside the run's consumed-input window. */
  consumed: boolean;
  /**
   * Terminal reason of the run, present when the outcome was determined by an
   * `ai-run-end` event. Lets callers distinguish "consumed before cancel/error"
   * from "lost to cancel/error" without inspecting further events. Absent when
   * the outcome was determined by an `ai-run-suspend`.
   */
  runTerminalReason?: RunEndReason;
}

/**
 * Result of `ClientTransport.steer(...)`. Two promises:
 *
 * - `published`: resolves when the steer message has been published to the
 *   channel. Carries the Ably-assigned `serial` of the publish for callers
 *   that want to confirm the publish landed. Rejects if the underlying publish
 *   (or the awaiting of the run-id promise) fails.
 * - `outcome`: resolves once the SDK has observed a terminal lifecycle event
 *   (`ai-run-end`) — or `ai-run-suspend` for the suspending case — for this
 *   run, and can declare consumed/not-consumed by checking whether the steer's
 *   transport-message-id is in the union of `steer-transport-message-ids` stamps
 *   observed on the run's response messages. Rejects if the steer can no
 *   longer resolve before such an event arrives (e.g. the transport closes).
 */
export interface SteerResult {
  /** Resolves when the steer publish lands on the channel. */
  published: Promise<{ serial: string | undefined }>;
  /** Resolves with the consumed/not-consumed outcome at the run's next terminal event. */
  outcome: Promise<SteerOutcome>;
}
