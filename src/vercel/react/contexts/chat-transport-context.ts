/**
 * React context carrying the {@link ChatTransport} instances registered by
 * {@link import('./chat-transport-provider.js').ChatTransportProvider}. Each
 * provider merges its slot into the parent record, so nested providers with
 * distinct channel names are all reachable by name, and the nearest one is
 * the default.
 */

import type * as Ably from 'ably';
import { createContext } from 'react';

import type { ClientTransport } from '../../../core/transport/types.js';
import type { VercelInput, VercelOutput } from '../../codec/events.js';
import type { ChatTransport } from '../../transport/chat-transport.js';

/**
 * One provider's registration: the client transport and the useChat adapter
 * built on it, or the construction error when creating them threw.
 */
export interface ChatTransportSlot {
  /** The provider's client transport, or `undefined` when construction failed. */
  transport: ClientTransport<VercelInput, VercelOutput> | undefined;
  /** The useChat adapter over {@link transport}, or `undefined` when construction failed. */
  chatTransport: ChatTransport | undefined;
  /** The construction error, or `undefined` when the pair was created. */
  error: Ably.ErrorInfo | undefined;
}

/** The context value: the nearest provider's slot plus every named provider's slot. */
export interface ChatTransportContextValue {
  /** The nearest enclosing provider's slot. */
  nearest: ChatTransportSlot | undefined;
  /** Every enclosing provider's slot, keyed by channel name. */
  providers: Record<string, ChatTransportSlot>;
}

/** The context {@link import('./chat-transport-provider.js').ChatTransportProvider} publishes into. */
export const ChatTransportContext = createContext<ChatTransportContextValue>({
  nearest: undefined,
  providers: {},
});
