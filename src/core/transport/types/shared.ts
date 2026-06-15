/** Types shared across the client, agent, tree, and view layers. */

import type * as Ably from 'ably';

/**
 * Why a run ended.
 *
 * A run-end is terminal — a run that merely pauses awaiting input publishes
 * `ai-run-suspend` instead (see {@link Run.suspend}).
 *
 * - `complete` — the run finished naturally.
 * - `cancelled` — the run was cancelled by a client.
 * - `error` — the run errored.
 */
export type RunEndReason = 'complete' | 'cancelled' | 'error';

/**
 * Passed to a run's `onCancel` hook for authorization decisions.
 * The hook inspects the incoming cancel message and decides whether to
 * allow the targeted run to be cancelled.
 */
export interface CancelRequest {
  /** The raw Ably message that carried the cancel signal. */
  message: Ably.InboundMessage;
  /** The runId being cancelled. */
  runId: string;
}
