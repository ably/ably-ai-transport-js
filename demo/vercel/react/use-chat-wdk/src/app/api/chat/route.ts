import { start } from 'workflow/api';

import { CLEAR_FAULT_COOKIE, parseFaultCookie } from '@/app/lib/fault';
import { runAitTurn, type AitTurnInput } from '@/app/workflows/ait-turn';

/**
 * Wake the durable agent.
 *
 * The AIT chat transport publishes the user input to the Ably channel, then
 * POSTs the invocation pointer `{ channelName, eventId, runId? }` here and
 * expects `{ runId }` back immediately — streaming happens over Ably
 * afterwards. Instead of running the agent inline, this route `start()`s a
 * Vercel Workflow whose activities open / infer / end the run across separate
 * processes, each publishing over the channel.
 *
 * The response `runId` is derived exactly the way the open activity derives
 * it: a continuation echoes the run it resumes (`body.runId` — on the wire,
 * the trigger's own run-id header), and a fresh turn pins the run to the
 * stable workflow run id (`run:<workflowRunId>`) — the same pin the open
 * activity passes, so a fresh-process retry re-enters the same run.
 *
 * An armed demo fault rides a one-shot cookie (the transport owns the POST
 * body); this route consumes it into the workflow input and clears it.
 */

/** The invocation pointer the chat transport POSTs. */
interface ChatRequestBody {
  /** The Ably channel the conversation lives on. */
  channelName: string;
  /** The `event-id` of the input event that triggered this invocation. */
  eventId: string;
  /** The run to resume, for a tool-result or approval continuation. */
  runId?: string;
}

export async function POST(req: Request): Promise<Response> {
  // CAST: trust boundary — the POST body is this app's own chat transport's JSON.
  const body = (await req.json()) as ChatRequestBody;
  const fault = parseFaultCookie(req.headers.get('cookie'));

  const input: AitTurnInput = {
    channelName: body.channelName,
    eventId: body.eventId,
    ...(fault === undefined ? {} : { fault }),
  };
  const run = await start(runAitTurn, [input]);

  const runId = body.runId ?? `run:${run.runId}`;
  return Response.json(
    { runId },
    // Consume the armed fault: it applies to the turn that carried it, never
    // to a later send.
    fault === undefined ? undefined : { headers: { 'set-cookie': CLEAR_FAULT_COOKIE } },
  );
}
