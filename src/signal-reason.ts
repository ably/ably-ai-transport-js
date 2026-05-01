/**
 * Sentinel values set on `step.signal.reason` after the composed signal
 * aborts. The reason distinguishes which source fired so the terminal
 * classifier in {@link AgentRun.end} (and, in later phases, `step.end`'s
 * inference table) can pick between `'aborted'` and `'paused'` without the
 * caller having to remember which source they wired in.
 *
 * Phase 11 only uses {@link ABORTED} — caller signal and start-timeout
 * both abort with this reason. {@link PAUSED} is exported for symmetry
 * with the RFC and for use by phases that wire durable pause control
 * signals; nothing in the SDK sets it yet.
 *
 * Exported from the package root for callers that introspect the reason
 * directly (telemetry, custom recovery branches). The common case — letting
 * the inference do the routing — does not require importing these
 * sentinels.
 */

/** Set on `step.signal.reason` when the abort came from a hard-abort source. */
export const ABORTED: unique symbol = Symbol('AIT-ABORTED');

/**
 * Set on `step.signal.reason` when the abort came from a durable pause
 * signal. Reserved for the control-signal phase that wires
 * `x-ably-pause` into `step.signal` — phase 11 does not set it.
 */
export const PAUSED: unique symbol = Symbol('AIT-PAUSED');
