/**
 * useAblyMessages — reactive raw Ably message log from a ClientTransport.
 *
 * Accumulates raw Ably InboundMessages from the transport's tree
 * 'ably-message' event. Messages are appended in arrival order.
 */

import type * as Ably from 'ably';
import { useEffect, useRef, useState } from 'react';

import type { ClientTransport } from '../core/transport/types.js';

/**
 * Subscribe to raw Ably message updates from a client transport's tree.
 * @param transport - The client transport to observe.
 * @returns The accumulated raw Ably messages in chronological order.
 */
export const useAblyMessages = <TEvent, TMessage>(
  transport: ClientTransport<TEvent, TMessage>,
): Ably.InboundMessage[] => {
  const [messages, setMessages] = useState<Ably.InboundMessage[]>([]);
  const messagesRef = useRef<Ably.InboundMessage[]>([]);

  useEffect(() => {
    // Reset on transport change
    messagesRef.current = [];
    setMessages([]);

    const unsub = transport.tree.on('ably-message', (msg: Ably.InboundMessage) => {
      const next = [...messagesRef.current, msg];
      messagesRef.current = next;
      setMessages(next);
    });
    return unsub;
  }, [transport]);

  return messages;
};
