/**
 * The library-attribution identifier this SDK reports to Ably.
 *
 * Ably attributes usage through an agent identifier, a list of
 * space-separated entries such as
 * `ai-transport-js/0.9.0 streaming vercel-ai-sdk-ui-message/0.9.0`. It
 * identifies the SDK, and it has nothing to do with the AI agent this package
 * also helps you build.
 *
 * The identifier travels two ways, the two paths ably-chat-js uses (see
 * `ChatClient._addAgent` in https://github.com/ably/ably-chat-js): the
 * client's `options.agents`, which ably-js reads when it opens the WebSocket,
 * and the channel's `params.agent`, sent on ATTACH so a connection that is
 * already open carries it too. The transport resolves its own channel, so it
 * does both and nothing outside the package needs to.
 *
 * The identifier names the SDK, the layer that opened the channel, and the
 * codec. The two paths render that list differently; see {@link toAgentMap}
 * for why.
 */

import type * as Ably from 'ably';

import { VERSION } from '../version.js';

/**
 * `options.agents` is a private API on the Realtime client: no public typed
 * accessor exists in the `ably` package.
 */
interface RealtimeWithOptions extends Ably.Realtime {
  options: { agents?: Record<string, string | undefined> };
}

const SDK_NAME = 'ai-transport-js';

/**
 * The layer that opened the channel. The transport is this SDK's one layer;
 * the entry keeps its usage apart from the durable sessions of earlier
 * releases, which reported `durable-sessions`.
 */
const LAYER = 'streaming';

/** One entry of the agent identifier. */
interface AgentToken {
  /** The registered agent name. */
  readonly name: string;
  /** Omitted for an entry Ably treats as unversioned. */
  readonly version?: string;
}

/**
 * Build the ordered entries for a codec. The order is fixed: this SDK, the
 * layer, then the codec's adapter tag.
 * @param codec - The codec whose optional tag adds an entry.
 * @param codec.adapterTag - The codec's attribution tag; appended when present.
 * @returns The entries, in the order they appear in the identifier.
 */
const buildTokens = (codec?: { readonly adapterTag?: string }): readonly AgentToken[] => {
  const tokens: AgentToken[] = [{ name: SDK_NAME, version: VERSION }, { name: LAYER }];
  const tag = codec?.adapterTag;
  // An empty tag would render as a bare `/version`, which is not a valid
  // agent, so it reads as an opt-out just like an absent one.
  if (tag !== undefined && tag !== '') tokens.push({ name: tag, version: VERSION });
  return tokens;
};

/**
 * Render entries for `params.agent`, which takes a raw string and so carries
 * an unversioned entry as a bare name.
 * @param tokens - The entries to render.
 * @returns The space-separated agent string.
 */
const joinTokens = (tokens: readonly AgentToken[]): string =>
  tokens.map(({ name, version }) => (version === undefined ? name : `${name}/${version}`)).join(' ');

/**
 * Render entries for `options.agents`, which cannot carry a bare name: ably-js
 * formats every entry as `name/value` with no branch for a missing value, so
 * an unversioned entry would reach the wire as the literal `name/undefined`.
 * Those entries carry the SDK version here instead, which is why the
 * connection path and the ATTACH path read differently.
 * @param tokens - The entries to render.
 * @returns Map of agent name to version.
 */
const toAgentMap = (tokens: readonly AgentToken[]): Record<string, string> =>
  // The tuple annotation is required: without it TS widens the entry to
  // `string[]` and `Object.fromEntries` rejects it.
  Object.fromEntries(tokens.map(({ name, version }): [string, string] => [name, version ?? VERSION]));

/**
 * The space-separated `params.agent` string to stamp on channel ATTACH:
 * `ai-transport-js/<version> streaming`, plus the codec's own tag when it
 * carries one.
 *
 * Pure, and safe to call repeatedly: the same codec always yields the same
 * string. The transport passes it as the channel's `params.agent` when it
 * resolves the channel.
 * @param codec - The codec whose optional tag adds an attribution entry.
 * @param codec.adapterTag - The codec's attribution tag; appended when present.
 * @returns The channel `params.agent` string.
 */
export const channelAgent = (codec?: { readonly adapterTag?: string }): string => joinTokens(buildTokens(codec));

/**
 * Register this SDK's entries on the client's `options.agents`, so the
 * WebSocket the client opens carries them.
 *
 * Merges into the entries already there, so another library's registration
 * on the same client survives, and repeated calls with the same codec write
 * the same keys and values.
 * @param client - The Ably Realtime client to register on.
 * @param codec - The codec whose optional tag adds an attribution entry.
 * @param codec.adapterTag - The codec's attribution tag; appended when present.
 */
export const registerAgent = (client: Ably.Realtime, codec?: { readonly adapterTag?: string }): void => {
  // CAST: Ably.Realtime's public type omits `options.agents`, but the SDK
  // carries it at runtime. ably-chat-js relies on the same shape.
  const realtime = client as RealtimeWithOptions;
  realtime.options.agents = { ...realtime.options.agents, ...toAgentMap(buildTokens(codec)) };
};
