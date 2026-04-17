import { useContext } from 'react';

import type { ClientTransport } from '../../core/transport/types.js';
import { TransportContext } from '../contexts/transport-context.js';

/**
 * Resolve the active `ClientTransport` for a hook.
 *
 * Reads `NearestTransportContext` and applies the standard three-way
 * priority: explicit `transport` argument → nearest provider → `undefined`.
 * When `skip` is `true`, returns `undefined` without reading context.
 *
 * Internal — not part of the public API.
 * @param root0 - Options.
 * @param root0.transport - Explicit transport; takes priority over the nearest provider.
 * @param root0.skip - When `true`, bypass context and return `undefined` immediately.
 * @returns The resolved transport, or `undefined` if none is available or `skip` is `true`.
 */
export const useResolvedTransport = <TEvent, TMessage>({
  transport,
  skip,
}: {
  /** Explicit transport; takes priority over the nearest provider. */
  transport?: ClientTransport<TEvent, TMessage> | null;
  /** When `true`, bypass context and return `undefined` immediately. */
  skip?: boolean;
} = {}): ClientTransport<TEvent, TMessage> | undefined => {
  const { nearest } = useContext(TransportContext);
  const nearestTransport = nearest?.transport as unknown as ClientTransport<TEvent, TMessage> | undefined;
  return skip ? undefined : (transport ?? nearestTransport);
};
