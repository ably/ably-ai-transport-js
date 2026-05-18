/**
 * Temporal worker entry point. Run with `npm run worker` alongside
 * `npm run dev`.
 *
 * The worker registers the demo's activities — `openRun`, `streamStep`,
 * `endRun` — and polls the configured task queue. The {@link AgentSession}
 * for the session name is pre-warmed before the worker starts polling, so
 * the channel is attached and subscribed before any client publishes onto
 * it. Without this, the first user message can race the worker's first
 * activity execution and land before the agent subscribes.
 */

import { NativeConnection, Worker } from '@temporalio/worker';

import { getClientSession, getSession } from '../lib/agent-session';
import * as activities from './activities';

const TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE ?? 'ai-transport-chat';
const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
const NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? 'default';

const resolveSessionName = (base: string, namespace: string | undefined): string =>
  namespace !== undefined && namespace.length > 0 ? `${namespace}:${base}` : base;

async function run(): Promise<void> {
  const baseName = process.env.NEXT_PUBLIC_ABLY_SESSION ?? 'demo-session';
  const namespace = process.env.NEXT_PUBLIC_ABLY_NAMESPACE;
  const sessionName = resolveSessionName(baseName, namespace);

  // Pre-warm both sessions in parallel so the worker can act as agent
  // (subscribe / publish step output) and as client (publish subagent
  // user messages) without paying a connect cost on the hot path.
  await Promise.all([getSession(sessionName), getClientSession(sessionName)]);
  // eslint-disable-next-line no-console
  console.log(`[worker] agent and client sessions "${sessionName}" pre-warmed`);

  const connection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS });
  try {
    const worker = await Worker.create({
      connection,
      namespace: NAMESPACE,
      taskQueue: TASK_QUEUE,
      workflowsPath: require.resolve('./workflows'),
      activities,
    });
    // eslint-disable-next-line no-console
    console.log(`[worker] polling task queue "${TASK_QUEUE}" at ${TEMPORAL_ADDRESS}`);
    await worker.run();
  } finally {
    await connection.close();
  }
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
