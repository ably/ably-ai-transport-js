/**
 * useEdit — stable callback for editing a user message.
 *
 * Delegates to `view.edit()`, which automatically computes
 * `forkOf`, `parent`, and history from the view's branch.
 */

import { useCallback } from 'react';

import type { ActiveTurn, SendOptions, View } from '../core/transport/types.js';

/**
 * Return a stable `edit` callback bound to the given view.
 * @param view - The view to edit through.
 * @returns A function that edits a user message and returns an {@link ActiveTurn} handle.
 */
export const useEdit = <TEvent, TMessage>(
  view: View<TEvent, TMessage>,
): ((messageId: string, newMessages: TMessage | TMessage[], options?: SendOptions) => Promise<ActiveTurn<TEvent>>) =>
  useCallback(
    async (messageId: string, newMessages: TMessage | TMessage[], options?: SendOptions): Promise<ActiveTurn<TEvent>> =>
      view.edit(messageId, newMessages, options),
    [view],
  );
