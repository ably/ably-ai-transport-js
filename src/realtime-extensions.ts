import type * as Ably from 'ably';

/**
 * Exposes the internal `options.agents` field on the Ably Realtime client for
 * usage attribution. Not part of the public Ably types — the field is a
 * convention shared across Ably's satellite SDKs.
 * @internal
 */
export interface RealtimeWithOptions extends Ably.Realtime {
  options: {
    agents?: Record<string, string | undefined>;
  };
}
