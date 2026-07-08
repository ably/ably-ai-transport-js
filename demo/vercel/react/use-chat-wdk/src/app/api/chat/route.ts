import type { InvocationData } from '@ably/ai-transport';
import { start } from 'workflow/api';

import type { FaultMode } from '@/app/lib/fault';
import { runAitTurn } from '@/app/workflows/ait-turn';

/**
 * Wake the durable agent.
 *
 * The chat transport publishes the user input to the Ably channel, then
 * fire-and-forget POSTs the run's invocation pointer here. Instead of running the
 * agent inline (as `use-chat` does in `after()`), we `start()` a Vercel Workflow
 * whose activities open / step / end the run across separate processes, each
 * publishing over the Ably channel. The reply reaches the client over Ably, so
 * this response body is informational only (the transport ignores it on success).
 */
export async function POST(req: Request): Promise<Response> {
  // CAST: the POST body is the run's InvocationData ({ inputEventId, sessionName })
  // plus this demo's optional `fault` field, merged in by prepareSendMessagesRequest.
  const data = (await req.json()) as InvocationData & { fault?: FaultMode };
  const invocation: InvocationData = { inputEventId: data.inputEventId, sessionName: data.sessionName };
  const run = await start(runAitTurn, [{ invocation, fault: data.fault }]);
  return Response.json({ workflowRunId: run.runId });
}
