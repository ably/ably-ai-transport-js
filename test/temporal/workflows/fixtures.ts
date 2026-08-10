/**
 * Fixture workflows for the shim tests.
 *
 * These are bundled and executed inside Temporal's workflow sandbox, so they may
 * only import the shim and `@temporalio/workflow`. They import the shim by
 * relative source path rather than by package name, so the tests exercise the
 * code under test rather than whatever is in `dist/`.
 *
 * Each fixture awaits `sleep(1)` somewhere: workflow bodies must genuinely yield,
 * and a timer is the deterministic way to do that.
 */

import { ApplicationFailure, sleep } from '@temporalio/workflow';

import type { InvocationData } from '../../../src/core/transport/invocation.js';
import type { RunActivityOptions } from '../../../src/temporal/workflow/index.js';
import { withRun } from '../../../src/temporal/workflow/index.js';

/** Args every fixture workflow takes. */
export interface FixtureInput {
  /** The invocation the run serves. */
  invocation: InvocationData;
  /** The invocation id to pin the run to. */
  invocationId: string;
  /** Per-activity options, so a test can assert they reach the right activity. */
  activityOptions?: RunActivityOptions;
}

/**
 * Opens a run and returns its id, doing nothing else.
 * @param input - The invocation, its id, and any activity options.
 * @returns The opened run's id.
 */
export const happyPath = async (input: FixtureInput): Promise<string> =>
  withRun(
    input.invocation,
    { invocationId: input.invocationId, ...(input.activityOptions && { activityOptions: input.activityOptions }) },
    async (run) => {
      await sleep(1);
      return run.ids.runId;
    },
  );

/**
 * Opens a run, then fails, so cleanup must fire. Throws `ApplicationFailure` so
 * the workflow FAILS: a plain `Error` thrown in workflow code is a workflow-task
 * failure, which Temporal retries forever.
 * @param input - The invocation and its id.
 * @returns Never resolves — the body always fails.
 */
export const bodyThrows = async (input: FixtureInput): Promise<void> =>
  withRun(input.invocation, { invocationId: input.invocationId }, async () => {
    await sleep(1);
    throw ApplicationFailure.nonRetryable('body exploded');
  });

/**
 * Opens a run and ends it from the workflow rather than from an activity.
 * @param input - The invocation and its id.
 * @returns Resolves once the terminal is published.
 */
export const endsFromWorkflow = async (input: FixtureInput): Promise<void> =>
  withRun(input.invocation, { invocationId: input.invocationId }, async (run) => {
    await run.end({ reason: 'complete' });
  });

/**
 * Opens a run and suspends it from the workflow.
 * @param input - The invocation and its id.
 * @returns Resolves once the suspend is published.
 */
export const suspendsFromWorkflow = async (input: FixtureInput): Promise<void> =>
  withRun(input.invocation, { invocationId: input.invocationId }, async (run) => {
    await run.suspend();
  });

/**
 * Opens a run and blocks, so a test can cancel the workflow mid-body. Sleeps
 * rather than awaiting a bare promise: only cancellation-aware operations reject
 * when the workflow is cancelled.
 * @param input - The invocation and its id.
 * @returns Never resolves until the workflow is cancelled.
 */
export const blocksForever = async (input: FixtureInput): Promise<void> =>
  withRun(input.invocation, { invocationId: input.invocationId }, async () => {
    await sleep('1 hour');
  });
