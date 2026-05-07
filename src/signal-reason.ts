/**
 * String identifier carried in the message of the DOMException placed on
 * `step.signal.reason` after the signal aborts. The reason is exposed as
 * a DOMException with `name === 'AbortError'` so it interoperates with
 * `fetch`, the Vercel AI SDK's `isAbortError`, and any model SDK that
 * introspects abort reasons via the web-standard shape. The `message`
 * field carries this identifier when callers want to distinguish abort
 * kinds:
 *
 * ```ts
 * if (step.signal.reason instanceof DOMException && step.signal.reason.message === ABORTED) {
 *   // hard abort
 * }
 * ```
 *
 * Pause does not currently fire `step.signal` — the in-flight step always
 * runs to completion in this iteration, and the agent observes
 * `run.pauseRequested` between steps to decide whether to suspend.
 *
 * Exported from the package root for callers that introspect the reason
 * directly. The common case — letting the inference pick `'aborted'` or
 * `'failed'` from the caught error — does not require importing this.
 */

/** Identifier for hard-abort sources (caller signal, start-timeout, x-ably-abort). */
export const ABORTED = 'AIT-ABORTED' as const;

/**
 * Build the DOMException placed on `step.signal.reason` for an abort.
 * The `name` is `'AbortError'` so `fetch` and Vercel's
 * `isAbortError` propagate the abort cleanly; the `message` carries
 * {@link ABORTED} so callers that need to distinguish abort kinds can
 * inspect it.
 * @returns A DOMException ready to pass to `AbortController.abort(...)`.
 */
export const abortReason = (): DOMException => new DOMException(ABORTED, 'AbortError');
