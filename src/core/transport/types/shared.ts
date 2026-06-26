/** Types shared across the client, agent, tree, and view layers. */

import type * as Ably from 'ably';

/**
 * Why a run ended.
 *
 * A run-end is terminal — a run that merely pauses awaiting input publishes
 * `ai-run-suspend` instead (see {@link AgentRun.suspend}).
 *
 * - `complete` — the run finished naturally.
 * - `cancelled` — the run was cancelled by a client.
 * - `error` — the run errored.
 */
export type RunEndReason = 'complete' | 'cancelled' | 'error';

/**
 * The lifecycle status of a run, as observed off the conversation Tree.
 *
 * - `active` — the run is in flight (streaming), or not yet observed on the
 *   channel (a freshly-created run whose run-start has not folded in).
 * - `suspended` — the run is paused awaiting input (it published
 *   `ai-run-suspend`); a later continuation re-activates it.
 * - `complete` / `cancelled` / `error` — terminal {@link RunEndReason}s; an
 *   `error` run additionally carries terminal error detail (`Run.error`).
 *
 * This is the single source of truth for the run status value set: the Tree's
 * per-run `RunNodeState.status` is defined in terms of it, and it is exposed
 * unchanged on the shared {@link BaseRun.status} accessor.
 */
export type RunStatus = 'active' | 'suspended' | 'complete' | 'cancelled' | 'error';

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
