/**
 * useDeliveries: subscribe a handler to the transport's deliveries for the
 * life of the component.
 */

import { useEffect, useRef } from 'react';

import type { Delivery } from '../core/codec/index.js';
import { useTransportSlot } from './use-transport.js';

/** Options for {@link useDeliveries}. */
export interface UseDeliveriesOptions {
  /** The channel name of the provider to read. Omit to use the nearest enclosing provider. */
  channelName?: string;
}

/**
 * Deliver every decoded event, every message whose decode threw, and every
 * delete to `handler` while the component is mounted. The latest `handler` is
 * read on each delivery, so an inline function resubscribes nothing.
 * Subscribing attaches the channel; a failed attach is reported through
 * `useTransportStatus`.
 * @template E - The codec's event union.
 * @param handler - Called with each delivery, in channel order.
 * @param options - The provider to read; see {@link UseDeliveriesOptions}.
 * @throws {Ably.ErrorInfo} `InvalidArgument` when no matching provider encloses the caller.
 */
export const useDeliveries = <E = unknown>(
  handler: (delivery: Delivery<E>) => void,
  options: UseDeliveriesOptions = {},
): void => {
  const { transport } = useTransportSlot(options.channelName);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (transport === undefined) return;
    // CAST: the provider stores the transport with its event type erased;
    // the caller's type argument re-applies the codec's type here.
    return transport.subscribe((delivery) => {
      handlerRef.current(delivery as Delivery<E>);
    });
  }, [transport]);
};
