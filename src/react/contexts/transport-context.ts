import type * as Ably from 'ably';
import { createContext } from 'react';

import type { ClientTransport } from '../../core/transport/types.js';

/**
 * A single entry in the transport registry, holding the transport and any
 * error that occurred during its construction.
 *
 * `transport` is `undefined` when construction failed.
 * `error` is set when `createClientTransport` threw during provider render.
 */
export interface TransportSlot {
  /** The constructed transport, or `undefined` if construction failed. */
  transport: ClientTransport<unknown, unknown> | undefined;
  /** Construction error from `createClientTransport`, or `undefined` on success. */
  error: Ably.ErrorInfo | undefined;
}

/** The shape of the TransportContext value — a record of channelName → slot. */
export type TransportContextValue = Readonly<Record<string, TransportSlot>>;

/**
 * Context that holds the registered {@link ClientTransport} slots, keyed by channelName.
 * Each slot contains the transport (or `undefined` on construction failure) and any error.
 * Populated by {@link TransportProvider}; read by {@link useClientTransport}.
 */
export const TransportContext = createContext<TransportContextValue>({});

/**
 * Context that holds the nearest (innermost) transport slot.
 * Each {@link TransportProvider} sets this to its own slot, so descendants
 * can access the nearest transport without knowing its channel name.
 * `undefined` when no provider is present.
 * Read by hooks whose `transport` argument is omitted.
 */
export const NearestTransportContext = createContext<TransportSlot | undefined>(undefined);
