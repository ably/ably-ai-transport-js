/**
 * The per-activity runtime envelope.
 *
 * Every durable activity in `activities.ts` runs as a SEPARATE WDK process with
 * no shared memory, so each one has to build its own Ably client + AIT
 * `AgentSession`, do its work, and tear the session down. {@link withActivity}
 * is that envelope — the setup an integrator building a WDK + AIT app writes
 * once and reuses for every activity. Hoisting it here keeps the activity
 * bodies a clean read of the AIT SDK calls that matter (createRun / adoptRun /
 * createStep / pipe / send / suspend / end).
 *
 * The envelope ALSO reports each activity's lifecycle to the demo's "WDK
 * processes" panel over a sidecar Ably channel. That telemetry is DEMO
 * INSTRUMENTATION only — a production integration would keep the session build
 * + teardown and drop the `emit` / `reportAitRun` lines. It lives here, out of
 * the activity bodies, for exactly that reason.
 */

import * as Ably from 'ably';
import { getStepMetadata } from 'workflow';
import { Invocation, type InvocationData } from '@ably/ai-transport';
import { createAgentSession } from '@ably/ai-transport/vercel';

import {
  type ActivityEvent,
  type ActivityKind,
  type ActivityPhase,
  wdkActivityChannel,
  WDK_ACTIVITY_EVENT,
} from '../lib/wdk-activity';

/** A connected AIT agent session, codec-specialised to this demo's Vercel setup. */
export type WdkAgentSession = ReturnType<typeof createAgentSession>;

/** A run handle from either entry point — `createRun` (open) or `adoptRun` (later activities). */
export type WdkAgentRun = ReturnType<WdkAgentSession['adoptRun']> | ReturnType<WdkAgentSession['createRun']>;

/** What {@link withActivity} hands the activity body to work with. */
export interface ActivityContext {
  /** This process's connected agent session — torn down (detached) after the body returns or throws. */
  session: WdkAgentSession;
  /** The invocation the client POSTed: the channel name and the triggering input's event id. */
  invocation: Invocation;
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
 * Run one activity's AIT work inside a fresh, connected agent session.
 *
 * On both success and failure the session is DETACHED, never ended: detach
 * leaves any open run OPEN on the wire, which is the durable hand-off seam on
 * success (the next activity adopts it) and what lets a WDK retry adopt + emit
 * a superseding attempt on a throw. Ending would publish `ai-run-end` and mark
 * the run terminal, breaking both.
 *
 * @param invocationData - The invocation pointer the client POSTed (from workflow input).
 * @param workflowRunId - The WDK workflow run id, for the demo panel's grouping.
 * @param kind - Which activity this is, for the demo panel's label.
 * @param body - The activity's actual AIT work.
 * @returns Whatever `body` returns.
 */
export async function withActivity<T>(
  invocationData: InvocationData,
  workflowRunId: string,
  kind: ActivityKind,
  body: (ctx: ActivityContext) => Promise<T>,
): Promise<T> {
  const invocation = Invocation.fromJSON(invocationData);
  const { stepId, attempt } = getStepMetadata();
  const client = makeClient();

  // --- demo instrumentation (drop for production) ---
  let aitRunId: string | undefined;
  const emit = async (phase: ActivityPhase): Promise<void> => {
    try {
      const event: ActivityEvent = { kind, phase, workflowRunId, wdkStepId: stepId, attempt, aitRunId, ts: Date.now() };
      await client.channels.get(wdkActivityChannel(invocation.sessionName)).publish(WDK_ACTIVITY_EVENT, event);
    } catch {
      // Best-effort telemetry: never fail an activity because its sidecar
      // publish didn't land. A throw in `body` deliberately emits nothing — the
      // panel infers the dead attempt from the stuck `running` a retry supersedes.
    }
  };

  const session = createAgentSession({ client, channelName: invocation.sessionName });
  try {
    await session.connect();
    await emit('running');
    const result = await body({ session, invocation, stepId, attempt, reportAitRun: (id) => (aitRunId = id) });
    await emit('done');
    return result;
  } finally {
    try {
      await session.detach();
    } catch {
      // Best-effort: the channel may already be gone; don't mask the body's error.
    }
    client.close();
  }
}
