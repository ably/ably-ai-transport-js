/**
 * String identifiers carried in the message of the DOMException placed on
 * `step.signal.reason` after the composed signal aborts. The kind
 * distinguishes which source fired so terminal classifiers can pick
 * between `'aborted'` and (in later phases) `'paused'` without the
 * caller having to remember which source they wired in.
 *
 * The reason is exposed as a DOMException with `name === 'AbortError'`
 * so it interoperates with `fetch`, the Vercel AI SDK's
 * `isAbortError`, and any model SDK that introspects abort reasons via
 * the web-standard shape. The `message` field carries one of these
 * identifiers when callers want to distinguish abort kinds:
 *
 * ```ts
 * if (step.signal.reason instanceof DOMException && step.signal.reason.message === ABORTED) {
 *   // hard abort
 * }
 * ```
 *
 * Phase 11 only uses {@link ABORTED} — caller signal and start-timeout
 * both abort with this identifier. {@link PAUSED} is reserved for the
 * control-signal phase that wires `x-ably-pause` into `step.signal`.
 *
 * Exported from the package root for callers that introspect the reason
 * directly. The common case — letting the inference pick `'aborted'` or
 * `'failed'` from the caught error — does not require importing these.
 */

/** Identifier for hard-abort sources (caller signal, start-timeout, x-ably-abort). */
export const ABORTED = 'AIT-ABORTED' as const;

/**
 * Identifier for durable pause signals. Reserved for the control-signal
 * phase that wires `x-ably-pause` into `step.signal` — phase 11 does
 * not set it.
 */
export const PAUSED = 'AIT-PAUSED' as const;

/**
 * Build the DOMException placed on `step.signal.reason` for an abort.
 * The `name` is `'AbortError'` so `fetch` and Vercel's
 * `isAbortError` propagate the abort cleanly; the `message` carries
 * {@link ABORTED} so callers that need to distinguish abort kinds can
 * inspect it.
 * @returns A DOMException ready to pass to `AbortController.abort(...)`.
 */
export const abortReason = (): DOMException => new DOMException(ABORTED, 'AbortError');
