/**
 * Application-side activities for the Temporal integration suite.
 *
 * These stand in for an agent's own inference. The SDK's plugin owns the run's
 * framing; everything here is what a consumer writes. They run worker-side, so
 * unlike the fixture workflows they may reach for `ably`, the codec and
 * `@temporalio/activity`.
 *
 * They reach the worker as an object passed to `Worker.create({ activities })`.
 * The fixture workflows import only their TYPES, so webpack never pulls any of
 * this into the workflow bundle. For the same reason the helpers object is not
 * exported from here: Temporal would register it as an activity.
 *
 * None may be named `openRun`, `endRun` or `cleanupRun`: the plugin spreads its
 * own activities last, so it would win the clash and silently replace one.
 *
 * Each is built on the SDK's `withStep`, so it is fresh-process safe in the same
 * way the framing activities are: it builds its own Ably client, re-enters the
 * open run, publishes as one step keyed on the activity id, and tears both down.
 * Closing publishes no terminal, so a run left active stays open on the wire for
 * whatever runs next — which is the hand-off these tests exist to prove.
 */

import { ApplicationFailure, Context } from '@temporalio/activity';

import type { InvocationData } from '../../../src/core/transport/invocation.js';
import type { RunIdentity } from '../../../src/core/transport/types.js';
import { createActivityHelpers } from '../../../src/temporal/activity-helpers.js';
import { ablyRealtimeClient } from '../../helper/realtime-client.js';
import { createTestCodec, textReply } from './test-codec.js';

/**
 * The helpers every activity here publishes through, bound to the codec the
 * tests decode with. `ablyRealtimeClient` registers each client for
 * `closeAllClients()`, so a client an activity failed to close is still swept.
 */
const { withStep } = createActivityHelpers({ codec: createTestCodec(), createClient: () => ablyRealtimeClient() });

/**
 * What `answerStep` publishes on the attempt it is told to fail. A test asserts
 * the retry's output supersedes this, so the value has to be recognisable.
 */
export const DEAD_ATTEMPT_TEXT = 'dead attempt';

/** What an app activity is handed: the open run to re-enter, and what to say. */
export interface AnswerStepInput {
  /** The open run to re-enter, as the plugin's `openRun` returned it. */
  ids: RunIdentity;
  /** The invocation whose `channelName` is the channel. */
  invocation: InvocationData;
  /** The text stream's id, which every output of the reply carries. */
  textId: string;
  /** The assistant text to publish, which is what a test asserts came back. */
  reply: string;
  /**
   * End the run from this activity. The cheaper of the two terminal styles,
   * because this process already holds the run. Leave it false to have the
   * workflow publish the terminal through the shim's `endRun` instead.
   */
  publishTerminal: boolean;
  /**
   * Publish {@link DEAD_ATTEMPT_TEXT} and then throw, but only on Temporal's
   * first attempt at this activity. A caller sets it to drive a real retry: the
   * second attempt runs the normal path above, under the same Temporal
   * `activityId` and therefore the same `stepId`, so its output supersedes the
   * dead attempt's rather than appending beside it.
   */
  failFirstAttempt?: boolean;
}

/**
 * Publish one step's reply, and optionally the run's terminal.
 *
 * With `failFirstAttempt`, the first attempt publishes {@link DEAD_ATTEMPT_TEXT}
 * and throws. `withStep` ends the step `failed` and closes the transport before
 * rethrowing, so the dead attempt's output stays on the wire; Temporal then
 * retries under the same `activityId`, so both attempts share one `stepId`.
 * @param input - The run to re-enter, what to say, and whether to fail once first.
 */
export const answerStep = async (input: AnswerStepInput): Promise<void> => {
  const failNow = input.failFirstAttempt === true && Context.current().info.attempt === 1;

  await withStep(input, async ({ step, run }) => {
    if (failNow) {
      await step.pipe(textReply(input.textId, DEAD_ATTEMPT_TEXT));
      throw new Error('inference died mid-step');
    }

    await step.pipe(textReply(input.textId, input.reply));
    if (input.publishTerminal) await run.end({ reason: 'complete' });
  });
};

/**
 * Publish partial output and fail without a terminal, leaving the run open for
 * `withRun`'s cleanup arm to close.
 *
 * Non-retryable on purpose: the suite shares one worker, and an activity left
 * retrying would outlive its own test.
 * @param input - The run to re-enter and the text stream id to publish under.
 */
export const failWithoutTerminal = async (input: AnswerStepInput): Promise<void> => {
  await withStep(input, async ({ step }) => {
    await step.pipe(textReply(input.textId, input.reply));
    throw ApplicationFailure.nonRetryable('inference exploded');
  });
};
