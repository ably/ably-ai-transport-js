/**
 * ChatTransportProvider: creates a ChatTransport from a ClientSession and makes it
 * available to descendants via ChatTransportContext.
 *
 * Wraps children with ClientSessionProvider (using the default Vercel codec). The
 * surrounding `<AblyProvider>` supplies the Realtime client; the session
 * resolves the channel from `channelName` itself. An inner component reads
 * the ClientSession via useClientSession() and creates the ChatTransport
 * via useMemo, keyed on the session and transport options.
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
import type { VercelOutput } from '../../codec/index.js';
import type { VercelProjection } from '../../codec/reducer.js';
import { createUIMessageSessionCodec } from '../../codec/session-codec.js';
import type { VercelSessionInput } from '../../codec/session-events.js';
import type { ChatTransportOptions } from '../../transport/index.js';
import { createChatTransport } from '../../transport/index.js';
import type { ChatTransportSlot } from './chat-transport-context.js';
import { ChatTransportContext } from './chat-transport-context.js';

export const { ClientSessionProvider, useAblyMessages, useClientSession, useCreateView, useTree, useView } =
  createSessionHooks<VercelSessionInput, VercelOutput, VercelProjection, AI.UIMessage>();

/**
 * The default Vercel codec this provider binds. The provider/context path is
 * instantiated at module scope, so it is SDK-default-typed; for per-instance
 * `UIMessage` typing use the imperative path (`createClientSession<…>` +
 * `createChatTransport<…>` + `useMessageSync<…>`).
 */
const defaultUIMessageCodec = createUIMessageSessionCodec();

type CoreClientSessionProviderProps = Omit<
  ClientSessionProviderProps<VercelSessionInput, VercelOutput, VercelProjection, AI.UIMessage>,
  'codec'
>;

/**
 * Props for {@link ChatTransportProvider}.
 *
 * All {@link ClientSessionProviderProps} for Vercel types except `codec` (baked as the default Vercel codec),
 * plus the transport-owned invocation POST options (`api` / `credentials` / `fetch`) and
 * `chatOptions` for customizing chat request construction.
 */
export interface ChatTransportProviderProps extends CoreClientSessionProviderProps {
  /** Endpoint the chat transport POSTs the invocation to, to wake the agent. Default `/api/chat`. */
  api?: string;
  /** Fetch credentials mode for the invocation POST. */
  credentials?: RequestCredentials;
  /** Custom fetch implementation for the invocation POST. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /**
   * Optional transport options for customizing chat request construction (e.g. the `prepareSendMessagesRequest` hook).
   * Must be stable across renders — wrap in `useMemo` or define outside the component.
   * A new object reference triggers ChatTransport recreation.
   * If this object also sets `api`/`credentials`/`fetch`, the dedicated top-level props of the same name take precedence.
   */
  chatOptions?: ChatTransportOptions;
}

const ChatTransportProviderInner = ({
  channelName,
  chatTransportOptions,
  children,
}: {
  channelName: string;
  chatTransportOptions: ChatTransportOptions;
  children: ReactNode;
}) => {
  const { session, sessionError } = useClientSession();
  const { providers: parentProviders } = useContext(ChatTransportContext);
  const chatTransport = useMemo(
    () => createChatTransport(session, chatTransportOptions),
    [session, chatTransportOptions],
  );
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
 * {@link ClientSession} with the default Vercel codec, wraps it in a {@link ChatTransport},
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
 * @param props - Provider configuration including `channelName`, the invocation POST options (`api` / `credentials` / `fetch`), optional `chatOptions`, and all other session options.
 * @param props.api - Endpoint the chat transport POSTs the invocation to. Default `/api/chat`.
 * @param props.credentials - Fetch credentials mode for the invocation POST.
 * @param props.fetch - Custom fetch implementation for the invocation POST.
 * @param props.chatOptions - Optional hooks for customizing chat request construction. Must be stable (memoized) — a new reference recreates the ChatTransport.
 * @param props.children - Descendant components that consume the chat transport via hooks.
 * @returns A React element wrapping children with ClientSessionContext and ChatTransportContext.
 */
export const ChatTransportProvider = ({
  api,
  credentials,
  fetch,
  chatOptions,
  children,
  ...sessionProps
}: ChatTransportProviderProps & PropsWithChildren): ReactNode => {
  // Fold the transport-owned POST options into a single ChatTransportOptions.
  // Memoized so the ChatTransport isn't recreated each render — createChatTransport
  // is keyed on this object's identity.
  const chatTransportOptions = useMemo<ChatTransportOptions>(
    () => ({
      ...chatOptions,
      ...(api !== undefined && { api }),
      ...(credentials !== undefined && { credentials }),
      ...(fetch !== undefined && { fetch }),
    }),
    [api, credentials, fetch, chatOptions],
  );

  return (
    <ClientSessionProvider
      {...sessionProps}
      codec={defaultUIMessageCodec}
    >
      <ChatTransportProviderInner
        channelName={sessionProps.channelName}
        chatTransportOptions={chatTransportOptions}
      >
        {children}
      </ChatTransportProviderInner>
    </ClientSessionProvider>
  );
};
