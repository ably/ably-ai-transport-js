/**
 * The Ably-Agent identifier this SDK stamps on a channel.
 *
 * Ably attributes traffic by an agent string sent on channel ATTACH, as the
 * `agent` channel param. A caller resolves its own channel, so the SDK cannot
 * set that param itself — it supplies the string and the caller passes it to
 * `channels.get`.
 */

import { VERSION } from '../version.js';

const SDK_NAME = 'ai-transport-js';

/**
 * The space-separated `params.agent` string to stamp on channel ATTACH —
 * `ai-transport-js/<version>`, plus the codec's adapter tag when it carries
 * one.
 *
 * Pure, and safe to call repeatedly: the same codec always yields the same
 * string. Pass it through as the channel's `params.agent` when resolving the
 * channel, or as a `<ChannelProvider options>` seed so ably-js's own React
 * hooks append their agent to this one rather than replacing it.
 * @param codec - The codec whose optional identifier opts into registration.
 * @param codec.adapterTag - The optional Ably-Agent identifier; registered as an agent when present.
 * @returns The channel `params.agent` string.
 */
export const channelAgent = (codec?: { readonly adapterTag?: string }): string => {
  const sdk = `${SDK_NAME}/${VERSION}`;
  const tag = codec?.adapterTag;
  // An empty tag would render as a bare `/version`, which is not a valid
  // agent, so it reads as an opt-out just like an absent one.
  return tag === undefined || tag === '' ? sdk : `${sdk} ${tag}/${VERSION}`;
};
