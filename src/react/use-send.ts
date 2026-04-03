/**
 * useSend — stable callback for sending messages through a View.
 *
 * Returns a `send` function that sends one or more messages in a single
 * turn via `view.send()`. Callers construct the domain messages
 * themselves; the hook provides a stable reference suitable for React deps.
 */

import { useCallback } from 'react';

import type { ActiveTurn, SendOptions, View } from '../core/transport/types.js';

/**
 * Return a stable `send` callback bound to the given view.
 * @param view - The view to send through.
 * @returns A function that sends messages and returns an {@link ActiveTurn} handle.
 */
export const useSend = <TEvent, TMessage>(
  view: View<TEvent, TMessage>,
): ((messages: TMessage[], options?: SendOptions) => Promise<ActiveTurn<TEvent>>) =>
  useCallback(
    async (messages: TMessage[], options?: SendOptions): Promise<ActiveTurn<TEvent>> => view.send(messages, options),
    [view],
  );
