/**
 * useRegenerate — stable callback for regenerating an assistant message.
 *
 * Delegates to `transport.regenerate()`, which automatically computes
 * `forkOf`, `parent`, and truncated history from the conversation tree.
 */

import { useCallback } from 'react';

import type { ActiveTurn, ClientTransport, SendOptions } from '../core/transport/types.js';

/**
 * Return a stable `regenerate` callback bound to the given transport.
 * @param transport - The client transport to regenerate through.
 * @returns A function that regenerates an assistant message and returns an {@link ActiveTurn} handle.
 */
export const useRegenerate = <TEvent, TMessage>(
  transport: ClientTransport<TEvent, TMessage>,
): ((messageId: string, options?: SendOptions) => Promise<ActiveTurn<TEvent>>) =>
  useCallback(
    async (messageId: string, options?: SendOptions): Promise<ActiveTurn<TEvent>> =>
      transport.regenerate(messageId, options),
    [transport],
  );
