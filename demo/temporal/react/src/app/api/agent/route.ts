/**
 * Basic-chat agent endpoint, Temporal edition.
 *
 * The route hands the {@link Invocation} off to the {@link runAgent}
 * workflow. The workflow drives the model loop using the Vercel AI
 * SDK's `streamText` from inside an activity — every iteration becomes
 * one AIT step on the Ably channel, and one Temporal activity in the
 * workflow's event history.
 *
 * The route returns immediately once the workflow is queued — the
 * streamed response is delivered to the browser over Ably, not over
 * this HTTP connection. The body extends {@link InvocationData} with
 * the demo's `simulateFail` switch (see `chat.tsx` for the client side).
 */

import { Invocation, type InvocationData } from '@ably/ai-transport';

import { getTemporalClient } from '../../../lib/temporal-client';
import { runAgent, type RunAgentInput } from '../../../temporal/workflows';

const TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE ?? 'ai-transport-chat';

interface AgentRequestBody extends InvocationData {
  /**
   * When true, the workflow's first iteration publishes a few text-delta
   * chunks then errors so the run lands as `'failed'`. Used by the retry
   * demo to produce a deterministic failed run without needing the model
   * to actually error.
   */
  simulateFail?: boolean;
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as AgentRequestBody;
  const invocation = Invocation.fromJSON(body);
  const simulateFail = body.simulateFail === true;

  const client = await getTemporalClient();
  const input: RunAgentInput = { ...invocation.toJSON(), simulateFail };
  await client.workflow.start(runAgent, {
    taskQueue: TASK_QUEUE,
    args: [input],
    workflowId: `run-agent-${invocation.runId}-${invocation.stepId ?? crypto.randomUUID()}`,
  });

  return new Response(null, { status: 202 });
}
