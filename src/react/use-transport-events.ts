/**
 * useTransportEvents: subscribe a handler to a {@link ClientTransport}'s
 * classified event stream for the component's lifetime. It adds no state and
 * no buffering — it only wraps the unsubscribe `subscribe()` returns in an
 * effect so every consumer does not write the same one.
 */

import { useEffect, useRef } from 'react';

import type { TransportEvent } from '../core/transport/types.js';
import { useClientTransport } from './use-client-transport.js';

/**
 * Options for {@link useTransportEvents}.
 */
export interface UseTransportEventsOptions {
  /** The channel name of the provider whose transport to subscribe. Omit for the nearest provider. */
  channelName?: string;
}

/**
 * Subscribe to the enclosing provider's transport events. The handler is read
 * through a ref, so an inline (unmemoised) handler does not resubscribe per
 * render; the subscription itself lives for as long as the transport does.
 * @template TInput - The codec's input-event domain type.
 * @template TOutput - The codec's output-event domain type.
 * @param handler - Called with each classified {@link TransportEvent} to observe it.
 * @param options - Optional provider lookup; see {@link UseTransportEventsOptions}.
 */
export const useTransportEvents = <TInput = unknown, TOutput = unknown>(
  handler: (event: TransportEvent<TInput, TOutput>) => void,
  options: UseTransportEventsOptions = {},
): void => {
  const { transport } = useClientTransport<TInput, TOutput>(options);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!transport) return;
    return transport.subscribe((event) => {
      handlerRef.current(event);
    });
  }, [transport]);
};
