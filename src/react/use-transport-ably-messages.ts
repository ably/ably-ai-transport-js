/**
 * useAblyMessages: a reactive raw Ably message log off a
 * {@link ClientTransport}'s `ably-message` stream. Messages are appended in
 * arrival order — the demos use it for their debug pane.
 */

import type * as Ably from 'ably';
import { useEffect, useState } from 'react';

import { useClientTransport } from './use-client-transport.js';

/** Options for {@link useAblyMessages}. */
export interface UseAblyMessagesOptions {
  /** The channel name of the provider whose transport to subscribe. Omit for the nearest provider. */
  channelName?: string;
}

/**
 * Accumulate the raw inbound Ably messages the enclosing provider's transport
 * receives. The log resets when the transport changes (a provider
 * channel-name change recreates it).
 * @param options - Optional provider lookup; see {@link UseAblyMessagesOptions}.
 * @returns The raw messages in arrival order.
 */
export const useAblyMessages = (options: UseAblyMessagesOptions = {}): Ably.InboundMessage[] => {
  const { transport } = useClientTransport(options);
  const [messages, setMessages] = useState<Ably.InboundMessage[]>([]);

  useEffect(() => {
    setMessages([]);
    if (!transport) return;
    return transport.on('ably-message', (msg: Ably.InboundMessage) => {
      setMessages((prior) => [...prior, msg]);
    });
  }, [transport]);

  return messages;
};
