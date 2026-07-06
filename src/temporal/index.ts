/**
 * Temporal-specific helpers for building durable agents. Codec-agnostic.
 *
 * Ships the `stepIdFor` deterministic-stepId helper: a workflow-scoped value
 * that survives cross-process retries and doesn't collide across workflows.
 *
 * Requires `@temporalio/activity` as a peer dependency.
 */

export { stepIdFor } from './step-id.js';
