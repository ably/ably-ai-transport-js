import { start } from 'workflow/api';

import { CLEAR_FAULT_COOKIE, parseFaultCookie } from '@/app/lib/fault';
import { runAitTurn, type AitTurnInput } from '@/app/workflows/ait-turn';

/**
 * Wake the durable agent.
 *
 * The AIT chat transport publishes the user input to the Ably channel, then
 * POSTs the invocation pointer `{ channelName, eventId }` here. The POST only
 * wakes the agent: the client resolves the run id off the channel and reads
 * nothing from this response, and streaming happens over Ably. Instead of
 * running the agent inline, this route `start()`s a Vercel Workflow whose
 * activities open / infer / end the run across separate processes, each
 * publishing over the channel.
 *
 * The workflow pins its run to the stable workflow run id
 * (`run:<workflowRunId>`), so a fresh-process retry re-enters the same run.
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
  await start(runAitTurn, [input]);

  return new Response('', {
    status: 202,
    // Consume the armed fault: it applies to the turn that carried it, never
    // to a later send.
    ...(fault === undefined ? {} : { headers: { 'set-cookie': CLEAR_FAULT_COOKIE } }),
  });
}
