/**
 * useSend — stable callback for sending messages through a ClientTransport.
 *
 * Returns a `send` function that sends one or more messages in a single
 * turn via `transport.send()`. Callers construct the domain messages
 * themselves; the hook provides a stable reference suitable for React deps.
 */

import { useCallback } from 'react';

import type { ActiveTurn, ClientTransport, SendOptions } from '../core/transport/client/types.js';

/**
 * Return a stable `send` callback bound to the given transport.
 * @param transport - The client transport to send through.
 * @returns A function that sends messages and returns an {@link ActiveTurn} handle.
 */
export const useSend = <TEvent, TMessage>(
  transport: ClientTransport<TEvent, TMessage>,
): ((messages: TMessage[], options?: SendOptions) => Promise<ActiveTurn<TEvent>>) =>
  useCallback(
    async (messages: TMessage[], options?: SendOptions): Promise<ActiveTurn<TEvent>> =>
      transport.send(messages, options),
    [transport],
  );
