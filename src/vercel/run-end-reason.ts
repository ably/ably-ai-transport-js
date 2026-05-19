import type * as AI from 'ai';

import type { RunEndReason, StreamResult } from '../core/transport/types.js';

/**
 * Derive the `RunEndReason` for a Vercel `streamText` response that was piped
 * through `Run.pipe`. Preserves transport-level outcomes (`'cancelled'`,
 * `'error'`) from the pipe result; when the pipe completed naturally, awaits
 * Vercel's `finishReason` and maps `'tool-calls'` to `'suspended'` (the LLM
 * requested tools the SDK did not auto-execute, so the run should suspend
 * rather than end).
 *
 * Saves callers from interpreting Vercel domain semantics inline at the end
 * of every route handler.
 * @param pipeResult - The result returned by `Run.pipe`.
 * @param finishReason - The `finishReason` promise from a `streamText` result.
 * @returns The `RunEndReason` to pass to `Run.end`.
 */
export const vercelRunEndReason = async (
  pipeResult: StreamResult,
  finishReason: PromiseLike<AI.FinishReason>,
): Promise<RunEndReason> => {
  if (pipeResult.reason !== 'complete') return pipeResult.reason;
  const finish = await finishReason;
  return finish === 'tool-calls' ? 'suspended' : 'complete';
};
