/**
 * Basic-chat agent endpoint, Temporal edition.
 *
 * Where the Vercel demo's `/api/agent` runs the streaming exchange inline,
 * this route hands the {@link Invocation} off to a Temporal workflow. The
 * workflow's single activity acquires the cached {@link AgentSession} in
 * the worker process and drives the run/step/pipe lifecycle there.
 *
 * The route returns immediately once the workflow is queued — the streamed
 * response is delivered to the browser over Ably, not over this HTTP
 * connection.
 */

import { Invocation, type InvocationData } from '@ably/ai-transport';

import { getTemporalClient } from '../../../lib/temporal-client';
import { chatTurn } from '../../../temporal/workflows';

const TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE ?? 'ai-transport-chat';

export async function POST(req: Request): Promise<Response> {
  const data = (await req.json()) as InvocationData;
  const invocation = Invocation.fromJSON(data);

  const client = await getTemporalClient();
  await client.workflow.start(chatTurn, {
    taskQueue: TASK_QUEUE,
    args: [invocation.toJSON()],
    workflowId: `chat-turn-${invocation.runId}-${invocation.stepId ?? crypto.randomUUID()}`,
  });

  return new Response(null, { status: 202 });
}
