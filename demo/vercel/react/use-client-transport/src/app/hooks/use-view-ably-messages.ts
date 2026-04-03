'use client';

/**
 * useViewAblyMessages — accumulates raw Ably messages scoped to a View.
 *
 * Subscribes to the View's 'ably-message' event, which only fires for
 * messages corresponding to visible nodes in that view's window.
 */

import type * as Ably from 'ably';
import { useEffect, useRef, useState } from 'react';
import type { View } from '@ably/ai-transport';

export const useViewAblyMessages = <TEvent, TMessage>(
  view: View<TEvent, TMessage> | null | undefined,
): Ably.InboundMessage[] => {
  const [messages, setMessages] = useState<Ably.InboundMessage[]>([]);
  const messagesRef = useRef<Ably.InboundMessage[]>([]);

  useEffect(() => {
    if (!view) return;
    messagesRef.current = [];
    setMessages([]);

    const unsub = view.on('ably-message', (msg: Ably.InboundMessage) => {
      const next = [...messagesRef.current, msg];
      messagesRef.current = next;
      setMessages(next);
    });
    return unsub;
  }, [view]);

  return messages;
};
