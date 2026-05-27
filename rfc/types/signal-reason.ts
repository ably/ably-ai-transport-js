/**
 * Sentinel values published as `step.signal.reason` after the signal aborts.
 * `step.signal` composes hard-abort sources (channel `x-ably-abort`,
 * caller-folded `req.signal`, step precondition timeout) with durable
 * pause (`x-ably-pause`); the reason distinguishes which source fired.
 *
 * The terminal-status inference for `step.end(error?)` and `run.end(error?)`
 * reads `signal.reason` to pick between `'aborted'` and `'paused'`.
 *
 * Exported for callers that introspect the reason directly (telemetry,
 * custom recovery branches). The common case — letting the inference do
 * the routing — does not require importing these sentinels.
 */

/** Set on `step.signal.reason` when the abort came from a hard-abort source. */
export declare const ABORTED: unique symbol;

/** Set on `step.signal.reason` when the abort came from a durable pause signal. */
export declare const PAUSED: unique symbol;
