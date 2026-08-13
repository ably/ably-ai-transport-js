/**
 * Replay test: the tripwire that stops an SDK release breaking workflows that are
 * already running.
 *
 * Temporal recovers a workflow by re-running its code from the beginning and
 * checking the decisions match what is recorded in history. Because we ship
 * workflow-side code, an execution started on one SDK version can finish on
 * another — and if the newer code schedules anything differently, that execution
 * jams. Replaying a recorded history against the current shim catches exactly
 * that.
 *
 * When this fails, the shim's command sequence changed. That is not automatically
 * wrong, but it does mean in-flight executions would break on upgrade, so it has
 * to be a deliberate call. Re-record with:
 *
 *   pnpm tsx scripts/record-temporal-history.ts
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Worker } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const workflowsPath = path.resolve(here, 'workflows/fixtures.ts');
const fixturePath = path.resolve(here, 'fixtures/with-run-history.json');

describe('withRun replay', () => {
  it('replays a recorded history without a determinism violation', async () => {
    // `runReplayHistory` accepts the raw JSON shape and converts it itself, so
    // there is no need to reach for `historyFromJSON` (which is not exported
    // publicly).
    const history: unknown = JSON.parse(readFileSync(fixturePath, 'utf8'));

    await expect(Worker.runReplayHistory({ workflowsPath }, history)).resolves.toBeUndefined();
  });
});
