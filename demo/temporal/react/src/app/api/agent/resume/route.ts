/**
 * Resume endpoint — sends a Temporal Update to the paused workflow for
 * the supplied runId, flipping its local `paused` flag back to false.
 * The workflow's `condition(() => !paused)` wakes and the next iteration
 * starts a fresh AIT step which re-activates the run from
 * `'suspended'` per AIT-CS5.
 *
 * The client should also publish `x-ably-resume` directly via
 * `run.resume()` so other observers see the resume as durable channel
 * state. The Update is the in-process wake-up that's reliable for the
 * long-lived workflow.
 */

import { resumeUpdate } from '../../../../temporal/workflows';
import { getTemporalClient } from '../../../../lib/temporal-client';
import { workflowIdForRun } from '../../../../lib/temporal-ids';

interface ResumeRequestBody {
  /** The AIT run id whose workflow should be resumed. */
  runId: string;
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as ResumeRequestBody;
  if (typeof body.runId !== 'string' || body.runId.length === 0) {
    return new Response('runId required', { status: 400 });
  }

  const client = await getTemporalClient();
  const handle = client.workflow.getHandle(workflowIdForRun(body.runId));
  try {
    await handle.executeUpdate(resumeUpdate);
  } catch (err) {
    // Workflow not running (e.g. user called resume before any pause
    // workflow was started, or the workflow already exited). Best-
    // effort — return 202 either way; the channel publish (driven by
    // run.resume()) is the durable record other observers see.
    console.warn('[resume] update failed', err);
    return new Response(null, { status: 202 });
  }
  return new Response(null, { status: 202 });
}
