/**
 * Module-scope cache of long-lived {@link AgentSession}s, keyed by session
 * name. Used inside the Temporal worker process — the activity calls
 * `getSession` to acquire (or reuse) a session whose channel is already
 * attached and hydrated from history before the activity tries to publish
 * onto it.
 */

import * as Ably from 'ably';

import { type AgentSession, createAgentSession } from '@ably/ai-transport';
import { UIMessageCodec } from '@ably/ai-transport/vercel';

const sessions = new Map<string, Promise<AgentSession<typeof UIMessageCodec>>>();
let ably: Ably.Realtime | undefined;

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be set`);
  }
  return value;
};

const getAbly = (): Ably.Realtime => {
  if (!ably) {
    ably = new Ably.Realtime({ key: requireEnv('ABLY_API_KEY'), clientId: 'agent' });
  }
  return ably;
};

/**
 * Resolve the cached {@link AgentSession} for `sessionName`. Creates and
 * connects the session on the first call, then returns the same promise
 * on subsequent calls so all callers share one attached subscriber.
 */
export const getSession = (sessionName: string): Promise<AgentSession<typeof UIMessageCodec>> => {
  let session = sessions.get(sessionName);
  if (session) return session;
  const next = (async () => {
    const created = createAgentSession({ client: getAbly(), sessionName, codec: UIMessageCodec });
    await created.connect();
    return created;
  })();
  sessions.set(sessionName, next);
  return next;
};
