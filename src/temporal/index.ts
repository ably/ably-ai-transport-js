/**
 * Temporal-specific helpers for building durable agents. Codec-agnostic.
 *
 * Everything here is worker-side:
 *
 *   - `createAblyTransportPlugin` — a Temporal worker plugin that registers the
 *     framing activities (`openRun`, `endRun`, `cleanupRun`), so a
 *     consumer never writes them. Pair it with the workflow-side helpers at
 *     `@ably/ai-transport/temporal/workflow`.
 *   - `createActivityHelpers` — `withAgentTransport`, `withRun` and `withStep`
 *     for the activities a consumer does write: each builds and tears down the
 *     Ably client and transport, and `withStep` keys one step on the Temporal
 *     activity id so a retry supersedes the failed attempt's output.
 *
 * Workflow code must NOT import from here: this module reaches for
 * `@temporalio/activity` and `ably`, neither of which is available inside
 * Temporal's workflow sandbox. Import the workflow subpath instead.
 *
 * Requires `@temporalio/activity` and `@temporalio/worker` as peer dependencies.
 */

export type { FramingActivitiesOptions } from './activities.js';
export type {
  ActivityHelpers,
  ActivityHelpersOptions,
  ActivityRunHooks,
  AgentTransportContext,
  RunContext,
  RunInput,
  StepContext,
  WithAgentTransport,
  WithRun,
  WithStep,
} from './activity-helpers.js';
export { createActivityHelpers } from './activity-helpers.js';
export type { AblyTransportPlugin, AblyTransportPluginOptions } from './plugin.js';
export { createAblyTransportPlugin } from './plugin.js';
export type {
  AdoptRunInput,
  CleanupRunInput,
  EndRunInput,
  FramingActivities,
  OpenRunInput,
} from './workflow/activity-types.js';
