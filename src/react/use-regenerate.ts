/**
 * useRegenerate — stable callback for regenerating an assistant message.
 *
 * Delegates to `view.regenerate()`, which automatically computes
 * `forkOf`, `parent`, and truncated history from the view's branch.
 */

import { useCallback } from 'react';

import type { ActiveTurn, SendOptions, View } from '../core/transport/types.js';

/**
 * Return a stable `regenerate` callback bound to the given view.
 * @param view - The view to regenerate through.
 * @returns A function that regenerates an assistant message and returns an {@link ActiveTurn} handle.
 */
export const useRegenerate = <TEvent, TMessage>(
  view: View<TEvent, TMessage>,
): ((messageId: string, options?: SendOptions) => Promise<ActiveTurn<TEvent>>) =>
  useCallback(
    async (messageId: string, options?: SendOptions): Promise<ActiveTurn<TEvent>> =>
      view.regenerate(messageId, options),
    [view],
  );
