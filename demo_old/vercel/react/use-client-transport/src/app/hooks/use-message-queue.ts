'use client';

/**
 * useMessageQueue — queues messages when the user has active turns.
 *
 * Uses transport.waitForTurn() to detect when all own turns complete,
 * then drains the queue in a single send() call. A self-sustaining
 * drain loop handles the case where sending queued messages creates new
 * turns — it waits again and checks for more items queued during that time.
 */

import { useState, useRef, useCallback } from 'react';
import type { ClientTransport, ActiveTurn, SendOptions } from '@ably/ai-transport';
import type { UIMessageChunk, UIMessage } from 'ai';
import { userMessage } from '../helpers';

export interface QueuedMessage {
  id: string;
  text: string;
  createdAt: Date;
}

export interface QueueHandle {
  items: QueuedMessage[];
  add: (text: string) => void;
  remove: (id: string) => void;
  clear: () => void;
}

type SendFn = (messages: UIMessage[], options?: SendOptions) => Promise<ActiveTurn<UIMessageChunk>>;

export function useMessageQueue(transport: ClientTransport<UIMessageChunk, UIMessage>, send: SendFn): QueueHandle {
  const [items, setItems] = useState<QueuedMessage[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const sendRef = useRef(send);
  sendRef.current = send;

  const transportRef = useRef(transport);
  transportRef.current = transport;

  const drainingRef = useRef(false);

  const drain = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      while (itemsRef.current.length > 0) {
        await transportRef.current.waitForTurn();
        const batch = itemsRef.current;
        if (batch.length === 0) break;
        setItems([]);
        itemsRef.current = [];
        const msgs = batch.map((item) => userMessage(item.text));
        await sendRef.current(msgs);
      }
    } finally {
      drainingRef.current = false;
    }
  }, []);

  const add = useCallback(
    (text: string) => {
      const item: QueuedMessage = {
        id: crypto.randomUUID(),
        text,
        createdAt: new Date(),
      };
      setItems((prev) => {
        const next = [...prev, item];
        itemsRef.current = next;
        return next;
      });
      drain();
    },
    [drain],
  );

  const remove = useCallback((id: string) => {
    setItems((prev) => {
      const next = prev.filter((item) => item.id !== id);
      itemsRef.current = next;
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setItems([]);
    itemsRef.current = [];
  }, []);

  return { items, add, remove, clear };
}
