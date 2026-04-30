import * as Ably from 'ably';

import { ablyApiKey, isLocalEnvironment, testEndpoint } from './environment.js';
import { randomClientId } from './identifier.js';

const clients: Ably.Realtime[] = [];

const baseOptions = (options?: Ably.ClientOptions): Ably.ClientOptions => {
  const merged: Ably.ClientOptions = { ...options };
  merged.clientId = merged.clientId ?? randomClientId();
  merged.endpoint = merged.endpoint ?? testEndpoint();
  merged.key = merged.key ?? ablyApiKey();
  merged.useBinaryProtocol = merged.useBinaryProtocol ?? false;
  merged.logHandler =
    merged.logHandler ??
    ((msg) => {
      console.error(msg);
    });
  merged.logLevel = merged.logLevel ?? 1;

  if (isLocalEnvironment()) {
    merged.port = 8081;
    merged.tls = false;
  }

  return merged;
};

/**
 * Create an `Ably.Realtime` client wired up for the configured test
 * environment. Registers the client for cleanup via {@link closeAllClients}
 * so tests don't leak connections between runs.
 * @param options Optional `Ably.ClientOptions` overrides on top of the
 *   environment defaults.
 * @returns A new `Ably.Realtime` client.
 */
export const ablyRealtimeClient = (options?: Ably.ClientOptions): Ably.Realtime => {
  const client = new Ably.Realtime(baseOptions(options));
  clients.push(client);
  return client;
};

/**
 * Close and clear every client created via {@link ablyRealtimeClient}. Call
 * in `afterEach` to guarantee no live connections leak across tests.
 */
export const closeAllClients = (): void => {
  for (const client of clients) {
    client.close();
  }
  clients.length = 0;
};
