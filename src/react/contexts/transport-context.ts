/**
 * React context carrying the {@link Transport} instances registered by
 * {@link import('./transport-provider.js').TransportProvider}. Each provider
 * merges its slot into the parent record, so nested providers with distinct
 * channel names are all reachable by name, and the nearest one is the default.
 */

import type * as Ably from 'ably';
import { createContext } from 'react';

import type { Transport } from '../../core/transport/index.js';

/**
 * One provider's registration: the transport it created, or the construction
 * error when creating it threw.
 */
export interface TransportSlot {
  /** The provider's transport, or `undefined` when construction failed. Stored with the event type erased; the reading hook re-applies it. */
  transport: Transport<unknown> | undefined;
  /** The construction error, or `undefined` when the transport was created. */
  error: Ably.ErrorInfo | undefined;
}

/** The context value: the nearest provider's slot plus every named provider's slot. */
export interface TransportContextValue {
  /** The nearest enclosing provider's slot. */
  nearest: TransportSlot | undefined;
  /** Every enclosing provider's slot, keyed by channel name. */
  providers: Record<string, TransportSlot>;
}

/** The context {@link import('./transport-provider.js').TransportProvider} publishes into. */
export const TransportContext = createContext<TransportContextValue>({
  nearest: undefined,
  providers: {},
});
