/**
 * useConversationTree — reactive branch navigation for a ClientTransport.
 *
 * Subscribes to the transport's "message" notification and provides
 * branch navigation primitives (getSiblings, selectSibling, hasSiblings)
 * backed by the transport's ConversationTree.
 *
 * Branch selection state is local to the hook instance — each component
 * (or tab) can navigate branches independently.
 */

import { useCallback, useEffect, useState } from 'react';

import type { ClientTransport } from '../core/transport/types.js';

/** Handle for navigating the branching conversation tree. */
export interface ConversationTreeHandle<TMessage> {
  /** Linear message list for the currently selected branch. */
  messages: TMessage[];
  /** Get all sibling messages at a fork point. */
  getSiblings: (msgId: string) => TMessage[];
  /** Whether a message has siblings (should show navigation arrows). */
  hasSiblings: (msgId: string) => boolean;
  /** Index of the currently selected sibling. */
  getSelectedIndex: (msgId: string) => number;
  /** Navigate to a sibling. Triggers re-render with updated messages. */
  selectSibling: (msgId: string, index: number) => void;
}

/**
 * Subscribe to transport message updates and provide branch navigation primitives.
 * @param transport - The client transport whose conversation tree to navigate.
 * @returns A {@link ConversationTreeHandle} with the current messages and navigation methods.
 */
export const useConversationTree = <TEvent, TMessage>(
  transport: ClientTransport<TEvent, TMessage>,
): ConversationTreeHandle<TMessage> => {
  const [messages, setMessages] = useState<TMessage[]>(() => transport.getMessages());

  useEffect(() => {
    setMessages(transport.getMessages());

    const unsub = transport.on('message', () => {
      setMessages(transport.getMessages());
    });
    return unsub;
  }, [transport]);

  const getSiblings = useCallback((msgId: string) => transport.getTree().getSiblings(msgId), [transport]);

  const hasSiblings = useCallback((msgId: string) => transport.getTree().hasSiblings(msgId), [transport]);

  const getSelectedIndex = useCallback((msgId: string) => transport.getTree().getSelectedIndex(msgId), [transport]);

  const selectSibling = useCallback(
    (msgId: string, index: number) => {
      transport.getTree().select(msgId, index);
      // flattenNodes() returns a new array after select(), triggering re-render.
      setMessages(transport.getMessages());
    },
    [transport],
  );

  return {
    messages,
    getSiblings,
    hasSiblings,
    getSelectedIndex,
    selectSibling,
  };
};
