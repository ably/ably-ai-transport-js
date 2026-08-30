/**
 * Temporal worker entry. Boots one Worker that hosts the chat workflow and
 * its activities on a single task queue. Run with `pnpm dev:worker` (tsx).
 *
 * Two sets of activities are registered. This app's own — inference and tool
 * execution — are passed in `activities`. The run's framing (`openRun`,
 * `endRun`, `suspendRun`, `cleanupRun`) comes from the SDK's plugin, which is
 * why none of them appear in this repo's demo code.
 *
 * Loads `.env.local` explicitly — tsx doesn't do it for you the way Next does.
 * Without this the activities have no ABLY_API_KEY and hang forever on connect.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env.local') });

import { NativeConnection, Worker } from '@temporalio/worker';
import { createAblyTransportPlugin } from '@ably/ai-transport/temporal';
import { createUIMessageSessionCodec } from '@ably/ai-transport/vercel';
import { logger, makeAbly } from './ably.js';
import { bundlerOptions } from './bundler.js';
import * as activities from './activities.js';
import { TASK_QUEUE } from './shared.js';

async function main(): Promise<void> {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });
  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve('./workflows'),
    bundlerOptions,
    activities,
    plugins: [
      createAblyTransportPlugin({
        codec: createUIMessageSessionCodec(),
        createClient: makeAbly,
        logger,
      }),
    ],
  });
  console.log(`worker: listening on ${TASK_QUEUE}`);
  await worker.run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
