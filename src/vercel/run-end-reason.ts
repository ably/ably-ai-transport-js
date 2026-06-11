import * as Ably from 'ably';
import type * as AI from 'ai';

import type { RunEndReason, StreamResult } from '../core/transport/types.js';
import { ErrorCode } from '../errors.js';

/**
 * The outcome of a Vercel `streamText` response piped through `Run.pipe`.
 * Discriminated on `reason`: `'suspend'` means the run should pause; the
 * non-`'suspend'` arms describe how it terminated, and an `'error'` outcome
 * always carries `error`.
 *
 * This is a *description of what the Vercel run resulted in*, not a command to
 * the SDK. The common case maps cleanly onto one transport action — `'suspend'`
 * → `Run.suspend()`, everything else → `Run.end()` — and to make that case a
 * one-liner the non-`'suspend'` arms are deliberately assignable to
 * {@link RunEndParams}, so after a `suspend` guard the whole object passes
 * straight to `Run.end(outcome)`. That assignability is a convenience for this
 * adapter, not a constraint on what an outcome can mean: responding to an
 * outcome may also involve work outside this SDK (persisting a result,
 * notifying a human, triggering a downstream workflow), and the developer is
 * free to do that around the terminal call.
 *
 * The type is Vercel-specific by design. Outcomes are the layer where agent
 * SDKs diverge most — both in what they report (the `'suspend'` arm exists only
 * because Vercel surfaces unexecuted tool calls as a non-terminal finish) and
 * in what a developer must do in response. A different SDK's outcome type would
 * have different arms; hence each adapter names its own rather than sharing a
 * single core `RunOutcome`. The vocabulary it bottoms out in
 * ({@link RunEndParams}, `Run.suspend`/`Run.end`) is the shared, codec-agnostic
 * part that does live in core.
 */
export type VercelRunOutcome =
  | {
      /**
       * The LLM requested tools the SDK did not auto-execute, so the run
       * pauses rather than ending — call `Run.suspend()`.
       */
      reason: 'suspend';
      /** Never present for a suspend outcome. */
      error?: never;
    }
  | {
      /** A non-error terminal reason; pass the outcome to `Run.end()`. */
      reason: Exclude<RunEndReason, 'error'>;
      /** Never present for a non-error outcome. */
      error?: never;
    }
  | {
      /** The run ended in error; pass the outcome to `Run.end()`. */
      reason: Extract<RunEndReason, 'error'>;
      /**
       * The terminal error: the underlying stream / `finishReason` failure
       * wrapped as an `Ably.ErrorInfo` (code `StreamError`).
       */
      error: Ably.ErrorInfo;
    };

/**
 * Derive the {@link VercelRunOutcome} for a Vercel `streamText` response that
 * was piped through `Run.pipe`. Preserves transport-level outcomes
 * (`'cancelled'`, `'error'`) from the pipe result; when the pipe completed
 * naturally, awaits Vercel's `finishReason` and returns `'suspend'` for
 * `'tool-calls'` (the LLM requested tools the SDK did not auto-execute, so the
 * run should suspend rather than end), or `'complete'` otherwise.
 *
 * Surfaces the failure for both error shapes so the caller can forward it to
 * `Run.end(reason, error)`: a stream that threw (`pipeResult.error`) and a
 * `finishReason` that rejected with a non-abort error (e.g.
 * `NoOutputGeneratedError`, network blow-ups). The error is wrapped as an
 * `Ably.ErrorInfo` (code `StreamError`). A stream that already produced a
 * codec-level error chunk is unaffected — stamping run-end is the
 * codec-agnostic baseline that any consumer can read.
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
 * @returns The {@link VercelRunOutcome}: the terminal `reason` (or `'suspend'`)
 *   and, when `reason` is `'error'`, the wrapped `error` to pass to `Run.end`.
 */
export const vercelRunOutcome = async (
  pipeResult: StreamResult,
  finishReason: PromiseLike<AI.FinishReason>,
): Promise<VercelRunOutcome> => {
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
    if (pipeResult.reason === 'error') {
      return { reason: 'error', error: _toErrorInfo(pipeResult.error) };
    }
    return { reason: pipeResult.reason };
  }
  try {
    const finish = await finishReason;
    if (finish === 'tool-calls') return { reason: 'suspend' };
    return { reason: 'complete' };
  } catch (error) {
    // Abort-shaped rejections are surfaced from streamText when the run was
    // cancelled before any step finished — treat the run as cancelled so the
    // observable lifecycle matches the cancel that triggered it. Everything
    // else is a real error (e.g. NoOutputGeneratedError, network blow-ups);
    // surface it as such — wrapped so the caller can stamp it on run-end — so
    // the developer sees the failure rather than a silent cancel.
    if (_isAbortLikeError(error)) return { reason: 'cancelled' };
    return { reason: 'error', error: _toErrorInfo(error) };
  }
};

/**
 * Wrap a caught stream / `finishReason` failure as an `Ably.ErrorInfo` so it
 * can be passed to `Run.end(reason, error)`. An error that is already an
 * `Ably.ErrorInfo` is returned unchanged; anything else is wrapped with code
 * `StreamError`, mirroring how `Run.pipe` wraps stream errors for `onError`.
 * @param error - The caught error (or `undefined` when the stream reported none).
 * @returns The error as an `Ably.ErrorInfo`.
 */
const _toErrorInfo = (error: unknown): Ably.ErrorInfo => {
  if (error instanceof Ably.ErrorInfo) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new Ably.ErrorInfo(`unable to complete run; ${message}`, ErrorCode.StreamError, 500);
};

/**
 * Derive the {@link VercelRunOutcome} for a Vercel `generateText` response that
 * was converted with `generateTextToUIMessageStream` and piped through
 * `Run.pipe`.
 *
 * Unlike a `streamText` result, a `generateText` result is awaited in full
 * before conversion: its `finishReason` is a settled value (not a promise), and
 * a generation failure surfaces as a thrown/rejected `generateText` call the
 * caller catches — not as a non-`'complete'` pipe result. This helper therefore
 * only needs to (a) preserve a transport-level failure from the pipe itself
 * (`'cancelled'` / `'error'`, e.g. a channel publish failure — the error wrapped
 * as an `Ably.ErrorInfo` just as {@link vercelRunOutcome} does) and (b) map a
 * clean completion: `'suspend'` when the model requested tools the SDK did not
 * auto-execute (`finishReason === 'tool-calls'`), `'complete'` otherwise. It is
 * the simpler, synchronous counterpart to {@link vercelRunOutcome}.
 * @param pipeResult - The result returned by `Run.pipe`.
 * @param finishReason - The settled `finishReason` from the `generateText` result.
 * @returns The {@link VercelRunOutcome}: `'suspend'` when the run should suspend
 *   awaiting tool input, or the terminal outcome to pass to `Run.end` otherwise.
 */
export const vercelGenerateTextOutcome = (
  pipeResult: StreamResult,
  finishReason: AI.FinishReason,
): VercelRunOutcome => {
  if (pipeResult.reason !== 'complete') {
    if (pipeResult.reason === 'error') {
      return { reason: 'error', error: _toErrorInfo(pipeResult.error) };
    }
    return { reason: pipeResult.reason };
  }
  return finishReason === 'tool-calls' ? { reason: 'suspend' } : { reason: 'complete' };
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
