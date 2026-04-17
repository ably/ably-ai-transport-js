import type * as Ably from 'ably';
import type * as AI from 'ai';
import { createContext } from 'react';

import type { ClientTransport } from '../../../core/transport/types.js';
import type { ChatTransport } from '../../transport/chat-transport.js';

/**
 * A single entry in the chat transport registry, holding both the
 * underlying {@link ClientTransport} and the {@link ChatTransport} wrapping it.
 */
export interface ChatTransportSlot {
  /** The underlying client transport used to create the chat transport. */
  readonly transport: ClientTransport<AI.UIMessageChunk, AI.UIMessage>;
  /** Construction error from the underlying {@link ClientTransport}, or `undefined` on success. */
  readonly transportError: Ably.ErrorInfo | undefined;
  /** The chat transport adapter for use with Vercel's useChat hook. */
  readonly chatTransport: ChatTransport;
}

/**
 * The shape of the single {@link ChatTransportContext} value.
 * Combines the nearest slot with the full registry in one context object.
 */
export interface ChatTransportContextValue {
  /** The slot from the nearest {@link ChatTransportProvider} in the tree. */
  readonly nearest: ChatTransportSlot | undefined;
  /** All registered slots, keyed by channelName. */
  readonly providers: Readonly<Record<string, ChatTransportSlot>>;
}

/**
 * Context that carries both the nearest {@link ChatTransportSlot} and the full registry of
 * registered slots keyed by channelName. Populated by {@link ChatTransportProvider};
 * read by {@link useChatTransport}.
 */
export const ChatTransportContext = createContext<ChatTransportContextValue>({
  nearest: undefined,
  providers: {},
});
