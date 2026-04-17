/**
 * ChatTransportProvider: creates a ChatTransport from a ClientTransport and makes it
 * available to descendants via ChatTransportContext.
 *
 * Wraps children with TransportProvider (using UIMessageCodec) so the Ably channel
 * lifecycle is managed in one place. An inner component reads the ClientTransport
 * from NearestTransportContext and creates the ChatTransport once on first render
 * (via useRef).
 *
 * The ChatTransport is NOT closed on unmount — the underlying ClientTransport
 * lifecycle is managed by the wrapping TransportProvider. Auto-closing would break
 * React Strict Mode, and ChatTransport.close() delegates to ClientTransport.close()
 * which TransportProvider already calls.
 *
 * Multiple ChatTransportProviders can be nested using distinct channelNames.
 * Each provider merges its transport into the parent registry, so descendants
 * can access all registered transports via useChatTransport({ channelName }).
 */

import type * as AI from 'ai';
import { type PropsWithChildren, type ReactNode, useContext, useMemo } from 'react';

import { createTransportHooks, type TransportProviderProps } from '../../../react/index.js';
import { UIMessageCodec } from '../../codec/index.js';
import type { ChatTransportOptions } from '../../transport/index.js';
import { createChatTransport } from '../../transport/index.js';
import type { ChatTransportSlot } from './chat-transport-context.js';
import { ChatTransportContext } from './chat-transport-context.js';

export const {
  TransportProvider,
  useAblyMessages,
  useActiveTurns,
  useClientTransport,
  useCreateView,
  useTree,
  useView,
} = createTransportHooks<AI.UIMessageChunk, AI.UIMessage>();

/**
 * Props for {@link ChatTransportProvider}.
 *
 * All {@link TransportProviderProps} for Vercel types except `codec` (baked as UIMessageCodec),
 * plus `chatOptions` for customizing chat request construction.
 */
export interface ChatTransportProviderProps extends Omit<
  TransportProviderProps<AI.UIMessageChunk, AI.UIMessage>,
  'codec'
> {
  /** Optional hooks for customizing chat request construction (e.g. prepareSendMessagesRequest). */
  chatOptions?: ChatTransportOptions;
}

const ChatTransportProviderInner = ({
  channelName,
  chatOptions,
  children,
}: {
  channelName: string;
  chatOptions?: ChatTransportOptions;
  children: ReactNode;
}) => {
  const { transport, transportError } = useClientTransport();
  const { providers: parentProviders } = useContext(ChatTransportContext);
  const chatTransport = useMemo(() => createChatTransport(transport, chatOptions), [transport, chatOptions]);
  const contextValue = useMemo(() => {
    const slot: ChatTransportSlot = { transport, transportError, chatTransport };
    return {
      nearest: slot,
      providers: { ...parentProviders, [channelName]: slot },
    };
  }, [channelName, parentProviders, chatTransport, transport, transportError]);

  return <ChatTransportContext.Provider value={contextValue}>{children}</ChatTransportContext.Provider>;
};

/**
 * Provide a {@link ChatTransport} and its underlying {@link ClientTransport} to descendant components.
 *
 * Wraps children with Ably's `ChannelProvider` (via `TransportProvider`) using `channelName`,
 * creates a {@link ClientTransport} with UIMessageCodec, wraps it in a {@link ChatTransport},
 * and registers the full slot in `ChatTransportContext` under `channelName`. Descendants call
 * {@link useChatTransport} with the same `channelName` to access both transports.
 *
 * `useClientTransport` is also available inside this provider's subtree.
 *
 * ```tsx
 * <ChatTransportProvider channelName="ai:demo">
 *   <Chat />
 * </ChatTransportProvider>
 *
 * // Inside Chat:
 * const { chatTransport, transport } = useChatTransport();
 * const { transport } = useClientTransport(); // also available
 * ```
 * @param props - Provider configuration including `channelName`, optional `chatOptions`, and all other transport options.
 * @param props.chatOptions - Optional hooks for customizing chat request construction.
 * @param props.children - Descendant components that consume the transport via hooks.
 * @returns A React element wrapping children with ChannelProvider, TransportContext, and ChatTransportContext.
 */
export const ChatTransportProvider = ({
  chatOptions,
  children,
  ...transportProps
}: ChatTransportProviderProps & PropsWithChildren): ReactNode => (
  <TransportProvider
    {...transportProps}
    codec={UIMessageCodec}
  >
    <ChatTransportProviderInner
      channelName={transportProps.channelName}
      chatOptions={chatOptions}
    >
      {children}
    </ChatTransportProviderInner>
  </TransportProvider>
);
