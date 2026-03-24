/**
 * useMessages — reactive message list from a ClientTransport.
 *
 * Subscribes to the transport's "message" notification and returns
 * the current message list as React state. Replaces the manual
 * useState + useEffect + on("message") + getMessages() pattern.
 */

import { useEffect, useState } from 'react';

import type { ClientTransport } from '../core/transport/types.js';

/**
 * Subscribe to transport message updates and return the current message list.
 * @param transport - The client transport to observe.
 * @returns The current list of decoded messages.
 */
export const useMessages = <TEvent, TMessage>(transport: ClientTransport<TEvent, TMessage>): TMessage[] => {
  const [messages, setMessages] = useState<TMessage[]>(() => transport.getMessages());

  useEffect(() => {
    // Sync initial state in case the transport already has messages
    setMessages(transport.getMessages());

    const unsub = transport.on('message', () => {
      setMessages(transport.getMessages());
    });
    return unsub;
  }, [transport]);

  return messages;
};
