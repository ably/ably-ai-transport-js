/**
 * Deterministic tests for the chat workflow. Drives it in Temporal's
 * `TestWorkflowEnvironment` with mocked activities. Since terminal
 * lifecycle publishing lives inside the activities (not the workflow),
 * these tests only assert on the workflow's routing decisions: which
 * activities it schedules, in what order, and when it returns.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { InvocationData, RunIdentity } from '@ably/ai-transport';

import { bundlerOptions } from '../bundler';
import { chatWorkflow } from '../workflows';
import type { InferenceOutcome } from '../shared';

const workflowsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../workflows.ts');

const invocation: InvocationData = { sessionName: 'ai:test', inputEventId: 'evt-1' };
const invocationId = 'wf-1';
const runIds: RunIdentity = { runId: 'run-1', invocationId };

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping({ server: { extraArgs: [] } });
});

afterAll(async () => {
  await env?.teardown();
});

/**
 * Mock activities. openRun just opens the run and returns its ids (no outcome);
 * runInferenceStep consumes outcomes from `outcomes` in order — the first call
 * is the workflow's first inference. runToolStep just records the call.
 */
function makeWorker(outcomes: InferenceOutcome[]) {
  const calls: string[] = [];
  let outcomeIdx = 0;
  const activities = {
    openRun: vi.fn(async (): Promise<RunIdentity> => {
      calls.push('openRun');
      return runIds;
    }),
    runInferenceStep: vi.fn(async (): Promise<InferenceOutcome> => {
      calls.push('runInferenceStep');
      const outcome = outcomes[outcomeIdx++];
      if (!outcome) throw new Error('runInferenceStep called more times than mocked');
      return outcome;
    }),
    runToolStep: vi.fn(async () => {
      calls.push('runToolStep');
    }),
    cleanupRun: vi.fn(async () => {
      calls.push('cleanupRun');
    }),
  };
  return { activities, calls };
}

let taskQueueCounter = 0;
async function runWorkflow(activities: ReturnType<typeof makeWorker>['activities']) {
  const taskQueue = `test-${++taskQueueCounter}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath,
    bundlerOptions,
    activities,
  });
  await worker.runUntil(
    env.client.workflow.execute(chatWorkflow, {
      workflowId: `${invocationId}-${taskQueueCounter}`,
      taskQueue,
      args: [{ invocation, invocationId }],
    }),
  );
}

describe('chatWorkflow', () => {
  it('single-turn complete: openRun -> runInferenceStep', async () => {
    const { activities, calls } = makeWorker([{ kind: 'complete' }]);
    await runWorkflow(activities);
    expect(calls).toEqual(['openRun', 'runInferenceStep']);
    expect(activities.runToolStep).not.toHaveBeenCalled();
  });

  it('server-tools loops: openRun -> runInferenceStep -> runToolStep*N -> runInferenceStep', async () => {
    const { activities, calls } = makeWorker([
      {
        kind: 'server-tools',
        serverToolCalls: [
          { toolCallId: 'call-1', toolName: 'getWeather', input: { location: 'Paris' } },
          { toolCallId: 'call-2', toolName: 'getStockPrice', input: { symbol: 'AAPL' } },
        ],
      },
      { kind: 'complete' },
    ]);
    await runWorkflow(activities);
    expect(calls).toEqual(['openRun', 'runInferenceStep', 'runToolStep', 'runToolStep', 'runInferenceStep']);
  });

  it('suspend exits after the first runInferenceStep', async () => {
    const { activities, calls } = makeWorker([{ kind: 'suspend' }]);
    await runWorkflow(activities);
    expect(calls).toEqual(['openRun', 'runInferenceStep']);
    expect(activities.runToolStep).not.toHaveBeenCalled();
  });

  it('error exits after the first runInferenceStep', async () => {
    const { activities, calls } = makeWorker([{ kind: 'error', errorMessage: 'boom' }]);
    await runWorkflow(activities);
    expect(calls).toEqual(['openRun', 'runInferenceStep']);
  });

  it('cancelled exits after the first runInferenceStep', async () => {
    const { activities, calls } = makeWorker([{ kind: 'cancelled' }]);
    await runWorkflow(activities);
    expect(calls).toEqual(['openRun', 'runInferenceStep']);
  });

  it('runs cleanupRun when a follow-up activity fails past retries', async () => {
    const { activities, calls } = makeWorker([
      { kind: 'server-tools', serverToolCalls: [{ toolCallId: 'c1', toolName: 'x', input: {} }] },
    ]);
    activities.runToolStep.mockImplementation(async () => {
      calls.push('runToolStep');
      throw new Error('tool broken');
    });
    await expect(runWorkflow(activities)).rejects.toThrow();
    expect(calls).toContain('cleanupRun');
  });

  // Regression: if `runToolStep` publishes `ai-run-end` on a retryable throw,
  // the retry finds the run terminal and cannot publish. The activity must
  // instead close its transport without a terminal and let the workflow's
  // retry policy carry through — this test simulates the intentional-flake
  // pattern (`getStockPrice`: throw on an odd price, succeed once it rolls
  // even) and asserts the workflow completes through a runToolStep retry.
  it('workflow completes when runToolStep fails once and succeeds on retry', async () => {
    const { activities, calls } = makeWorker([
      { kind: 'server-tools', serverToolCalls: [{ toolCallId: 'c1', toolName: 'x', input: {} }] },
      { kind: 'complete' },
    ]);
    let attempt = 0;
    activities.runToolStep.mockImplementation(async () => {
      attempt += 1;
      calls.push(`runToolStep-attempt-${attempt}`);
      if (attempt === 1) throw new Error('transient failure — retry me');
    });
    await runWorkflow(activities);
    expect(attempt).toBe(2);
    expect(calls).toEqual([
      'openRun',
      'runInferenceStep',
      'runToolStep-attempt-1',
      'runToolStep-attempt-2',
      'runInferenceStep',
    ]);
    expect(activities.cleanupRun).not.toHaveBeenCalled();
  });

  // The split's payoff: openRun returns ids BEFORE any inference runs, so an
  // inference failure past retries still leaves the workflow holding ids —
  // cleanupRun ends the run 'error' instead of orphaning an active run.
  it('runs cleanupRun when the first inference fails past retries', async () => {
    const { activities, calls } = makeWorker([]);
    activities.runInferenceStep.mockImplementation(async (): Promise<InferenceOutcome> => {
      calls.push('runInferenceStep');
      throw new Error('inference broken');
    });
    await expect(runWorkflow(activities)).rejects.toThrow();
    expect(calls).toContain('openRun');
    expect(calls).toContain('cleanupRun');
  });
});
