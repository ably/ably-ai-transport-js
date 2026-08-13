/**
 * Chat API route — receives messages from the client session's HTTP POST and
 * starts a Temporal workflow to drive the agent side. The workflow ID equals
 * the invocation ID.
 *
 * The SDK plugin's `openRun` activity, which the workflow schedules first,
 * activates the run on the Ably channel
 * (`ai-run-start` for a fresh run, `ai-run-resume` for a continuation); the
 * client resolves `run.started` from that channel event, not from this
 * response, so the route returns as soon as the workflow is started.
 */

import { Client, Connection } from '@temporalio/client';
import type { InvocationData } from '@ably/ai-transport';
import type { ChatWorkflowInput } from '../../../worker/shared';
import { TASK_QUEUE } from '../../../worker/shared';

interface ChatResponse {
  invocationId: string;
}

// Cache the Temporal client + connection across requests: creating a Connection
// per request would open a fresh gRPC socket per POST.
let cachedTemporal: Client | undefined;

async function temporalClient(): Promise<Client> {
  if (cachedTemporal) return cachedTemporal;
  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });
  cachedTemporal = new Client({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
  });
  return cachedTemporal;
}

export async function POST(req: Request): Promise<Response> {
  const invocation = (await req.json()) as InvocationData;
  const invocationId = crypto.randomUUID();

  const client = await temporalClient();
  const args: [ChatWorkflowInput] = [{ invocation, invocationId }];

  await client.workflow.start('chatWorkflow', {
    workflowId: invocationId,
    taskQueue: TASK_QUEUE,
    args,
  });

  const body: ChatResponse = { invocationId };
  return Response.json(body);
}
