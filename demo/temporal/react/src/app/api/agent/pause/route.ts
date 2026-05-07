/**
 * Pause endpoint — sends a Temporal Update to the running workflow for
 * the supplied runId, flipping its local `paused` flag. The workflow
 * suspends the run on its next loop iteration boundary (after the
 * current step has run to completion — mid-step pause is not supported
 * in this iteration).
 *
 * The client should also publish `x-ably-pause` directly via
 * `run.pause()` so other observers (multi-device, history hydration)
 * see the pause as durable channel state. The Update is the in-process
 * wake-up that's reliable for the long-lived workflow; the channel
 * publish is the durability story.
 */

import { pauseUpdate } from '../../../../temporal/workflows';
import { getTemporalClient } from '../../../../lib/temporal-client';
import { workflowIdForRun } from '../../../../lib/temporal-ids';

interface PauseRequestBody {
  /** The AIT run id whose workflow should be paused. */
  runId: string;
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as PauseRequestBody;
  if (typeof body.runId !== 'string' || body.runId.length === 0) {
    return new Response('runId required', { status: 400 });
  }

  const client = await getTemporalClient();
  const handle = client.workflow.getHandle(workflowIdForRun(body.runId));
  try {
    await handle.executeUpdate(pauseUpdate);
  } catch (err) {
    // Workflow not running (already finished, never started, or wrong
    // runId). Pause is best-effort — return 202 either way; the channel
    // publish (driven by run.pause()) is the durable record.
    console.warn('[pause] update failed', err);
    return new Response(null, { status: 202 });
  }
  return new Response(null, { status: 202 });
}
