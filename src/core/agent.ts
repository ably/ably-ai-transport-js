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

/**
 * Register this SDK on the supplied Realtime client and return the channel
 * options the caller should pass to `client.channels.get(...)` so the agent
 * is also carried on channel ATTACH. Sets
 * `options.agents['ai-transport-js'] = VERSION`. Idempotent — repeated
 * calls with the same client produce the same key/value.
 * @param client - The Ably Realtime client to register on.
 * @returns Channel options containing `params.agent` for `channels.get`.
 */
export const registerAgent = (client: Ably.Realtime): { params: { agent: string } } => {
  // CAST: Ably.Realtime's public type omits `options.agents`, but the SDK
  // does carry it at runtime. ably-chat-js relies on the same shape — see
  // ChatClient._addAgent in https://github.com/ably/ably-chat-js.
  const realtime = client as RealtimeWithOptions;
  realtime.options.agents = {
    ...realtime.options.agents,
    [SDK_NAME]: VERSION,
  };
  return { params: { agent: `${SDK_NAME}/${VERSION}` } };
};
