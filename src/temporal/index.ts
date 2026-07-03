/**
 * Temporal-specific helpers for building durable agents. Codec-agnostic.
 *
 * Ships two deterministic-identifier helpers: `stepIdFor` and
 * `activityInvocationIdFor`. Both produce workflow-scoped values that
 * survive cross-process retries and don't collide across workflows.
 *
 * Requires `@temporalio/activity` as a peer dependency.
 */

export { activityInvocationIdFor, stepIdFor } from './step-id.js';
