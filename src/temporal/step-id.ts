/**
 * Deterministic-id helpers for Temporal-based agents.
 *
 * Temporal `activityId`s are unique within a workflow, not across workflows —
 * the first activity in every workflow is `"1"`. But the SDK's stepId +
 * `AdoptIdentity.invocationId` supersede semantics operate at the run's
 * whole-lifetime scope. When multiple workflows publish to the same run (e.g.
 * a suspend + continuation), bare activityIds would collide and the SDK
 * would treat different workflows' step-1s as retries of the same step —
 * eating earlier attempts' output. Prefixing with the workflow's own
 * invocation id keeps every id globally traceable and collision-free.
 */

import { Context } from '@temporalio/activity';

/**
 * A workflow-scoped stepId that's stable across retries of the same activity
 * and unique across different workflows. Use as `stepOptions.stepId` when
 * calling `run.createStep({ stepId })` from a Temporal activity.
 *
 * Retry semantics: the SDK's `stepId` coalesces retries — a fresh attempt
 * under an existing stepId supersedes the prior attempt's output. Two
 * workflows' first activities both have `activityId === '1'`; prefixing
 * with the workflow's invocation id keeps them distinct.
 * @param workflowInvocationId - The workflow's invocation id (typically the workflow id).
 * @param activityId - Temporal's `Context.current().info.activityId`.
 * @returns A workflow-scoped stepId.
 */
export const stepIdFor = (workflowInvocationId: string, activityId: string): string =>
  `${workflowInvocationId.slice(0, 8)}-${activityId}`;

/**
 * The AdoptIdentity `invocationId` this activity should stamp on its
 * outputs — a workflow-scoped identity that's traceable on the wire.
 *
 * `AdoptIdentity.invocationId` is *this process's* identity — the value
 * stamped on every event this activity publishes for the run, distinct from
 * the run's owner invocation. Bare `activityId` is unique only within one
 * workflow, so two different workflows' third activity would both stamp
 * `invocation-id: 3` on the wire and be indistinguishable. Prefixing with
 * the current workflow's id makes every activity execution globally
 * attributable.
 *
 * Reads `Context.current()` — call this inside a Temporal activity.
 * @returns A workflow-scoped invocation id for `session.adoptRun({ invocationId })`.
 */
export const activityInvocationIdFor = (): string => {
  const ctx = Context.current();
  const workflowId = ctx.info.workflowExecution?.workflowId ?? 'nowf';
  return `${workflowId.slice(0, 8)}-${ctx.info.activityId}`;
};
