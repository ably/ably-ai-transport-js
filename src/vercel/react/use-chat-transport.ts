/**
 * useChatTransport: read the {@link ChatTransport} useChat adapter and the
 * {@link ClientTransport} beneath it from the nearest (or a named)
 * {@link import('./contexts/chat-transport-provider.js').ChatTransportProvider}.
 * A thin context reader — it creates no state and manages no lifecycle.
 */

import * as Ably from 'ably';
import { useContext } from 'react';

import type { ClientTransport } from '../../core/transport/types.js';
import { ErrorCode } from '../../errors.js';
import type { VercelInput, VercelOutput } from '../codec/events.js';
import type { ChatTransport } from '../transport/chat-transport.js';
import { ChatTransportContext } from './contexts/chat-transport-context.js';

/** Options for {@link useChatTransport}. */
export interface UseChatTransportOptions {
  /** The channel name of the provider to read. Omit to use the nearest enclosing provider. */
  channelName?: string;
}

/**
 * What {@link useChatTransport} returns: the useChat adapter, the client
 * transport beneath it, and any construction error.
 */
export interface ChatTransportHandle {
  /** The provider's client transport, or `undefined` when construction failed. */
  transport: ClientTransport<VercelInput, VercelOutput> | undefined;
  /** The useChat adapter over {@link transport}, or `undefined` when construction failed. */
  chatTransport: ChatTransport | undefined;
  /** The construction error, or `undefined` when the pair exists. */
  error: Ably.ErrorInfo | undefined;
}

/**
 * Read the pair registered by an enclosing
 * {@link import('./contexts/chat-transport-provider.js').ChatTransportProvider}.
 * @param options - Optional provider lookup; see {@link UseChatTransportOptions}.
 * @returns The adapter, the transport, and any error; see {@link ChatTransportHandle}.
 * @throws {Ably.ErrorInfo} InvalidArgument when no matching provider encloses the caller.
 */
export const useChatTransport = (options: UseChatTransportOptions = {}): ChatTransportHandle => {
  const context = useContext(ChatTransportContext);
  const slot = options.channelName === undefined ? context.nearest : context.providers[options.channelName];
  if (!slot) {
    throw new Ably.ErrorInfo(
      'unable to resolve chat transport; no matching ChatTransportProvider encloses this component',
      ErrorCode.InvalidArgument,
      400,
    );
  }
  return { transport: slot.transport, chatTransport: slot.chatTransport, error: slot.error };
};
