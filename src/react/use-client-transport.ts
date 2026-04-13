/**
 * useClientTransport: reads a ClientTransport from the nearest TransportProvider.
 *
 * The transport is created by TransportProvider, which also wraps the subtree
 * with Ably's ChannelProvider. This hook is a thin context reader — it does
 * not create or manage any transport state.
 *
 * Pass `channelName` to look up a specific provider by name. Omit to use the nearest
 * provider in the tree. Pass `skip: true` to defer (e.g. when auth is not yet resolved)
 * — returns a stub transport whose properties throw with a descriptive error.
 */

import * as Ably from 'ably';
import { useContext } from 'react';

import type { ClientTransport, Tree, View } from '../core/transport/types.js';
import { ErrorCode } from '../errors.js';
import { NearestTransportContext, TransportContext } from './contexts/transport-context.js';

const SKIPPED_TRANSPORT: ClientTransport<unknown, unknown> = {
  get tree(): Tree<unknown> {
    throw new Ably.ErrorInfo('unable to access tree; hook is skipped', ErrorCode.InvalidArgument, 400);
  },
  get view(): View<unknown, unknown> {
    throw new Ably.ErrorInfo('unable to access view; hook is skipped', ErrorCode.InvalidArgument, 400);
  },
  createView: (): View<unknown, unknown> => {
    throw new Ably.ErrorInfo('unable to create view; hook is skipped', ErrorCode.InvalidArgument, 400);
  },
  cancel: () => {
    throw new Ably.ErrorInfo('unable to cancel; hook is skipped', ErrorCode.InvalidArgument, 400);
  },
  waitForTurn: () => {
    throw new Ably.ErrorInfo('unable to wait for turn; hook is skipped', ErrorCode.InvalidArgument, 400);
  },
  on: () => {
    throw new Ably.ErrorInfo('unable to subscribe; hook is skipped', ErrorCode.InvalidArgument, 400);
  },
  close: () => {
    throw new Ably.ErrorInfo('unable to close; hook is skipped', ErrorCode.InvalidArgument, 400);
  },
};

/**
 * Access a {@link ClientTransport} from the nearest {@link TransportProvider}.
 *
 * When `channelName` is omitted, the innermost `TransportProvider` in the tree is used.
 * When `skip` is `true`, returns a stub transport whose every property and method throws
 * an {@link Ably.ErrorInfo} — safe to hold in state before conditions are ready.
 * @param props - Options for selecting the transport.
 * @param props.channelName - The channel name passed to the enclosing `TransportProvider`. Omit to use the nearest.
 * @param props.skip - When `true`, return a stub that throws on any access instead of reading from context.
 * @returns The `ClientTransport` instance, or a throwing stub when `skip` is `true`.
 * @throws {Ably.ErrorInfo} if `skip` is falsy and no matching `TransportProvider` is found.
 */
export const useClientTransport = <TEvent, TMessage>({
  channelName,
  skip,
}: {
  /** Channel name to look up; omit to use the nearest {@link TransportProvider}. */
  channelName?: string;
  /** When `true`, return a stub transport that throws on any access. */
  skip?: boolean;
} = {}): ClientTransport<TEvent, TMessage> => {
  const registry = useContext(TransportContext);
  const nearestTransport = useContext(NearestTransportContext);

  if (skip) {
    return SKIPPED_TRANSPORT as unknown as ClientTransport<TEvent, TMessage>;
  }

  if (channelName !== undefined) {
    const transport = registry[channelName];
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
  }

  if (!nearestTransport) {
    throw new Ably.ErrorInfo(
      'unable to use transport; no TransportProvider found in the tree',
      ErrorCode.BadRequest,
      400,
    );
  }
  // CAST: NearestTransportContext stores transport with erased generics; types fixed at call site.
  return nearestTransport as unknown as ClientTransport<TEvent, TMessage>;
};
