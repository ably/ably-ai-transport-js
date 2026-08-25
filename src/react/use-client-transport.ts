/**
 * useClientTransport: read a {@link ClientTransport} from the nearest (or a
 * named) {@link import('./contexts/client-transport-provider.js').ClientTransportProvider}.
 * A thin context reader — it creates no state and manages no lifecycle.
 */

import * as Ably from 'ably';
import { useContext } from 'react';

import type { ClientTransport } from '../core/transport/types.js';
import { ErrorCode } from '../errors.js';
import { ClientTransportContext } from './contexts/client-transport-context.js';

/** Options for {@link useClientTransport}. */
export interface UseClientTransportOptions {
  /**
   * The channel name of the provider to read. Omit to use the nearest
   * enclosing provider.
   */
  channelName?: string;
}

/**
 * What {@link useClientTransport} returns: the provider's transport, or the
 * error that stopped it being created.
 * @template TInput - The codec's input-event domain type.
 * @template TOutput - The codec's output-event domain type.
 */
export interface ClientTransportHandle<TInput = unknown, TOutput = unknown> {
  /** The provider's transport, or `undefined` when construction failed. */
  transport: ClientTransport<TInput, TOutput> | undefined;
  /** The construction error, or `undefined` when the transport exists. */
  error: Ably.ErrorInfo | undefined;
}

/**
 * Read the {@link ClientTransport} registered by an enclosing
 * {@link import('./contexts/client-transport-provider.js').ClientTransportProvider}.
 *
 * Supply `TInput` / `TOutput` type arguments matching the provider's codec to
 * get a typed transport back — the provider stores it with erased event
 * types, and this hook is the boundary that re-applies them.
 * @template TInput - The codec's input-event domain type.
 * @template TOutput - The codec's output-event domain type.
 * @param options - Optional provider lookup; see {@link UseClientTransportOptions}.
 * @returns The transport and any construction error; see {@link ClientTransportHandle}.
 * @throws {Ably.ErrorInfo} InvalidArgument when no matching provider encloses the caller.
 */
export const useClientTransport = <TInput = unknown, TOutput = unknown>(
  options: UseClientTransportOptions = {},
): ClientTransportHandle<TInput, TOutput> => {
  const context = useContext(ClientTransportContext);
  const slot = options.channelName === undefined ? context.nearest : context.providers[options.channelName];
  if (!slot) {
    throw new Ably.ErrorInfo(
      'unable to resolve client transport; no matching ClientTransportProvider encloses this component',
      ErrorCode.InvalidArgument,
      400,
    );
  }
  return {
    // CAST: the provider stores the transport with erased event types; the
    // caller's type arguments re-apply the codec's types at this boundary.
    transport: slot.transport as ClientTransport<TInput, TOutput> | undefined,
    error: slot.error,
  };
};
