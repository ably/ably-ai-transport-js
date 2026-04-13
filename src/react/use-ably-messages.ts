/**
 * useAblyMessages — reactive raw Ably message log from a ClientTransport.
 *
 * Accumulates raw Ably InboundMessages from the transport's tree
 * 'ably-message' event. Messages are appended in arrival order.
 *
 * When `transport` is omitted, defaults to the nearest
 * {@link TransportProvider}'s transport via context.
 * Pass `skip: true` to bypass all subscriptions and return an empty array.
 */

import type * as Ably from 'ably';
import { useContext, useEffect, useRef, useState } from 'react';

import type { ClientTransport } from '../core/transport/types.js';
import { NearestTransportContext } from './contexts/transport-context.js';

/**
 * Subscribe to raw Ably message updates from a client transport's tree.
 * When `transport` is omitted, uses the nearest {@link TransportProvider}'s transport via context.
 * @param props - Options including optional `transport` and `skip`.
 * @param props.transport - Transport to subscribe to; defaults to the nearest provider.
 * @param props.skip - When `true`, skip all subscriptions and return an empty array.
 * @returns The accumulated raw Ably messages in chronological order.
 */
export const useAblyMessages = <TEvent, TMessage>({
  transport,
  skip,
}: { transport?: ClientTransport<TEvent, TMessage>; skip?: boolean } = {}): Ably.InboundMessage[] => {
  const nearestTransport = useContext(NearestTransportContext);
  // CAST: NearestTransportContext stores transport with erased generics; types fixed at call site.
  const resolved = skip
    ? undefined
    : ((transport ?? nearestTransport) as ClientTransport<TEvent, TMessage> | undefined);

  const [messages, setMessages] = useState<Ably.InboundMessage[]>([]);
  const messagesRef = useRef<Ably.InboundMessage[]>([]);

  useEffect(() => {
    // Reset on transport change
    messagesRef.current = [];
    setMessages([]);

    if (!resolved) return;

    const unsub = resolved.tree.on('ably-message', (msg: Ably.InboundMessage) => {
      const next = [...messagesRef.current, msg];
      messagesRef.current = next;
      setMessages(next);
    });
    return unsub;
  }, [resolved]);

  return messages;
};
