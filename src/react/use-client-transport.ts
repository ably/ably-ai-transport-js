/**
 * useClientTransport: reads a ClientTransport from the nearest TransportProvider.
 *
 * The transport is created by TransportProvider, which also wraps the subtree
 * with Ably's ChannelProvider. This hook is a thin context reader — it does
 * not create or manage any transport state.
 *
 * Throws if called outside a TransportProvider for the given channelName.
 */

import * as Ably from 'ably';
import { useContext } from 'react';

import type { ClientTransport } from '../core/transport/types.js';
import { ErrorCode } from '../errors.js';
import { TransportContext } from './contexts/transport-context.js';

/**
 * Access the {@link ClientTransport} from the nearest {@link TransportProvider}.
 * @param channelName - The channel name passed to the enclosing `TransportProvider`.
 * @returns The `ClientTransport` instance registered under `channelName`.
 * @throws {Ably.ErrorInfo} if no `TransportProvider` with the given `channelName` is in the tree.
 */
export const useClientTransport = <TEvent, TMessage>(channelName: string): ClientTransport<TEvent, TMessage> => {
  const transport = useContext(TransportContext)[channelName];

  if (!transport) {
    throw new Ably.ErrorInfo(
      `unable to use transport; no TransportProvider found for channelName "${channelName}"`,
      ErrorCode.BadRequest,
      400,
    );
  }

  // CAST: TransportContext stores transports with erased generics.
  // The caller is responsible for using type parameters matching those of the TransportProvider.
  return transport as unknown as ClientTransport<TEvent, TMessage>;
};
