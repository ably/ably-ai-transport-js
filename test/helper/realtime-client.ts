import * as Ably from 'ably';

import { ablyApiKey, isLocalEnvironment, localSandboxRouting, testEndpoint } from './environment.js';
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
  merged.logLevel = merged.logLevel ?? 1; // error

  if (isLocalEnvironment()) {
    merged.port = 8081;
    merged.tls = false;
  }

  // When provisioned against a local sandbox, route every client at the
  // isolated server that sandbox booted for this app (its own endpoint/port,
  // plaintext ws/http), overriding the cloud endpoint set above.
  const localSandbox = localSandboxRouting();
  if (localSandbox) {
    merged.endpoint = localSandbox.endpoint;
    merged.port = localSandbox.port;
    merged.tls = localSandbox.tls;
  }

  return merged;
};

/**
 * Create a Realtime client with the given options, or sandbox defaults if not specified.
 * Registers the client for cleanup via {@link closeAllClients}.
 * @param options - Optional Ably client options to override defaults.
 * @returns A new Ably.Realtime client.
 */
export const ablyRealtimeClient = (options?: Ably.ClientOptions): Ably.Realtime => {
  const client = new Ably.Realtime(baseOptions(options));
  clients.push(client);
  return client;
};

/**
 * Close and clean up all clients created via {@link ablyRealtimeClient}.
 * Call in `afterEach` to prevent connection leaks between tests.
 */
export const closeAllClients = (): void => {
  for (const client of clients) {
    client.close();
  }
  clients.length = 0;
};
