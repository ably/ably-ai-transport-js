/**
 * The Temporal worker. It runs the chat workflows, the AI SDK plugin's model
 * Activities, and the relay, which publishes each chat workflow's stream to
 * Ably through AI Transport's Vercel adaptor.
 */

import { vercelTemporalRelayAdaptor } from '@ably/ai-transport/vercel';
import { createRealtimeChannelPool } from '@ably/pubsub-server';
import { AblyRelayPlugin } from '@ably/pubsub-server/temporal';
import { NativeConnection, Worker } from '@temporalio/worker';
import { AiSdkPlugin } from '@temporalio/vercel-ai-sdk';

import { TASK_QUEUE } from '../shared/chat';
import { createModelProvider } from './model';

async function main(): Promise<void> {
  const key = process.env.ABLY_API_KEY;
  if (key === undefined) throw new Error('ABLY_API_KEY is not set');

  // The relay publishes through a pool of realtime clients. The plugin
  // borrows it: open it before the worker runs, close it after.
  const pool = createRealtimeChannelPool({ key });
  await pool.open();

  const worker = await Worker.create({
    connection: await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' }),
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve('./workflows'),
    plugins: [
      new AiSdkPlugin({ modelProvider: createModelProvider() }),
      // The routes in workflows.ts name this adaptor `vercel`.
      new AblyRelayPlugin({ pool, adaptors: { vercel: vercelTemporalRelayAdaptor() } }),
    ],
  });

  try {
    await worker.run();
  } finally {
    await pool.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
