/**
 * The Ably client factory and logger, shared by this app's activities and by the
 * SDK's Temporal plugin.
 *
 * Kept out of `activities.ts` deliberately: that module is handed to
 * `Worker.create` wholesale, and Temporal registers every function it exports as
 * an activity.
 */

import Ably from 'ably';

import { LogLevel, makeLogger } from '@ably/ai-transport';

/** Propagated into every session, this app's and the SDK's alike. */
export const logger = makeLogger({
  logLevel: process.env.WORKER_LOG_LEVEL === 'trace' ? LogLevel.Trace : LogLevel.Debug,
});

const ABLY_KEY = (): string => {
  const key = process.env.ABLY_API_KEY;
  if (!key) throw new Error('ABLY_API_KEY is not set');
  return key;
};

const ABLY_ENDPOINT = (): string | undefined => process.env.ABLY_ENDPOINT;

/**
 * Build one realtime client for one activity.
 *
 * The env is read at the point of use, never hoisted, so a runtime change is
 * picked up. A client per activity is required rather than merely tidy: a session
 * takes its channel from `client.channels.get(name)`, which caches per name, and
 * detaching a session detaches that channel — so two sessions sharing a client on
 * one channel would break each other.
 * @returns A fresh realtime client, for the caller to close.
 */
export const makeAbly = (): Ably.Realtime =>
  new Ably.Realtime({
    key: ABLY_KEY(),
    ...(ABLY_ENDPOINT() ? { endpoint: ABLY_ENDPOINT() } : {}),
  });
