import { createContext } from 'react';

import type { ClientTransport } from '../../core/transport/types.js';

/** The shape of the TransportContext value — a record of channelName → transport. */
export type TransportContextValue = Readonly<Record<string, ClientTransport<unknown, unknown>>>;

/**
 * Context that holds the registered {@link ClientTransport} instances, keyed by channelName.
 * Populated by {@link TransportProvider}; read by {@link useClientTransport}.
 */
export const TransportContext = createContext<TransportContextValue>({});

/**
 * Context that holds the nearest (innermost) registered {@link ClientTransport}.
 * Each {@link TransportProvider} sets this to its own transport, so descendants
 * can access the nearest transport without knowing its channel name.
 * Read by hooks whose `transport` argument is omitted.
 */
export const NearestTransportContext = createContext<ClientTransport<unknown, unknown> | undefined>(undefined);
