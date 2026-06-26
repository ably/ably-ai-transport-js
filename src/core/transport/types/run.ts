/** The shared run read-model: the base contract common to a client send's run and an agent's run. */

import type * as Ably from 'ably';

import type { RunStatus } from './shared.js';

/**
 * The read-model shared by both sides of a run: the handle a client's
 * `view.send()` returns and the run an agent's `createRun()` returns both
 * satisfy this contract, so the same accessor means the same thing on each
 * side. Each side extends it with its own verbs — the client adds the
 * write/control surface, the agent the lifecycle surface.
 *
 * All members read live off the conversation Tree and return a fresh value per
 * access; none are cached.
 */
export interface BaseRun<TMessage> {
  /**
   * The run's unique identifier (agent-minted). On the agent this is known
   * synchronously; on the client it is empty until the agent's run-start is
   * observed — await the client run's `started` before reading it.
   */
  readonly runId: string;

  /**
   * The run's lifecycle status. `'active'` while the run is in flight or not
   * yet observed on the channel; `'suspended'` while paused; otherwise the
   * terminal reason (`'complete'` / `'cancelled'` / `'error'`). Read live off
   * the Tree, so it advances as the run's lifecycle events fold in.
   */
  readonly status: RunStatus;

  /**
   * The terminal error, present exactly when `status === 'error'` (otherwise
   * `undefined`). Reconstructed from the run-end's stamped error detail, or a
   * generic fallback when the run ended in error without detail.
   */
  readonly error: Ably.ErrorInfo | undefined;

  /**
   * This run's whole turn: the triggering input message (when the run
   * introduced one) followed by this run's own streamed output, deduped by
   * codec-message-id. This is the unit to persist — because every send
   * introduces at most one new message and triggers exactly one run, the union
   * of all runs' `messages` reconstructs the conversation with no gaps or
   * duplicates. Empty until the run is observed on the Tree. Each access
   * returns a fresh array, safe to mutate without affecting run state.
   */
  readonly messages: TMessage[];
}
