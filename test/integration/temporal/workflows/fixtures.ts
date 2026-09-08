/**
 * Fixture workflows for the Temporal integration suite.
 *
 * These stand in for the `chatWorkflow` a consumer writes — compare
 * `demo/temporal/temporal-agent/src/worker/workflows.ts`, which has the same
 * shape. They are bundled and executed inside Temporal's workflow sandbox, so
 * they may import only the shim and `@temporalio/workflow`, and they import the
 * shim by relative source path so the tests exercise source rather than `dist/`.
 *
 * **Every reference into the sibling `../activities.js` must be `import type`.**
 * The workflow bundler strips types per file with no type information, so a
 * plain value import of something that happens to be a type is followed by
 * webpack and drags `ably` into the sandbox bundle. `eslint.config.js` lints
 * this directory for exactly that.
 *
 * Two rules the suite's shared worker imposes. Every fixture must reach a
 * settled state on its own, and any fixture meant to fail must not leave an
 * activity retrying past the end of its test — hence the retry policies below
 * and the non-retryable throw in `failWithoutTerminal`.
 */

import { proxyActivities, sleep } from '@temporalio/workflow';

import type { InvocationData } from '../../../../src/core/transport/invocation.js';
import { openRun, withRun } from '../../../../src/temporal/workflow/index.js';
import type * as activities from '../activities.js';

/** Args every fixture workflow takes, mirroring a real workflow's input. */
export interface FixtureInput {
  /** The invocation the run serves; its `inputEventId` is already on the channel. */
  invocation: InvocationData;
  /** The invocation id to pin the run to, and the run id that follows from it. */
  invocationId: string;
  /** The assistant text the answering activity publishes. */
  reply: string;
  /** Make the answering activity fail its first attempt, so Temporal retries it. */
  failFirstAttempt?: boolean;
}

// Two attempts, so a caller passing `failFirstAttempt` gets a real retry, and a
// fixed one-second backoff so it costs a second rather than Temporal's growing
// default. Generous start-to-close: these activities do real Ably I/O.
const { answerStep } = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 2, initialInterval: '1 second', backoffCoefficient: 1 },
});

// One attempt: the failure is the point, and a retry would outlive its test.
const { failWithoutTerminal } = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 1 },
});

/**
 * The whole agent side of one run: open it, answer it, and end it from inside
 * the answering activity — the cheapest terminal style, and what the demo does.
 *
 * Passing `failFirstAttempt` makes the answering activity die once first, so
 * this fixture also covers the retry path.
 * @param input - The invocation, its id, the reply, and whether to fail once.
 * @returns Resolves once the run has been answered and ended.
 */
export const durableRun = async (input: FixtureInput): Promise<void> =>
  withRun(input.invocation, { invocationId: input.invocationId }, async (run) => {
    await answerStep({
      ids: run.ids,
      invocation: input.invocation,
      textId: 'a1',
      reply: input.reply,
      publishTerminal: true,
      ...(input.failFirstAttempt === true && { failFirstAttempt: true }),
    });
  });

/**
 * The other terminal style: the answering activity publishes no terminal, and
 * the workflow ends the run through the shim's `endRun`. Three processes with
 * three connections produce one run.
 * @param input - The invocation, its id, and the reply.
 * @returns Resolves once the terminal is on the wire.
 */
export const endsFromWorkflow = async (input: FixtureInput): Promise<void> =>
  withRun(input.invocation, { invocationId: input.invocationId }, async (run) => {
    await answerStep({
      ids: run.ids,
      invocation: input.invocation,
      textId: 'a1',
      reply: input.reply,
      publishTerminal: false,
    });
    await run.end({ reason: 'complete' });
  });

/**
 * Opens the run twice under one invocation id, which is what a fresh-process
 * retry of `openRun` looks like on the channel. Deliberately not `withRun`: the
 * cleanup arm would otherwise mask what the second open published.
 * @param input - The invocation and its id.
 * @returns Resolves once the run has been closed.
 */
export const opensTwice = async (input: FixtureInput): Promise<void> => {
  await openRun(input.invocation, { invocationId: input.invocationId });
  const second = await openRun(input.invocation, { invocationId: input.invocationId });
  await second.end({ reason: 'complete' });
};

/**
 * A run whose inference fails after producing output and without publishing a
 * terminal, so `withRun`'s cleanup arm has to close it.
 * @param input - The invocation, its id, and the partial reply.
 * @returns Rejects with the activity's failure, after cleanup has run.
 */
export const inferenceFails = async (input: FixtureInput): Promise<void> =>
  withRun(input.invocation, { invocationId: input.invocationId }, async (run) => {
    await failWithoutTerminal({
      ids: run.ids,
      invocation: input.invocation,
      textId: 'a1',
      reply: input.reply,
      publishTerminal: false,
    });
  });

/**
 * Answers, then parks on a cancellation-aware sleep so a test can cancel the
 * workflow between activities. The sleep is never waited out: cancelling
 * interrupts it, which is what lets `withRun`'s non-cancellable cleanup run.
 * @param input - The invocation, its id, and the reply.
 * @returns Rejects when the workflow is cancelled, after cleanup has run.
 */
export const parksAfterAnswering = async (input: FixtureInput): Promise<void> =>
  withRun(input.invocation, { invocationId: input.invocationId }, async (run) => {
    await answerStep({
      ids: run.ids,
      invocation: input.invocation,
      textId: 'a1',
      reply: input.reply,
      publishTerminal: false,
    });
    await sleep('1 hour');
  });

/**
 * Ends the run twice from workflow code, which is what a retry of `endRun`
 * after a publish-then-crash puts on the channel.
 * @param input - The invocation, its id, and the reply.
 * @returns Resolves once both terminals are on the wire.
 */
export const endsTwice = async (input: FixtureInput): Promise<void> =>
  withRun(input.invocation, { invocationId: input.invocationId }, async (run) => {
    await answerStep({
      ids: run.ids,
      invocation: input.invocation,
      textId: 'a1',
      reply: input.reply,
      publishTerminal: false,
    });
    await run.end({ reason: 'complete' });
    await run.end({ reason: 'complete' });
  });
