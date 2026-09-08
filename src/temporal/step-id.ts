/**
 * Deterministic-id helper for Temporal-based agents.
 *
 * Temporal `activityId`s are unique within a workflow, not across workflows —
 * the first activity in every workflow is `"1"`. The SDK's `stepId` supersede
 * semantics operate at the run's whole-lifetime scope, so bare `activityId`s
 * would collide wherever more than one workflow publishes to a single run: the
 * SDK would read two workflows' step-1s as retries of one step and eat the
 * earlier attempt's output. Prefixing with the run's invocation id keeps every
 * stepId globally traceable and collision-free.
 *
 * The plugin itself no longer creates that overlap, since every run it opens is
 * owned by one workflow from start to terminal. The prefix earns its place for
 * a consumer that drives one run from more than one workflow.
 */

import { Context } from '@temporalio/activity';

/**
 * A workflow-scoped stepId that's stable across retries of the same activity
 * and unique across different workflows. Pass as `stepOptions.stepId` when
 * calling `run.createStep({ stepId })` from inside a Temporal activity.
 *
 * Retry semantics: the SDK's `stepId` coalesces retries — a fresh attempt
 * under an existing stepId supersedes the prior attempt's output. Two
 * workflows' first activities both have `activityId === '1'`; prefixing
 * with the run's invocation id keeps them distinct.
 *
 * Reads `Context.current().info.activityId` — call this inside a Temporal
 * activity.
 * @param invocationId - The run's invocation id, sourced from the SDK-supplied
 *   `input.ids.invocationId` (which is also used as the Temporal `workflowId`
 *   when the workflow is started).
 * @returns A workflow-scoped stepId.
 */
export const stepIdFor = (invocationId: string): string => `${invocationId}-${Context.current().info.activityId}`;
