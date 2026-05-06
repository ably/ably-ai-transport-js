/**
 * ChatTransportProvider: creates a ChatTransport from a ClientSession and makes it
 * available to descendants via ChatTransportContext.
 *
 * Wraps children with ClientSessionProvider (using UIMessageCodec). The
 * surrounding `<AblyProvider>` supplies the Realtime client; the session
 * resolves the channel from `channelName` itself. An inner component reads
 * the ClientSession via useClientSession() and creates the ChatTransport
 * once on first render (via useRef).
 *
 * The ChatTransport is NOT closed on unmount — the underlying ClientSession
 * lifecycle is managed by the wrapping ClientSessionProvider. Auto-closing would break
 * React Strict Mode, and ChatTransport.close() delegates to ClientSession.close()
 * which ClientSessionProvider already calls.
 *
 * Multiple ChatTransportProviders can be nested using distinct channelNames.
 * Each provider merges its session into the parent registry, so descendants
 * can access all registered sessions via useChatTransport({ channelName }).
 */

import type * as AI from 'ai';
import { type PropsWithChildren, type ReactNode, useContext, useMemo } from 'react';

import { type ClientSessionProviderProps, createSessionHooks } from '../../../react/index.js';
import { UIMessageCodec } from '../../codec/index.js';
import { type ChatTransportOptions, DEFAULT_VERCEL_API } from '../../transport/index.js';
import { createChatTransport } from '../../transport/index.js';
import type { ChatTransportSlot } from './chat-transport-context.js';
import { ChatTransportContext } from './chat-transport-context.js';

export const {
  ClientSessionProvider,
  useAblyMessages,
  useActiveRuns,
  useClientSession,
  useCreateView,
  useTree,
  useView,
} = createSessionHooks<AI.UIMessageChunk, AI.UIMessage>();

type CoreClientSessionProviderProps = Omit<
  ClientSessionProviderProps<AI.UIMessageChunk, AI.UIMessage>,
  'codec' | 'api'
> &
  Partial<Pick<ClientSessionProviderProps<AI.UIMessageChunk, AI.UIMessage>, 'api'>>;

/**
 * Props for {@link ChatTransportProvider}.
 *
 * All {@link ClientSessionProviderProps} for Vercel types except `codec` (baked as UIMessageCodec),
 * plus `chatOptions` for customizing chat request construction.
 */
export interface ChatTransportProviderProps extends CoreClientSessionProviderProps {
  /**
   * Optional hooks for customizing chat request construction (e.g. prepareSendMessagesRequest).
   * Must be stable across renders — wrap in `useMemo` or define outside the component.
   * A new object reference triggers ChatTransport recreation.
   */
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
  const { session, sessionError } = useClientSession();
  const { providers: parentProviders } = useContext(ChatTransportContext);
  const chatTransport = useMemo(() => createChatTransport(session, chatOptions), [session, chatOptions]);
  const contextValue = useMemo(() => {
    const slot: ChatTransportSlot = { session, sessionError, chatTransport };
    return {
      nearest: slot,
      providers: { ...parentProviders, [channelName]: slot },
    };
  }, [channelName, parentProviders, chatTransport, session, sessionError]);

  return <ChatTransportContext.Provider value={contextValue}>{children}</ChatTransportContext.Provider>;
};

/**
 * Provide a {@link ChatTransport} and its underlying {@link ClientSession} to descendant components.
 *
 * Wraps children with `ClientSessionProvider` using `channelName` (the Realtime
 * client is read from the surrounding `<AblyProvider>`), creates a
 * {@link ClientSession} with UIMessageCodec, wraps it in a {@link ChatTransport},
 * and registers the full slot in `ChatTransportContext` under `channelName`. Descendants call
 * {@link useChatTransport} with the same `channelName` to access both.
 *
 * `useClientSession` is also available inside this provider's subtree.
 *
 * ```tsx
 * <ChatTransportProvider channelName="ai:demo">
 *   <Chat />
 * </ChatTransportProvider>
 *
 * // Inside Chat:
 * const { chatTransport, session } = useChatTransport();
 * const { session } = useClientSession(); // also available
 * ```
 * @param props - Provider configuration including `channelName`, optional `chatOptions`, and all other session options.
 * @param props.chatOptions - Optional hooks for customizing chat request construction. Must be stable (memoized) — a new reference recreates the ChatTransport.
 * @param props.children - Descendant components that consume the chat transport via hooks.
 * @returns A React element wrapping children with ClientSessionContext and ChatTransportContext.
 */
export const ChatTransportProvider = ({
  chatOptions,
  children,
  ...sessionProps
}: ChatTransportProviderProps & PropsWithChildren): ReactNode => (
  <ClientSessionProvider
    {...sessionProps}
    api={sessionProps.api ?? DEFAULT_VERCEL_API}
    codec={UIMessageCodec}
  >
    <ChatTransportProviderInner
      channelName={sessionProps.channelName}
      chatOptions={chatOptions}
    >
      {children}
    </ChatTransportProviderInner>
  </ClientSessionProvider>
);
