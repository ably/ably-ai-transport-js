/**
 * Record the workflow-history fixture the replay test guards.
 *
 * The replay test re-runs the CURRENT shim against a recorded history and fails if
 * the two disagree. That is what stops an SDK release breaking workflows that are
 * already running: an execution started on one version can finish on another, and
 * Temporal jams if the newer code makes different decisions.
 *
 * Run this only when the shim's command sequence changes DELIBERATELY. It needs a
 * local Temporal dev server and the Temporal CLI, because the CLI is what emits
 * canonical proto3 JSON — the in-process `fetchHistory()` returns an internal
 * representation that does not survive `JSON.stringify`.
 *
 *   temporal server start-dev                       # in another terminal
 *   pnpm tsx scripts/record-temporal-history.ts
 *
 * Then read the diff. A changed history means in-flight executions would break on
 * upgrade, so it should be a decision, not a surprise.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';

import type { FixtureInput } from '../test/temporal/workflows/fixtures.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const workflowsPath = path.resolve(here, '../test/temporal/workflows/fixtures.ts');
const fixturePath = path.resolve(here, '../test/temporal/fixtures/with-run-history.json');

const ADDRESS = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
const TASK_QUEUE = 'record-with-run';
// Fixed so a re-record replaces the same execution rather than accumulating.
const WORKFLOW_ID = 'record-with-run-fixture';

const ids = { runId: 'run-1', invocationId: 'wf-1' };

const main = async (): Promise<void> => {
  const nativeConnection = await NativeConnection.connect({ address: ADDRESS });
  const connection = await Connection.connect({ address: ADDRESS });
  try {
    const worker = await Worker.create({
      connection: nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath,
      activities: {
        openRun: () => Promise.resolve(ids),
        endRun: () => Promise.resolve(),
        suspendRun: () => Promise.resolve(),
        cleanupRun: () => Promise.resolve(),
      },
    });

    const client = new Client({ connection });
    const args: [FixtureInput] = [
      { invocation: { inputEventId: 'evt-1', channelName: 'ai:test' }, invocationId: 'wf-1' },
    ];

    await worker.runUntil(
      client.workflow.execute('happyPath', { workflowId: WORKFLOW_ID, taskQueue: TASK_QUEUE, args }),
    );

    const json = execFileSync(
      'temporal',
      ['workflow', 'show', '--workflow-id', WORKFLOW_ID, '--address', ADDRESS, '--output', 'json'],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );

    mkdirSync(path.dirname(fixturePath), { recursive: true });
    writeFileSync(fixturePath, `${JSON.stringify(JSON.parse(json), undefined, 2)}\n`);
    console.log(`wrote ${fixturePath}`);
  } finally {
    await nativeConnection.close();
    await connection.close();
  }
};

await main();
