/**
 * Registers the SDK's `ai-transport-js` agent identifier on the Realtime
 * client's `options.agents` map so the Ably backend can attribute usage to
 * this SDK.
 *
 * The `options.agents` field is a private API on the Realtime client — there
 * is no public typed accessor in the `ably` package. This module narrows the
 * client to a `RealtimeWithOptions` shape and merges the entry in. The same
 * pattern is used by `ably-chat-js` (`ChatClient._addAgent`).
 */

import type * as Ably from 'ably';

import { VERSION } from '../version.js';

interface RealtimeWithOptions extends Ably.Realtime {
  options: { agents?: Record<string, string | undefined> };
}

const SDK_NAME = 'ai-transport-js';

/**
 * Register this SDK on the Realtime client's `options.agents` map so the
 * Ably backend can attribute usage to it. Sets the entry
 * `'ai-transport-js' -> VERSION`. Idempotent — repeated calls with the
 * same client produce the same key/value, so multiple sessions sharing
 * one client are safe.
 * @param client - The Ably Realtime client to register on.
 */
export const registerAgent = (client: Ably.Realtime): void => {
  // CAST: Ably.Realtime's public type omits `options.agents`, but the SDK
  // does carry it at runtime. ably-chat-js relies on the same shape — see
  // ChatClient._addAgent in https://github.com/ably/ably-chat-js.
  const realtime = client as RealtimeWithOptions;
  realtime.options.agents = {
    ...realtime.options.agents,
    [SDK_NAME]: VERSION,
  };
};
