/**
 * Integration-test scaffolding: stand up connected transports over real Ably
 * clients, one per role, and clean them all up in `afterEach`.
 *
 * Each endpoint owns its own realtime connection (via `ablyRealtimeClient`,
 * which registers the connection for `closeAllClients()`), gets the channel,
 * constructs its transport, and connects it. Constructed transports register
 * here for `closeAllTransports()`, which tests run in `afterEach` BEFORE
 * `closeAllClients()` — listeners unsubscribe from channels they do not own,
 * then the connections drop.
 */

import type * as Ably from 'ably';

import { createAgentTransport } from '../../src/core/transport/agent-transport.js';
import { createClientTransport } from '../../src/core/transport/client-transport.js';
import type { AgentTransport, ClientTransport, WireCodec } from '../../src/index.js';
import type { Logger } from '../../src/logger.js';
import { randomClientId } from './identifier.js';
import { ablyRealtimeClient } from './realtime-client.js';

/** One transport bound to its own Ably connection, channel object and clientId. */
export interface TransportEndpoint<T> {
  /** The Ably connection this endpoint owns. */
  realtime: Ably.Realtime;
  /** The channel object the transport publishes on and subscribes to. */
  channel: Ably.RealtimeChannel;
  /** The connected transport. */
  transport: T;
  /** The clientId stamped on everything this endpoint publishes. */
  clientId: string;
}

/** Options shared by both endpoint factories. */
export interface EndpointOptions<TInput, TOutput> {
  /** The wire codec both sides of the test speak. */
  codec: WireCodec<TInput, TOutput>;
  /** Wire-message limit per history page; the transport default when omitted. */
  historyPageSize?: number;
  /** Logger for debugging a failing run; the transports' own silent default when omitted. */
  logger?: Logger;
}

/** Every transport constructed via the factories, closed by {@link closeAllTransports}. */
const transports: { close(): void }[] = [];

/**
 * Close every transport the factories constructed, in construction order, and
 * empty the registry. Run in `afterEach` BEFORE `closeAllClients()`.
 */
export const closeAllTransports = (): void => {
  for (const transport of transports) transport.close();
  transports.length = 0;
};

/**
 * Read the authoritative clientId off a realtime connection — the identity
 * Ably actually stamps on published messages.
 * @param realtime - The connection to read.
 * @returns The clientId.
 */
const authoritativeClientId = (realtime: Ably.Realtime): string => {
  const { clientId } = realtime.auth;
  // Explicit narrowing: the helper always constructs the connection with a
  // clientId, so an unset value here is a broken fixture, not a legal state.
  if (typeof clientId !== 'string' || clientId === '') throw new Error('realtime client has no clientId');
  return clientId;
};

/**
 * Stand up a connected {@link AgentTransport} on its own realtime connection.
 * @param channelName - The (shared) channel to operate on.
 * @param opts - Codec and transport options.
 * @returns The endpoint.
 */
export const createAgentEndpoint = async <TInput, TOutput>(
  channelName: string,
  opts: EndpointOptions<TInput, TOutput>,
): Promise<TransportEndpoint<AgentTransport<TInput, TOutput>>> => {
  const realtime = ablyRealtimeClient({ clientId: randomClientId() });
  const clientId = authoritativeClientId(realtime);
  const channel = realtime.channels.get(channelName);
  const transport = createAgentTransport<TInput, TOutput>({
    channel,
    codec: opts.codec,
    clientId,
    ...(opts.historyPageSize === undefined ? {} : { historyPageSize: opts.historyPageSize }),
    ...(opts.logger === undefined ? {} : { logger: opts.logger }),
  });
  transports.push(transport);
  await transport.connect();
  return { realtime, channel, transport, clientId };
};

/**
 * Stand up a connected {@link ClientTransport} on its own realtime connection.
 * @param channelName - The (shared) channel to operate on.
 * @param opts - Codec and transport options.
 * @returns The endpoint.
 */
export const createClientEndpoint = async <TInput, TOutput>(
  channelName: string,
  opts: EndpointOptions<TInput, TOutput>,
): Promise<TransportEndpoint<ClientTransport<TInput, TOutput>>> => {
  const realtime = ablyRealtimeClient({ clientId: randomClientId() });
  const clientId = authoritativeClientId(realtime);
  const channel = realtime.channels.get(channelName);
  const transport = createClientTransport<TInput, TOutput>({
    channel,
    codec: opts.codec,
    clientId,
    ...(opts.historyPageSize === undefined ? {} : { historyPageSize: opts.historyPageSize }),
    ...(opts.logger === undefined ? {} : { logger: opts.logger }),
  });
  transports.push(transport);
  await transport.connect();
  return { realtime, channel, transport, clientId };
};
