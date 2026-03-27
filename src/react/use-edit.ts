/**
 * useEdit — stable callback for editing a user message.
 *
 * Delegates to `transport.edit()`, which automatically computes
 * `forkOf`, `parent`, and history from the conversation tree.
 */

import { useCallback } from 'react';

import type { ActiveTurn, ClientTransport, SendOptions } from '../core/transport/client/types.js';

/**
 * Return a stable `edit` callback bound to the given transport.
 * @param transport - The client transport to edit through.
 * @returns A function that edits a user message and returns an {@link ActiveTurn} handle.
 */
export const useEdit = <TEvent, TMessage>(
  transport: ClientTransport<TEvent, TMessage>,
): ((messageId: string, newMessages: TMessage | TMessage[], options?: SendOptions) => Promise<ActiveTurn<TEvent>>) =>
  useCallback(
    async (messageId: string, newMessages: TMessage | TMessage[], options?: SendOptions): Promise<ActiveTurn<TEvent>> =>
      transport.edit(messageId, newMessages, options),
    [transport],
  );
