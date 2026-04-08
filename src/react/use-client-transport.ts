/**
 * useClientTransport: creates and memoizes a core ClientTransport instance
 * across renders.
 *
 * Stores the instance in a ref so the same transport is returned on every render.
 * The transport manages its own Ably channel subscription in the constructor —
 * this hook adds no subscription logic.
 *
 * The hook does NOT auto-close the transport on unmount. Channel lifecycle is
 * managed by the Ably provider (useChannel), which detaches the channel and
 * clears all subscriptions. Auto-closing would break React Strict Mode
 * (double-mount calls close() on the first cleanup, leaving a dead transport
 * on the second mount). Call transport.close() explicitly if you need to tear
 * down the transport independently of the channel lifecycle.
 */

import { useRef } from 'react';

import { createClientTransport } from '../core/transport/client/client-transport.js';
import type { ClientTransport, ClientTransportOptions } from '../core/transport/client/types.js';

/**
 * Create and memoize a {@link ClientTransport} across renders.
 * @param options - Configuration for the client transport.
 * @returns The memoized transport instance.
 */
export const useClientTransport = <TEvent, TMessage>(
  options: ClientTransportOptions<TEvent, TMessage>,
): ClientTransport<TEvent, TMessage> => {
  const transportRef = useRef<ClientTransport<TEvent, TMessage> | null>(null);

  if (transportRef.current === null) {
    transportRef.current = createClientTransport(options);
  }

  return transportRef.current;
};
