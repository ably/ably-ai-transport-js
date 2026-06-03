/**
 * Wraps the two paths chat-js uses (see ChatClient._addAgent): the
 * `options.agents` mutation (read by ably-js when opening the initial
 * WebSocket) and the `params.agent` channel option (sent on ATTACH so
 * an already-open connection still carries the identifier).
 *
 * `options.agents` is a private API on the Realtime client — no public
 * typed accessor exists in the `ably` package — so this module casts to a
 * `RealtimeWithOptions` shape to write it.
 */

import type * as Ably from 'ably';

import { VERSION } from '../version.js';

interface RealtimeWithOptions extends Ably.Realtime {
  options: { agents?: Record<string, string | undefined> };
}

const SDK_NAME = 'ai-transport-js';

/** Internal shape a codec may carry to opt into Ably-Agent header registration. */
interface AdapterTagHolder {
  readonly adapterTag?: string;
}

/**
 * Merge `agents` into `client.options.agents` and return the space-separated
 * `params.agent` string for channel ATTACH.
 * @param client - The Ably Realtime client to mutate.
 * @param agents - Map of agent-name to version strings to register.
 * @returns Channel options containing `params.agent` for `channels.get`.
 */
const injectAgents = (
  client: Ably.Realtime,
  // CAST: Ably.Realtime's public type omits `options.agents`, but the SDK
  // does carry it at runtime. ably-chat-js relies on the same shape — see
  // ChatClient._addAgent in https://github.com/ably/ably-chat-js.
  agents: Record<string, string>,
): { params: { agent: string } } => {
  const realtime = client as RealtimeWithOptions;
  realtime.options.agents = { ...realtime.options.agents, ...agents };
  return { params: { agent: joinAgents(agents) } };
};

/**
 * Build the agent-name → version map this SDK registers for the given codec.
 * @param codec - The codec instance; cast to {@link AdapterTagHolder} to detect an optional identifier.
 * @returns Map of agent name to version, always including this SDK.
 */
const buildAgents = (codec?: unknown): Record<string, string> => {
  // CAST: AdapterTagHolder is an internal opt-in shape — not part of the public Codec interface.
  const adapterTag = (codec as AdapterTagHolder | undefined)?.adapterTag;
  const agents: Record<string, string> = { [SDK_NAME]: VERSION };
  if (adapterTag) agents[adapterTag] = VERSION;
  return agents;
};

/**
 * Render an agents map as the space-separated `name/version` string Ably expects.
 * @param agents - Map of agent name to version.
 * @returns The space-separated `name/version` agent string.
 */
const joinAgents = (agents: Record<string, string>): string =>
  Object.entries(agents)
    .map(([name, version]) => `${name}/${version}`)
    .join(' ');

/**
 * The space-separated `params.agent` string this SDK stamps on channel ATTACH —
 * `ai-transport-js/<version>` plus the codec's adapter tag when present. Pure:
 * unlike {@link registerAgent} it does not mutate the client. Use it to seed a
 * `<ChannelProvider options>` so ably-js's React hooks append their own agent
 * additively (`channelOptionsForReactHooks`) rather than overwriting this SDK's.
 * @param codec - The codec instance; cast to {@link AdapterTagHolder} to detect an optional identifier.
 * @returns The channel `params.agent` string.
 */
export const channelAgent = (codec?: unknown): string => joinAgents(buildAgents(codec));

/**
 * Register this SDK (and optionally a codec) on the supplied Realtime client
 * and return the channel options the caller should pass to
 * `client.channels.get(...)` so the agent is also carried on channel ATTACH.
 * Sets `options.agents['ai-transport-js'] = VERSION`. When the codec carries
 * an internal `adapterTag` field (via {@link AdapterTagHolder}), also sets
 * `options.agents[adapterTag] = VERSION`.
 * Idempotent — repeated calls with the same client and codec produce the same keys/values.
 * Spec: AIT-CT1a, AIT-CT1a2, AIT-CT1a3, AIT-ST1a, AIT-ST1a2, AIT-ST1a3.
 * @param client - The Ably Realtime client to register on.
 * @param codec - The codec instance; cast to {@link AdapterTagHolder} to detect an optional identifier.
 * @returns Channel options containing `params.agent` for `channels.get`.
 */
export const registerAgent = (client: Ably.Realtime, codec?: unknown): { params: { agent: string } } =>
  injectAgents(client, buildAgents(codec));
