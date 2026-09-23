/**
 * Wraps the two paths chat-js uses (see ChatClient._addAgent): the
 * `options.agents` mutation (read by ably-js when opening the initial
 * WebSocket) and the `params.agent` channel option (sent on ATTACH so
 * an already-open connection still carries the identifier).
 *
 * `options.agents` is a private API on the Realtime client — no public
 * typed accessor exists in the `ably` package — so this module casts to a
 * `RealtimeWithOptions` shape to write it.
 *
 * The identifier names the SDK, the code path that opened the channel, the
 * durable runtime driving it where the SDK knows one, and the codec. The two
 * paths render that list differently; see {@link toAgentMap} for why.
 */

import type * as Ably from 'ably';

import { VERSION } from '../version.js';

interface RealtimeWithOptions extends Ably.Realtime {
  options: { agents?: Record<string, string | undefined> };
}

const SDK_NAME = 'ai-transport-js';

/**
 * Which SDK code path opened the channel. Unrelated to a run's status, which
 * also uses the word `streaming`.
 *
 * `streaming` covers the plain client and agent sessions. `durable-sessions`
 * covers any session built through the durable scaffold, whatever runtime
 * drives it.
 */
export type AgentLayer = 'streaming' | 'durable-sessions';

/** The durable runtime driving the session, where the SDK builds the session itself. */
export type AgentRuntime = 'temporal';

/** What the SDK reports about itself on a channel. */
export interface AgentIdentity {
  /** The code path that opened the channel. */
  readonly layer: AgentLayer;
  /** The durable runtime, omitted when the SDK cannot know it. */
  readonly runtime?: AgentRuntime;
}

/** One entry of the agent identifier. */
interface AgentToken {
  /** The registered agent name. */
  readonly name: string;
  /** Omitted for a token Ably treats as unversioned. */
  readonly version?: string;
}

/**
 * Build the ordered token list for an identity and codec.
 *
 * Order is fixed: this SDK, the layer, the runtime where known, then the
 * codec's adapter tag.
 * @param identity - The code path and runtime opening the channel.
 * @param codec - The codec instance whose optional identifier opts into registration.
 * @param codec.adapterTag - The optional Ably-Agent identifier; registered as an agent when present.
 * @returns The tokens, in the order they appear in the identifier.
 */
const buildTokens = (identity: AgentIdentity, codec?: { readonly adapterTag?: string }): readonly AgentToken[] => {
  const tokens: AgentToken[] = [{ name: SDK_NAME, version: VERSION }, { name: identity.layer }];
  if (identity.runtime) tokens.push({ name: identity.runtime });
  const adapterTag = codec?.adapterTag;
  if (adapterTag) tokens.push({ name: adapterTag, version: VERSION });
  return tokens;
};

/**
 * Render tokens for `params.agent`, which takes a raw string and so carries an
 * unversioned token as a bare name.
 * @param tokens - The tokens to render.
 * @returns The space-separated agent string.
 */
const joinTokens = (tokens: readonly AgentToken[]): string =>
  tokens.map(({ name, version }) => (version === undefined ? name : `${name}/${version}`)).join(' ');

/**
 * Render tokens for `options.agents`, which cannot carry a bare name: ably-js
 * formats every entry as `name/value` with no branch for a missing value, so an
 * unversioned token would reach the wire as the literal `name/undefined`. Those
 * tokens carry the SDK version here instead, which is why the connection path
 * and the ATTACH path read differently for the same identity.
 * @param tokens - The tokens to render.
 * @returns Map of agent name to version.
 */
const toAgentMap = (tokens: readonly AgentToken[]): Record<string, string> =>
  // The tuple annotation is required: without it TS widens the entry to
  // `string[]` and `Object.fromEntries` rejects it.
  Object.fromEntries(tokens.map(({ name, version }): [string, string] => [name, version ?? VERSION]));

/**
 * The space-separated `params.agent` string this SDK stamps on channel ATTACH.
 * Pure: unlike {@link registerAgent} it does not mutate the client. Use it to
 * seed a `<ChannelProvider options>` so ably-js's React hooks append their own
 * agent additively (`channelOptionsForReactHooks`) rather than overwriting this
 * SDK's.
 * @param identity - The code path and runtime opening the channel.
 * @param codec - The codec instance whose optional identifier opts into registration.
 * @param codec.adapterTag - The optional Ably-Agent identifier; registered as an agent when present.
 * @returns The channel `params.agent` string.
 */
export const channelAgent = (identity: AgentIdentity, codec?: { readonly adapterTag?: string }): string =>
  joinTokens(buildTokens(identity, codec));

/**
 * Register this SDK on the supplied Realtime client and return the channel
 * options the caller should pass to `client.channels.get(...)` so the agent is
 * also carried on channel ATTACH.
 *
 * Idempotent — repeated calls with the same client, identity and codec produce
 * the same keys and values.
 * Spec: AIT-CT1a, AIT-CT1a2, AIT-CT1a3, AIT-ST1a, AIT-ST1a2, AIT-ST1a3.
 * @param client - The Ably Realtime client to register on.
 * @param identity - The code path and runtime opening the channel.
 * @param codec - The codec instance whose optional identifier opts into registration.
 * @param codec.adapterTag - The optional Ably-Agent identifier; registered as an agent when present.
 * @returns Channel options containing `params.agent` for `channels.get`.
 */
export const registerAgent = (
  client: Ably.Realtime,
  identity: AgentIdentity,
  codec?: { readonly adapterTag?: string },
): { params: { agent: string } } => {
  const tokens = buildTokens(identity, codec);
  // CAST: Ably.Realtime's public type omits `options.agents`, but the SDK
  // does carry it at runtime. ably-chat-js relies on the same shape — see
  // ChatClient._addAgent in https://github.com/ably/ably-chat-js.
  const realtime = client as RealtimeWithOptions;
  realtime.options.agents = { ...realtime.options.agents, ...toAgentMap(tokens) };
  return { params: { agent: joinTokens(tokens) } };
};
