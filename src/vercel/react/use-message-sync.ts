/**
 * useMessageSync: wires transport message lifecycle events into useChat's setMessages.
 *
 * Subscribes to the transport view's 'update' event and replaces messages state
 * with the view's authoritative message list. Events fire immediately
 * on every view update (including during active streaming), so this hook
 * keeps React state in sync in real time.
 *
 * Returns the unsubscribe function in the useEffect cleanup so handlers
 * are removed on unmount or when dependencies change.
 */

import type * as AI from 'ai';
import { useEffect } from 'react';

import type { ClientTransport } from '../../core/transport/types.js';

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
    const unsubscribe = transport.view.on('update', () => {
      setMessages(() => transport.view.flattenNodes().map((n) => n.message));
    });
    return unsubscribe;
  }, [transport, setMessages]);
};
