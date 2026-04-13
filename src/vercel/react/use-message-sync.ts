/**
 * useMessageSync: wires transport message lifecycle events into useChat's setMessages.
 *
 * Subscribes to the transport view's 'update' event and replaces messages state
 * with the view's authoritative message list.
 *
 * When a ChatTransport is provided, setMessages calls are gated during active
 * own-turn streams. This prevents the push/replace ID mismatch in useChat's
 * write() function. When the stream finishes, the gate opens and an immediate
 * sync fires to pick up any observer messages that arrived during the stream.
 *
 * Returns the unsubscribe function in the useEffect cleanup so handlers
 * are removed on unmount or when dependencies change.
 */

import type * as AI from 'ai';
import { useEffect, useState } from 'react';

import type { ClientTransport } from '../../core/transport/types.js';
import type { ChatTransport } from '../transport/chat-transport.js';

/**
 * Wire transport message updates into useChat's `setMessages` updater.
 * @param transport - The client transport to observe, or null/undefined if not yet available.
 * @param setMessages - The `setMessages` updater function from useChat.
 * @param chatTransport - Optional ChatTransport for streaming gate. When provided,
 *   setMessages is suppressed during active own-turn streams to avoid interfering
 *   with useChat's internal accumulator.
 */
export const useMessageSync = (
  transport: ClientTransport<unknown, AI.UIMessage> | null | undefined,
  setMessages: (updater: (prev: AI.UIMessage[]) => AI.UIMessage[]) => void,
  chatTransport?: ChatTransport,
): void => {
  const [gated, setGated] = useState(false);

  // Subscribe to the ChatTransport's streaming state to gate setMessages.
  // Reset gated to the new instance's current state so a stale `true`
  // from a previous instance doesn't permanently suppress syncs.
  useEffect(() => {
    if (!chatTransport) {
      setGated(false);
      return;
    }
    setGated(chatTransport.streaming);
    return chatTransport.onStreamingChange(setGated);
  }, [chatTransport]);

  // Subscribe to view updates and sync messages, unless gated.
  useEffect(() => {
    if (!transport || gated) return;

    const sync = (): void => {
      setMessages(() => transport.view.flattenNodes().map((n) => n.message));
    };

    // Sync immediately when the effect runs (covers gate-open and initial mount).
    sync();

    const unsubscribe = transport.view.on('update', sync);
    return unsubscribe;
  }, [transport, setMessages, gated]);
};
