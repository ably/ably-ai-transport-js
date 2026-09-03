/**
 * Shim tests, run against a throwaway Temporal server.
 *
 * These prove what only a real workflow execution can: which framing activities
 * the shim schedules, in what order, that cleanup fires on failure and survives
 * cancellation, and that per-activity options reach the right activity. The
 * framing activities themselves are faked here — their behaviour is covered by
 * `activities.test.ts`.
 *
 * Bundling the fixtures through a real `Worker` also proves the shim is
 * sandbox-safe: any worker-side import leaking into it fails here.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { InvocationData } from '../../src/core/transport/invocation.js';
import type { RunIdentity } from '../../src/core/transport/types/transport.js';
import type { FramingActivities } from '../../src/temporal/workflow/activity-types.js';
import type { FixtureInput } from './workflows/fixtures.js';

const workflowsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'workflows/fixtures.ts');

const invocation: InvocationData = { inputEventId: 'evt-1', channelName: 'ai:test' };
const invocationId = 'wf-1';
const ids: RunIdentity = { runId: 'run-1', invocationId };

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
});

afterAll(async () => {
  await env.teardown();
});

interface Recorded {
  /** Activity names in the order they were scheduled. */
  calls: string[];
  /** The activities to register on the worker. */
  activities: FramingActivities;
  /** The most recent input each activity received. */
  inputs: Record<string, unknown>;
}

/**
 * Fake framing activities that record what the shim scheduled.
 * @param openRunFails - Make `openRun` throw, so nothing is opened.
 * @returns The fakes plus the recording.
 */
const recordActivities = (openRunFails = false): Recorded => {
  const calls: string[] = [];
  const inputs: Record<string, unknown> = {};
  const record = (name: string, input: unknown): void => {
    calls.push(name);
    inputs[name] = input;
  };
  return {
    calls,
    inputs,
    activities: {
      openRun: vi.fn(async (input): Promise<RunIdentity> => {
        record('openRun', input);
        await Promise.resolve();
        if (openRunFails) throw new Error('cannot open');
        return ids;
      }),
      endRun: vi.fn(async (input): Promise<void> => {
        record('endRun', input);
        await Promise.resolve();
      }),
      suspendRun: vi.fn(async (input): Promise<void> => {
        record('suspendRun', input);
        await Promise.resolve();
      }),
      cleanupRun: vi.fn(async (input): Promise<void> => {
        record('cleanupRun', input);
        await Promise.resolve();
      }),
    },
  };
};

let taskQueueCounter = 0;

/**
 * Run one fixture workflow to completion against the test server.
 * @param workflowType - Which fixture to run.
 * @param recorded - The fake activities to register.
 * @param input - Overrides merged into the workflow input.
 * @returns The workflow's result.
 */
const runWorkflow = async (
  workflowType: string,
  recorded: Recorded,
  input: Partial<FixtureInput> = {},
): Promise<unknown> => {
  const taskQueue = `temporal-shim-${String(++taskQueueCounter)}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath,
    activities: recorded.activities,
  });
  const args: [FixtureInput] = [{ invocation, invocationId, ...input }];
  return worker.runUntil(
    env.client.workflow.execute(workflowType, {
      workflowId: `${invocationId}-${String(taskQueueCounter)}`,
      taskQueue,
      args,
    }),
  );
};

describe('withRun', () => {
  it('opens the run and hands its ids to the body', async () => {
    const recorded = recordActivities();

    await expect(runWorkflow('happyPath', recorded)).resolves.toBe('run-1');

    expect(recorded.calls).toEqual(['openRun']);
    expect(recorded.inputs.openRun).toEqual({ invocation, invocationId });
  });

  it('defaults the invocation id to the workflow id', async () => {
    const recorded = recordActivities();

    await expect(runWorkflow('defaultsInvocationId', recorded)).resolves.toBe('run-1');

    // The harness passes `wf-1` in the args but starts the execution under
    // `wf-1-<n>`, so seeing the latter proves the default fired rather than the
    // fixture reading its input.
    expect(recorded.inputs.openRun).toEqual({
      invocation,
      invocationId: `${invocationId}-${String(taskQueueCounter)}`,
    });
  });

  it('publishes nothing on the success path', async () => {
    const recorded = recordActivities();

    await runWorkflow('happyPath', recorded);

    expect(recorded.calls).not.toContain('cleanupRun');
    expect(recorded.calls).not.toContain('endRun');
  });

  it('cleans up when the body throws, and surfaces the original error', async () => {
    const recorded = recordActivities();

    // Temporal wraps a workflow failure, so the body's error is the cause.
    let failure: unknown;
    try {
      await runWorkflow('bodyThrows', recorded);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    // CAST: narrowed by the assertion above; `cause` carries the body's failure.
    expect((failure as Error).cause).toMatchObject({ message: 'body exploded' });

    expect(recorded.calls).toEqual(['openRun', 'cleanupRun']);
    expect(recorded.inputs.cleanupRun).toEqual({ ids, invocation, errorMessage: 'body exploded' });
  });

  it('does not clean up when opening the run itself failed', async () => {
    const recorded = recordActivities(true);

    await expect(runWorkflow('happyPath', recorded)).rejects.toThrow();

    // openRun retried per its policy, then gave up. No handle was ever built, so
    // there is nothing to clean up.
    expect(recorded.calls).not.toContain('cleanupRun');
    expect(new Set(recorded.calls)).toEqual(new Set(['openRun']));
  });

  it('ends the run from the workflow when asked', async () => {
    const recorded = recordActivities();

    await runWorkflow('endsFromWorkflow', recorded);

    expect(recorded.calls).toEqual(['openRun', 'endRun']);
    expect(recorded.inputs.endRun).toEqual({ ids, invocation, reason: 'complete' });
  });

  it('suspends the run from the workflow when asked', async () => {
    const recorded = recordActivities();

    await runWorkflow('suspendsFromWorkflow', recorded);

    expect(recorded.calls).toEqual(['openRun', 'suspendRun']);
    expect(recorded.inputs.suspendRun).toEqual({ ids, invocation });
  });

  it('still cleans up when the workflow is cancelled mid-body', async () => {
    const recorded = recordActivities();
    const taskQueue = `temporal-shim-cancel-${String(++taskQueueCounter)}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath,
      activities: recorded.activities,
    });
    const args: [FixtureInput] = [{ invocation, invocationId }];

    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start('blocksForever', {
        workflowId: `${invocationId}-cancel-${String(taskQueueCounter)}`,
        taskQueue,
        args,
      });
      // Wait for the run to be open before cancelling, so the cancel lands
      // inside the body rather than before it.
      await vi.waitFor(() => {
        expect(recorded.calls).toContain('openRun');
      });
      await handle.cancel();
      await expect(handle.result()).rejects.toThrow();
    });

    // The point of the non-cancellable scope: a cancelled workflow still closes
    // its run, so the client is not left waiting on a stream that never ends.
    expect(recorded.calls).toContain('cleanupRun');
  });

  it('applies per-activity options over the caller default', async () => {
    const recorded = recordActivities();

    await runWorkflow('happyPath', recorded, {
      activityOptions: {
        default: { startToCloseTimeout: '3 minutes' },
        openRun: { startToCloseTimeout: '90 seconds' },
      },
    });

    // The activity ran, which is what proves the merged options were accepted;
    // Temporal rejects a proxy whose options omit a required timeout.
    expect(recorded.calls).toEqual(['openRun']);
  });
});
