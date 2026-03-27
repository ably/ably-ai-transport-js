/**
 * useMessageSync: wires transport message lifecycle events into useChat's setMessages.
 *
 * Subscribes to the transport's 'message' event and replaces messages state
 * with the transport's authoritative message list. Events fire immediately
 * on every store update (including during active streaming), so this hook
 * keeps React state in sync in real time.
 *
 * Returns the unsubscribe function in the useEffect cleanup so handlers
 * are removed on unmount or when dependencies change.
 */

import type * as AI from 'ai';
import { useEffect } from 'react';

import type { ClientTransport } from '../../core/transport/client/types.js';

/**
 * Wire transport message updates into useChat's `setMessages` updater.
 * @param transport - The client transport to observe, or null/undefined if not yet available.
 * @param setMessages - The `setMessages` updater function from useChat.
 */
export const useMessageSync = (
  transport: ClientTransport<unknown, AI.UIMessage> | null | undefined,
  setMessages: (updater: (prev: AI.UIMessage[]) => AI.UIMessage[]) => void,
): void => {
  useEffect(() => {
    if (!transport) return;
    const unsubscribe = transport.on('message', () => {
      setMessages(() => transport.getMessages());
    });
    return unsubscribe;
  }, [transport, setMessages]);
};
