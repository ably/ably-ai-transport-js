/**
 * React context carrying the {@link ClientTransport} instances registered by
 * {@link import('./client-transport-provider.js').ClientTransportProvider}.
 * Each provider merges its slot into the parent record, so nested providers
 * with distinct channel names are all reachable by name, and the nearest one
 * is the default.
 */

import type * as Ably from 'ably';
import { createContext } from 'react';

import type { ClientTransport } from '../../core/transport/types.js';

/**
 * One provider's registration: the transport it created, or the construction
 * error when creating it threw.
 */
export interface ClientTransportSlot {
  /** The provider's transport, or `undefined` when construction failed. Stored with erased event types; the reading hook re-applies them. */
  transport: ClientTransport<unknown, unknown> | undefined;
  /** The construction error, or `undefined` when the transport was created. */
  error: Ably.ErrorInfo | undefined;
}

/** The context value: the nearest provider's slot plus every named provider's slot. */
export interface ClientTransportContextValue {
  /** The nearest enclosing provider's slot. */
  nearest: ClientTransportSlot | undefined;
  /** Every enclosing provider's slot, keyed by channel name. */
  providers: Record<string, ClientTransportSlot>;
}

/** The context {@link import('./client-transport-provider.js').ClientTransportProvider} publishes into. */
export const ClientTransportContext = createContext<ClientTransportContextValue>({
  nearest: undefined,
  providers: {},
});
