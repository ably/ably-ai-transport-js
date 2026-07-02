/**
 * Chat API route — receives messages from the client session's HTTP POST and
 * starts a Temporal workflow to drive the agent side. The workflow ID equals
 * the invocation ID; the route waits for the workflow's `openRun` activity to
 * activate the run on the channel and then returns the ids on the HTTP
 * response.
 *
 * A fresh run activates via `ai-run-start`; a continuation activates via
 * `ai-run-resume`. Either carries the run-id in its transport headers, so the
 * route observes both to cover both cases.
 */

import { Client, Connection } from '@temporalio/client';
import type { InvocationData } from '@ably/ai-transport';
import Ably from 'ably';
import type { ChatWorkflowInput } from '../../../worker/shared';
import { TASK_QUEUE } from '../../../worker/shared';

interface ChatResponse {
  runId: string;
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

// Cache the Ably Realtime client across requests: constructing per request
// would open a fresh WebSocket per POST just to observe one message.
let cachedAbly: Ably.Realtime | undefined;

function ablyClient(): Ably.Realtime {
  if (cachedAbly) return cachedAbly;
  cachedAbly = new Ably.Realtime({
    key: process.env.ABLY_API_KEY!,
    ...(process.env.ABLY_ENDPOINT ? { endpoint: process.env.ABLY_ENDPOINT } : {}),
  });
  return cachedAbly;
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

  const runId = await waitForRunActivation(ablyClient(), invocation.sessionName, invocationId, req.signal);

  const body: ChatResponse = { runId, invocationId };
  return Response.json(body);
}

// -----------------------------------------------------------------------------
// waitForRunActivation — demo-local helper. Observes the wire event that
// activates the run — `ai-run-start` for a fresh run, `ai-run-resume` for a
// continuation — published by the worker's `openRun`, and resolves with its
// `run-id`.
//
// This gives access to the `runId` created inside the Temporal workflow so
// the route can include it on the POST response. Nothing currently consumes
// that runId in the response, so we leave it empty.
// -----------------------------------------------------------------------------
async function waitForRunActivation(
  ably: Ably.Realtime,
  channelName: string,
  invocationId: string,
  signal: AbortSignal,
): Promise<string> {
  const channel = ably.channels.get(channelName, { params: { rewind: '10s' } });
  try {
    return await new Promise<string>((resolve, reject) => {
      const abort = (): void =>
        reject(new Error(`wait for ai-run-start/ai-run-resume aborted (invocationId=${invocationId})`));
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });

      // Subscribe to both start and resume: fresh runs publish `ai-run-start`,
      // continuations publish `ai-run-resume`. Both carry `invocation-id` and
      // `run-id` on their transport headers, so the match logic is the same.
      const onActivation = (msg: Ably.InboundMessage): void => {
        if (msg.name !== 'ai-run-start' && msg.name !== 'ai-run-resume') return;
        const t = (msg.extras as { ai?: { transport?: Record<string, string> } } | undefined)?.ai?.transport;
        if (t?.['invocation-id'] === invocationId && t['run-id']) resolve(t['run-id']);
      };

      channel.subscribe(onActivation).catch(reject);
    });
  } finally {
    channel.detach().catch(() => {
      /* best-effort — the channel may already be gone */
    });
  }
}
