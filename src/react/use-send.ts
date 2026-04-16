/**
 * useSend — stable callback for sending messages through a View.
 *
 * Returns a `send` function that sends one or more messages in a single
 * turn. When `view` is omitted, resolves the view from the nearest
 * {@link TransportProvider} via context.
 */

import * as Ably from 'ably';
import { useCallback, useContext } from 'react';

import type { ActiveTurn, ClientTransport, SendOptions, View } from '../core/transport/types.js';
import { ErrorCode } from '../errors.js';
import { NearestTransportContext } from './contexts/transport-context.js';

/**
 * Return a stable `send` callback bound to the given view, or the nearest
 * provider's view when `view` is omitted.
 *
 * When `view` is `undefined`, the hook reads the nearest {@link TransportProvider}
 * from context and uses its default view. When `view` is `null`, no view is
 * resolved and every send call rejects immediately.
 * @param props - Options for selecting the view source.
 * @param props.view - An explicit view to send through; omit to use the nearest provider.
 * @returns A stable function that sends messages and returns an {@link ActiveTurn} handle.
 */
export const useSend = <TEvent, TMessage>({
  view,
}: {
  /**
   * Explicit view to send through. When omitted, the nearest {@link TransportProvider}
   * in the tree is used. When `null`, every send call rejects immediately.
   */
  view?: View<TEvent, TMessage> | null;
} = {}): ((messages: TMessage | TMessage[], options?: SendOptions) => Promise<ActiveTurn<TEvent>>) => {
  const nearestSlot = useContext(NearestTransportContext);
  // CAST: NearestTransportContext stores transport with erased generics; types fixed at call site.
  const resolvedView =
    view === undefined
      ? (nearestSlot?.transport as unknown as ClientTransport<TEvent, TMessage> | undefined)?.view
      : (view ?? undefined);

  return useCallback(
    async (messages: TMessage | TMessage[], options?: SendOptions): Promise<ActiveTurn<TEvent>> => {
      if (!resolvedView) {
        throw new Ably.ErrorInfo('unable to send; view is not available', ErrorCode.InvalidArgument, 400);
      }
      return resolvedView.send(messages, options);
    },
    [resolvedView],
  );
};
