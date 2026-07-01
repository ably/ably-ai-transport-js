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
 * Why a step attempt ended (the `step-reason` on `ai-step-end`).
 *
 * Narrower than {@link RunEndReason}: a step has no `error` arm (a step that
 * hits a stream/model/tool error ends `failed`, since a retry under the same
 * `step-id` may follow). It DOES have a `cancelled` arm, but `cancelled`
 * reflects a run-level event, not a step-level one: cancel ends the RUN, and
 * the step that was open when the cancel landed closes `cancelled` so the
 * bracket is balanced. The step-end always precedes the run terminal on the
 * wire (`ai-step-end{cancelled}` before `ai-run-end{cancelled}`).
 *
 * Supersession is not a step-end reason — it is implicit: a later
 * higher-serial `ai-step-start` for the same `step-id` makes the prior
 * attempt's output non-canonical without any terminal event.
 *
 * - `complete` — the step attempt finished its work.
 * - `failed` — the step attempt failed (the closure threw, or its piped
 *   stream errored). A retry under the same `step-id` may follow.
 * - `cancelled` — the run was cancelled while this step was open. Distinct
 *   from `complete` (the step did not finish its output) and from `failed`
 *   (the step did not fail retryably; the run is ending). The run then
 *   terminates with `ai-run-end{cancelled}`.
 */
export type StepEndReason = 'complete' | 'failed' | 'cancelled';

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
