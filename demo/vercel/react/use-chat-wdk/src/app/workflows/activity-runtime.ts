/**
 * The per-activity runtime envelope.
 *
 * Every durable activity in `activities.ts` runs as a SEPARATE WDK process with
 * no shared memory, so each one builds its own Ably client, connects a
 * standalone AIT `AgentTransport` on the conversation's channel, does one unit
 * of work, and tears both down. Closing the transport publishes NO terminal —
 * that is the durable hand-off discipline: a run an activity leaves open stays
 * open on the wire for the next activity (or a WDK retry) to re-enter via
 * `openRun`.
 *
 * The envelope ALSO reports each activity's lifecycle to the demo's "WDK
 * processes" panel over a sidecar Ably channel. That telemetry is DEMO
 * INSTRUMENTATION only — a production integration would keep the transport
 * build + teardown and drop the `emit` / `reportAitRun` lines. It lives here,
 * out of the activity bodies, for exactly that reason.
 */

import * as Ably from 'ably';
import { getStepMetadata } from 'workflow';
import { createAgentTransport } from '@ably/ai-transport/vercel';

import {
  type ActivityEvent,
  type ActivityKind,
  type ActivityPhase,
  wdkActivityChannel,
  WDK_ACTIVITY_EVENT,
} from '../lib/wdk-activity';
import type { WdkAgentTransport } from './history';

/** What {@link withActivity} hands the activity body to work with. */
export interface ActivityContext {
  /** This process's connected agent transport — closed (no terminal published) after the body returns or throws. */
  transport: WdkAgentTransport;
  /** The WDK step id — stable across retries; key the AIT step on it so a retry supersedes the dead attempt. */
  stepId: string;
  /** The 1-based WDK attempt number; bumps when WDK re-runs this activity after a throw. */
  attempt: number;
  /** Correlate this activity's demo telemetry to the AIT run it drives, once the run id is known. */
  reportAitRun: (runId: string) => void;
}

function makeClient(): Ably.Realtime {
  const key = process.env.ABLY_API_KEY;
  if (!key) throw new Error('ABLY_API_KEY is not set');
  const endpoint = process.env.ABLY_ENDPOINT;
  return new Ably.Realtime({ key, ...(endpoint ? { endpoint } : {}) });
}

/**
 * Run one activity's AIT work against a fresh, connected agent transport.
 *
 * `connect()` happens after the trigger already exists on the channel (the
 * client publishes before it POSTs, and the workflow starts after that), so
 * the transport's attach point bounds `locateInput` and `history` to a window
 * that contains everything the activity needs.
 *
 * @param channelName - The conversation's Ably channel.
 * @param workflowRunId - The WDK workflow run id, for the demo panel's grouping.
 * @param kind - Which activity this is, for the demo panel's label.
 * @param body - The activity's actual AIT work.
 * @returns Whatever `body` returns.
 */
export async function withActivity<T>(
  channelName: string,
  workflowRunId: string,
  kind: ActivityKind,
  body: (ctx: ActivityContext) => Promise<T>,
): Promise<T> {
  const { stepId, attempt } = getStepMetadata();
  const client = makeClient();

  // --- demo instrumentation (drop for production) ---
  let aitRunId: string | undefined;
  const emit = async (phase: ActivityPhase): Promise<void> => {
    try {
      const event: ActivityEvent = { kind, phase, workflowRunId, wdkStepId: stepId, attempt, aitRunId, ts: Date.now() };
      await client.channels.get(wdkActivityChannel(channelName)).publish(WDK_ACTIVITY_EVENT, event);
    } catch {
      // Best-effort telemetry: never fail an activity because its sidecar
      // publish didn't land. A throw in `body` deliberately emits nothing — the
      // panel infers the dead attempt from the stuck `running` a retry supersedes.
    }
  };

  try {
    const transport = createAgentTransport({ channel: client.channels.get(channelName), clientId: 'wdk-agent' });
    await transport.connect();
    try {
      await emit('running');
      const result = await body({ transport, stepId, attempt, reportAitRun: (id) => (aitRunId = id) });
      await emit('done');
      return result;
    } finally {
      transport.close();
    }
  } finally {
    client.close();
  }
}
