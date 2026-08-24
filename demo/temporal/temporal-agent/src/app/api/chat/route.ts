/**
 * Chat API route — receives the invocation pointer the useChat chat-transport
 * POSTs (`{channelName, eventId}`) and starts a Temporal workflow to drive the
 * agent side. The workflow ID equals the invocation ID.
 *
 * The POST only wakes the agent: it answers 202 and the client reads nothing
 * from the body. The run id reaches the client over the channel, on the
 * `ai-run-start` the plugin's `openRun` activity publishes — pinned to the
 * invocation id this route passes, so a retried process re-enters the same
 * run.
 */

import { Client, Connection } from '@temporalio/client';
import type { InvocationData } from '@ably/ai-transport';
import type { ChatWorkflowInput } from '../../../worker/shared';
import { TASK_QUEUE } from '../../../worker/shared';

/** The invocation pointer the chat transport POSTs. */
interface ChatRequestBody {
  /** The Ably channel the conversation lives on. */
  channelName: string;
  /** The `event-id` of the triggering input event on the channel. */
  eventId: string;
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
  // CAST: trust boundary — the body is this app's own chat transport's JSON.
  const request = (await req.json()) as ChatRequestBody;
  const invocation: InvocationData = { channelName: request.channelName, inputEventId: request.eventId };
  const invocationId = crypto.randomUUID();

  const client = await temporalClient();
  const args: [ChatWorkflowInput] = [{ invocation, invocationId }];

  await client.workflow.start('chatWorkflow', {
    workflowId: invocationId,
    taskQueue: TASK_QUEUE,
    args,
  });

  return new Response('', { status: 202 });
}
