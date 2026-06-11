/**
 * Vercel decode lifecycle policy — mid-stream-join repair.
 *
 * When a client joins a stream mid-flight (history compaction, rewind miss,
 * partial page), the reducer must still see a clean `start` / `start-step`
 * pre-roll. This policy keys that repair on the discrete codec `kind` and on
 * stream start; each entry performs its tracker side effect and returns the
 * lead-in chunks the generic decoder prepends before running the descriptor
 * driver. A fresh policy (and tracker) is built per decoder instance.
 */

import type * as AI from 'ai';

import { createLifecycleTracker, type LifecyclePolicy, type LifecycleTracker } from '../../core/codec/index.js';
import { stripUndefined } from '../../utils.js';
import type { VercelOutput } from './events.js';
import { fMessageId } from './fields.js';

const createVercelLifecycleTracker = (): LifecycleTracker<AI.UIMessageChunk> =>
  createLifecycleTracker<AI.UIMessageChunk>([
    {
      key: 'start',
      build: (ctx) => [stripUndefined({ type: 'start' as const, messageId: ctx.messageId })],
    },
    {
      key: 'start-step',
      build: () => [{ type: 'start-step' as const }],
    },
  ]);

/**
 * Build a fresh Vercel decode lifecycle policy (with its own tracker). Passed
 * to `defineCodec` as the `decodeLifecycle` factory so each decoder instance
 * gets independent per-run phase state.
 * @returns A {@link LifecyclePolicy} for the Vercel output union.
 */
export const createVercelDecodeLifecycle = (): LifecyclePolicy<VercelOutput> => {
  const tracker = createVercelLifecycleTracker();
  return {
    onDiscrete: {
      start: (runId) => {
        tracker.markEmitted(runId, 'start');
        return [];
      },
      'start-step': (runId) => {
        tracker.markEmitted(runId, 'start-step');
        return [];
      },
      'finish-step': (runId) => {
        tracker.resetPhase(runId, 'start-step');
        return [];
      },
      finish: (runId) => {
        tracker.clearScope(runId);
        return [];
      },
      error: (runId) => {
        tracker.clearScope(runId);
        return [];
      },
      abort: (runId) => {
        tracker.clearScope(runId);
        return [];
      },
      'tool-input': (runId, ctx) => tracker.ensurePhases(runId, { messageId: fMessageId.read(ctx.codecHeaders) }),
    },
    onStreamStart: (runId, trackerState) =>
      tracker.ensurePhases(runId, { messageId: fMessageId.read(trackerState.codecHeaders) }),
  };
};
