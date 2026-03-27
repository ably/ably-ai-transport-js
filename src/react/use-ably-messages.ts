/**
 * useAblyMessages — reactive raw Ably message log from a ClientTransport.
 *
 * Returns the accumulated raw Ably InboundMessages in chronological order,
 * including both live messages (from the channel subscription) and
 * history-loaded messages (from transport.history() calls).
 *
 * Subscribes to the transport's "ably-message" event and re-reads the
 * list on each update.
 */

import type * as Ably from 'ably';
import { useEffect, useState } from 'react';

import type { ClientTransport } from '../core/transport/client/types.js';

/**
 * Subscribe to raw Ably message updates from a client transport.
 * @param transport - The client transport to observe.
 * @returns The accumulated raw Ably messages in chronological order.
 */
export const useAblyMessages = <TEvent, TMessage>(
  transport: ClientTransport<TEvent, TMessage>,
): Ably.InboundMessage[] => {
  const [messages, setMessages] = useState<Ably.InboundMessage[]>(() => transport.getAblyMessages());

  useEffect(() => {
    setMessages(transport.getAblyMessages());

    const unsub = transport.on('ably-message', () => {
      setMessages(transport.getAblyMessages());
    });
    return unsub;
  }, [transport]);

  return messages;
};
