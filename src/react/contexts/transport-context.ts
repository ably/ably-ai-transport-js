import { createContext } from 'react';

import type { ClientTransport } from '../../core/transport/types.js';

/** The shape of the TransportContext value — a record of channelName → transport. */
export type TransportContextValue = Readonly<Record<string, ClientTransport<unknown, unknown>>>;

/**
 * Context that holds the registered {@link ClientTransport} instances, keyed by channelName.
 * Populated by {@link TransportProvider}; read by {@link useClientTransport}.
 */
export const TransportContext = createContext<TransportContextValue>({});
