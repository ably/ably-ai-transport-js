/**
 * The library-attribution string this SDK stamps on a channel.
 *
 * Ably records which library produced a connection through a channel param
 * named `agent`, sent on ATTACH. It identifies the SDK, and it has nothing to
 * do with the AI agent this package also helps you build.
 *
 * The transport resolves its own channel, so it stamps this string on it and
 * nothing outside the package needs to.
 */

import { VERSION } from '../version.js';

const SDK_NAME = 'ai-transport-js';

/**
 * The space-separated `params.agent` string to stamp on channel ATTACH —
 * `ai-transport-js/<version>`, plus the codec's own tag when it carries one.
 *
 * This names the library to Ably's attribution. It does not name an AI agent.
 *
 * Pure, and safe to call repeatedly: the same codec always yields the same
 * string. The transport passes it as the channel's `params.agent` when it
 * resolves the channel.
 * @param codec - The codec whose optional tag adds a second attribution entry.
 * @param codec.adapterTag - The codec's attribution tag; appended when present.
 * @returns The channel `params.agent` string.
 */
export const channelAgent = (codec?: { readonly adapterTag?: string }): string => {
  const sdk = `${SDK_NAME}/${VERSION}`;
  const tag = codec?.adapterTag;
  // An empty tag would render as a bare `/version`, which is not a valid
  // agent, so it reads as an opt-out just like an absent one.
  return tag === undefined || tag === '' ? sdk : `${sdk} ${tag}/${VERSION}`;
};
