/**
 * Retry after failure — client side (durable execution).
 *
 * In-workflow retries are handled automatically by the framework — the
 * client does not need to publish `x-ably-retry` for hop-level failures.
 *
 * The client may still want to offer a manual "try again" affordance if
 * the workflow terminally exhausted its retry budget and ended the run
 * `failed`. That publishes `x-ably-retry` and invokes a fresh workflow
 * run on the same session.
 */

import type * as AI from 'ai';

import type { Codec, ClientSession } from '../../../index.js';

/**
 * Retry a run that the workflow ended as `failed`. Publishes
 * `x-ably-retry` targeting the run and POSTs the returned invocation to
 * the workflow endpoint.
 * @param session - The client session backing the UI.
 * @param runId - The failed run to retry.
 * @returns Resolves once the retry has been published and the workflow invoked.
 */
export const onTryAgainClick = async (
  session: ClientSession<Codec<AI.UIMessageChunk, AI.UIMessage>>,
  runId: string,
): Promise<void> => {
  const run = session.tree.getRun(runId);
  if (run?.status !== 'failed') return;
  const invocation = await run.retry();
  await fetch('/api/workflow/start', {
    method: 'POST',
    body: JSON.stringify(invocation.toJSON()),
  });
};
