import type * as AI from 'ai';

import type { RunEndReason, StreamResult } from '../core/transport/types.js';

/**
 * Derive the outcome for a Vercel `streamText` response that was piped through
 * `Run.pipe`: either a terminal {@link RunEndReason} the caller passes to
 * `Run.end`, or the sentinel `'suspend'` telling the caller to call
 * `Run.suspend` instead. Preserves transport-level outcomes (`'cancelled'`,
 * `'error'`) from the pipe result; when the pipe completed naturally, awaits
 * Vercel's `finishReason` and returns `'suspend'` for `'tool-calls'` (the LLM
 * requested tools the SDK did not auto-execute, so the run should suspend
 * rather than end), or `'complete'` otherwise.
 *
 * Tolerates `finishReason` rejection. Vercel AI SDK v6 rejects
 * `streamText().finishReason` with the abort signal's reason when the stream
 * is aborted before any step completes, and rejects with
 * `NoOutputGeneratedError` when the model produced nothing at all. Without
 * this guard the rejection would bubble out of the route handler's `after()`
 * block, skip the developer's `Run.end(...)` call, and leave the run with no
 * `ai-run-end` event on the channel — so observers' UIs stay stuck on
 * `streaming` indefinitely.
 *
 * Saves callers from interpreting Vercel domain semantics inline at the end
 * of every route handler.
 * @param pipeResult - The result returned by `Run.pipe`.
 * @param finishReason - The `finishReason` promise from a `streamText` result.
 * @returns `'suspend'` when the run should suspend awaiting tool input, or the
 *   {@link RunEndReason} to pass to `Run.end` otherwise.
 */
export const vercelRunOutcome = async (
  pipeResult: StreamResult,
  finishReason: PromiseLike<AI.FinishReason>,
): Promise<RunEndReason | 'suspend'> => {
  if (pipeResult.reason !== 'complete') {
    // Vercel's `result.finishReason` getter creates the underlying Promise
    // eagerly, before the caller hands it to us. When `streamText` is
    // aborted before any step completes, Vercel rejects that Promise with
    // the abort signal's reason — typically a DOMException whose
    // `.message` is a read-only getter. Returning early without ever
    // attaching a handler lets Node report it as an unhandled rejection;
    // Next.js' dev bundler then tries to mutate `.message` for logging
    // and crashes with a confusing TypeError. Attach a silent handler so
    // the rejection is observed and discarded — the transport-level
    // `pipeResult.reason` is already what we return.
    Promise.resolve(finishReason).catch(() => {
      /* intentionally discarded; reason already known from pipeResult */
    });
    return pipeResult.reason;
  }
  try {
    const finish = await finishReason;
    return finish === 'tool-calls' ? 'suspend' : 'complete';
  } catch (error) {
    // Abort-shaped rejections are surfaced from streamText when the run was
    // cancelled before any step finished — treat the run as cancelled so the
    // observable lifecycle matches the cancel that triggered it. Everything
    // else is a real error (e.g. NoOutputGeneratedError, network blow-ups);
    // surface it as such so the developer sees the failure rather than a
    // silent cancel.
    return _isAbortLikeError(error) ? 'cancelled' : 'error';
  }
};

/**
 * Heuristic for "this error came from an AbortSignal aborting".
 * Covers `DOMException` aborts (browser / Node 20+ `streamText`),
 * plain `Error` objects whose `name` is `'AbortError'`, and anything
 * else carrying that conventional name. Avoids importing
 * `@ai-sdk/provider-utils` just for `isAbortError`.
 * @param error - The error to test.
 * @returns `true` if the error looks like an abort.
 */
const _isAbortLikeError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError';
};
