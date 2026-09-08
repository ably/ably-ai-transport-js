/**
 * The framing activities the plugin registers.
 *
 * Framing is everything that brackets a turn — opening the run, and publishing
 * its terminal — as opposed to the inference itself, which stays the
 * application's. Each one carries no application types, which is what makes it
 * safe for the SDK to own.
 *
 * Every activity is built on the worker-side helpers in `activity-helpers.ts`,
 * so the client and transport lifecycle has one implementation. The channel is
 * caller-owned by the transport contract, so closing the transport publishes
 * no terminal — a run an activity leaves open stays open on the wire for a
 * later activity to re-enter.
 */

import * as Ably from 'ably';

import type { RunIdentity } from '../core/transport/types.js';
import { ErrorCode } from '../errors.js';
import { type ActivityHelpersOptions, createActivityHelpers } from './activity-helpers.js';
import type { CleanupRunInput, EndRunInput, FramingActivities, OpenRunInput } from './workflow/activity-types.js';

/**
 * Configuration for the framing activities. A consumer supplies this to
 * {@link createAblyTransportPlugin}, which builds and registers the activities
 * itself. The same shape configures {@link createActivityHelpers}.
 */
export type FramingActivitiesOptions<TInput, TOutput> = ActivityHelpersOptions<TInput, TOutput>;

/**
 * Build the framing activities, bound to a codec and a client factory.
 *
 * A factory rather than module-level state, so a worker can host more than one
 * configuration and nothing is global.
 * @template TInput - The codec's input-event domain type.
 * @template TOutput - The codec's output-event domain type.
 * @param options - Codec, client factory, and paging behaviour.
 * @returns The three activities, ready to register on a worker.
 */
export const createFramingActivities = <TInput, TOutput>(
  options: FramingActivitiesOptions<TInput, TOutput>,
): FramingActivities => {
  const logger = options.logger?.withContext({ component: 'FramingActivities' });
  const { withRun } = createActivityHelpers(options);

  return {
    openRun: async (input: OpenRunInput): Promise<RunIdentity> => {
      logger?.trace('framingActivities.openRun();', { invocationId: input.invocationId });
      // eslint-disable-next-line @typescript-eslint/require-await -- the body only reads the identity; the helper already awaited the open
      return withRun(input, async ({ ids }) => ids);
    },

    endRun: async (input: EndRunInput): Promise<void> => {
      logger?.trace('framingActivities.endRun();', { runId: input.ids.runId, reason: input.reason });
      await withRun(input, async ({ run }) => {
        // No wire-state check: this activity adopts and publishes. A retry
        // after a crash that already published puts a second `ai-run-end` on
        // the channel. The SDK's own Vercel adapter absorbs that idempotently;
        // a consumer merging the stream itself is expected to honour the first
        // terminal in serial order.
        if (input.reason === 'error') {
          await run.end({
            reason: 'error',
            error: new Ably.ErrorInfo(
              input.errorMessage ?? 'unable to complete the run; the turn failed',
              ErrorCode.RunResponseStreamFailed,
              500,
            ),
          });
          return;
        }
        await run.end({ reason: input.reason });
      });
    },

    cleanupRun: async (input: CleanupRunInput): Promise<void> => {
      // Warn, not trace: this arm only runs because the workflow threw, and it
      // publishes a terminal over whatever state the run was in.
      logger?.warn('framingActivities.cleanupRun(); ending the run after a workflow failure', {
        runId: input.ids.runId,
      });
      // Not cancellable: this is the cleanup arm, so it must still run while
      // the workflow itself is being cancelled.
      await withRun(input, { cancellable: false }, async ({ run }) => {
        // No wire-state check: the cleanup arm publishes its error terminal
        // unconditionally, because reading the run's state would mean a history
        // scan on the one path that has to stay cheap and cancellation-proof.
        //
        // One consequence follows. On a run that already ended, this adds a
        // second `ai-run-end`; a reader honouring the first terminal sees
        // channel noise rather than a wrong state.
        await run.end({
          reason: 'error',
          error: new Ably.ErrorInfo(
            input.errorMessage ?? 'unable to complete the run; the workflow failed',
            ErrorCode.RunResponseStreamFailed,
            500,
          ),
        });
      });
    },
  };
};
