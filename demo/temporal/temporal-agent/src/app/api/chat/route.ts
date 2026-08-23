/**
 * Chat API route — receives the invocation pointer the useChat chat-transport
 * POSTs (`{channelName, eventId, runId?}`) and starts a Temporal workflow to
 * drive the agent side. The workflow ID equals the invocation ID.
 *
 * The response carries the run's id, which the chat transport uses to filter
 * its chunk stream. The route derives it without awaiting the workflow: the
 * SDK plugin's `openRun` activity pins a fresh run's id to the invocation id
 * this route passes, and a continuation re-enters the run the trigger's own
 * headers name — so a fresh send answers with the invocation id and a
 * continuation echoes the `runId` the client already holds.
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
  /** The run to continue; absent for a fresh send. */
  runId?: string;
}

/** The response body the chat transport expects. */
interface ChatResponseBody {
  /** The id of the run this invocation opens (fresh) or resumes (continuation). */
  runId: string;
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
  const invocation: InvocationData = { sessionName: request.channelName, inputEventId: request.eventId };
  const invocationId = crypto.randomUUID();

  const client = await temporalClient();
  const args: [ChatWorkflowInput] = [{ invocation, invocationId }];

  await client.workflow.start('chatWorkflow', {
    workflowId: invocationId,
    taskQueue: TASK_QUEUE,
    args,
  });

  // Fresh send: the plugin pins the run id to the invocation id passed above.
  // Continuation: the trigger's own run id wins, and the client sent it here.
  const body: ChatResponseBody = { runId: request.runId ?? invocationId };
  return Response.json(body);
}
