/**
 * Temporal-specific helpers for building durable agents. Codec-agnostic.
 *
 * Two things ship here, both worker-side:
 *
 *   - `createAblyTransportPlugin` — a Temporal worker plugin that registers the
 *     framing activities (`openRun`, `endRun`, `suspendRun`, `cleanupRun`), so a
 *     consumer never writes them. Pair it with the workflow-side shim at
 *     `@ably/ai-transport/temporal/workflow`.
 *   - `stepIdFor` — a deterministic step id that survives cross-process retries
 *     and doesn't collide across workflows.
 *
 * Workflow code must NOT import from here: this module reaches for
 * `@temporalio/activity` and `ably`, neither of which is available inside
 * Temporal's workflow sandbox. Import the shim subpath instead.
 *
 * Requires `@temporalio/activity` and `@temporalio/worker` as peer dependencies.
 */

export type { FramingActivitiesOptions } from './activities.js';
export type { PageUntilLocatedOptions } from './page-until-located.js';
export type { AblyTransportPlugin, AblyTransportPluginOptions } from './plugin.js';
export { createAblyTransportPlugin } from './plugin.js';
export { stepIdFor } from './step-id.js';
export type {
  CleanupRunInput,
  EndRunInput,
  FramingActivities,
  OpenRunInput,
  SuspendRunInput,
} from './workflow/activity-types.js';
