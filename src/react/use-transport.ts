/**
 * useTransport: read a {@link Transport} from the nearest (or a named)
 * {@link import('./contexts/transport-provider.js').TransportProvider}.
 * A thin context reader: it creates no state and manages no lifecycle.
 */

import * as Ably from 'ably';
import { useContext } from 'react';

import type { Transport } from '../core/transport/index.js';
import { ErrorCode } from '../errors.js';
import type { TransportSlot } from './contexts/transport-context.js';
import { TransportContext } from './contexts/transport-context.js';

/** Options for {@link useTransport}. */
export interface UseTransportOptions {
  /** The channel name of the provider to read. Omit to use the nearest enclosing provider. */
  channelName?: string;
}

/**
 * What {@link useTransport} returns: the provider's transport, or the error
 * that stopped it being created.
 * @template E - The codec's event union.
 */
export interface TransportHandle<E = unknown> {
  /** The provider's transport, or `undefined` before its effect has run and when construction failed. */
  transport: Transport<E> | undefined;
  /** The construction error, or `undefined` when the transport exists. */
  error: Ably.ErrorInfo | undefined;
}

/**
 * The slot of the nearest or the named provider.
 * @param channelName - The provider to read, or `undefined` for the nearest.
 * @returns The slot.
 * @throws {Ably.ErrorInfo} `InvalidArgument` when no matching provider encloses the caller.
 */
export const useTransportSlot = (channelName: string | undefined): TransportSlot => {
  const context = useContext(TransportContext);
  const slot = channelName === undefined ? context.nearest : context.providers[channelName];
  if (!slot) {
    throw new Ably.ErrorInfo(
      'unable to resolve transport; no matching TransportProvider encloses this component',
      ErrorCode.InvalidArgument,
      400,
    );
  }
  return slot;
};

/**
 * Read the {@link Transport} registered by an enclosing
 * {@link import('./contexts/transport-provider.js').TransportProvider}.
 *
 * Supply the `E` type argument matching the provider's codec to get a typed
 * transport back: the provider stores it with the event type erased, and this
 * hook is the boundary that re-applies it.
 * @template E - The codec's event union.
 * @param options - Optional provider lookup; see {@link UseTransportOptions}.
 * @returns The transport and any construction error; see {@link TransportHandle}.
 * @throws {Ably.ErrorInfo} `InvalidArgument` when no matching provider encloses the caller.
 */
export const useTransport = <E = unknown>(options: UseTransportOptions = {}): TransportHandle<E> => {
  const slot = useTransportSlot(options.channelName);
  return {
    // CAST: the provider stores the transport with its event type erased; the
    // caller's type argument re-applies the codec's type at this boundary.
    transport: slot.transport as Transport<E> | undefined,
    error: slot.error,
  };
};
