/**
 * Module-scope cache of long-lived {@link AgentSession}s and
 * {@link ClientSession}s, keyed by session name. Used inside the Temporal
 * worker process — activities call `getSession` to act as the agent and
 * `getClientSession` to publish user messages on behalf of a parent agent
 * spawning a subagent run.
 */

import * as Ably from 'ably';

import { type AgentSession, type ClientSession, createAgentSession, createClientSession } from '@ably/ai-transport';
import { UIMessageCodec } from '@ably/ai-transport/vercel';

const agentSessions = new Map<string, Promise<AgentSession<typeof UIMessageCodec>>>();
const clientSessions = new Map<string, Promise<ClientSession<typeof UIMessageCodec>>>();
let agentAbly: Ably.Realtime | undefined;
let clientAbly: Ably.Realtime | undefined;

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be set`);
  }
  return value;
};

const getAgentAbly = (): Ably.Realtime => {
  if (!agentAbly) {
    agentAbly = new Ably.Realtime({ key: requireEnv('ABLY_API_KEY'), clientId: 'agent' });
  }
  return agentAbly;
};

// The worker's ClientSession uses a distinct clientId so subagent user
// messages don't appear to come from the human user. The same Ably API key
// is reused — both connections share quotas but are independent for
// presence/clientId purposes.
const getClientAbly = (): Ably.Realtime => {
  if (!clientAbly) {
    clientAbly = new Ably.Realtime({ key: requireEnv('ABLY_API_KEY'), clientId: 'agent-parent' });
  }
  return clientAbly;
};

/**
 * Resolve the cached {@link AgentSession} for `sessionName`. Creates and
 * connects the session on the first call, then returns the same promise
 * on subsequent calls so all callers share one attached subscriber.
 */
export const getSession = (sessionName: string): Promise<AgentSession<typeof UIMessageCodec>> => {
  let session = agentSessions.get(sessionName);
  if (session) return session;
  const next = (async () => {
    const created = createAgentSession({ client: getAgentAbly(), sessionName, codec: UIMessageCodec });
    await created.connect();
    return created;
  })();
  agentSessions.set(sessionName, next);
  return next;
};

/**
 * Resolve the cached {@link ClientSession} for `sessionName`. Used by the
 * subagent-spawn activity to publish a user message and open a new run on
 * behalf of the parent agent — the publish path lives on the client side
 * of the AIT SDK, so the worker keeps a parallel ClientSession alongside
 * its AgentSession.
 */
export const getClientSession = (sessionName: string): Promise<ClientSession<typeof UIMessageCodec>> => {
  let session = clientSessions.get(sessionName);
  if (session) return session;
  const next = (async () => {
    const created = createClientSession({ client: getClientAbly(), sessionName, codec: UIMessageCodec });
    await created.connect();
    return created;
  })();
  clientSessions.set(sessionName, next);
  return next;
};

/**
 * Publish a custom (non-AIT) Ably message on the session's channel. Used
 * by the demo to ferry parent→child run-link metadata across the same
 * channel the AIT session is using, so subscribers (live or hydrating)
 * can reconstruct the subagent tree.
 *
 * The channel name is the session name — see ChannelManager in the SDK.
 * Publishes via the worker's client-side Ably connection so the message
 * is correctly attributed to the parent-agent clientId.
 */
export const publishOnSessionChannel = async (sessionName: string, name: string, data: unknown): Promise<void> => {
  const channel = getClientAbly().channels.get(sessionName);
  await channel.publish(name, data);
};

/**
 * Tear down the cached AgentSession and ClientSession for `sessionName`.
 * Removes them from the cache before awaiting close so a concurrent
 * `getSession` call observes the eviction and creates a fresh entry
 * instead of receiving the about-to-be-closed one. The shared Realtime
 * connections (`agentAbly` / `clientAbly`) stay alive — they're keyed at
 * the process, not the session.
 *
 * Best-effort: AIT session `close()` never rejects, but the cached
 * promise itself can have rejected if the original `connect()` failed.
 * Swallow those so the caller can always finally-block this.
 */
export const closeSession = async (sessionName: string): Promise<void> => {
  const agent = agentSessions.get(sessionName);
  const client = clientSessions.get(sessionName);
  agentSessions.delete(sessionName);
  clientSessions.delete(sessionName);
  await Promise.all([
    agent?.then((s) => s.close()).catch(() => undefined),
    client?.then((s) => s.close()).catch(() => undefined),
  ]);
};
