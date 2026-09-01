/**
 * ChatTransportProvider: the Vercel entry point for `useChat`. Builds on the
 * generic {@link ClientTransportProvider} — which creates and connects a
 * {@link ClientTransport} pre-bound to the Vercel codec on the named channel —
 * and layers the {@link ChatTransport} useChat adapter over it.
 *
 * The adapter holds no conversation state, so it is created once per
 * transport (a channel-name change recreates both). A superseded adapter is
 * closed from an effect when the transport is recreated, and the current one
 * is closed on a true unmount via a microtask-deferred close that React
 * Strict Mode's synchronous remount cancels — the same lifecycle the generic
 * provider gives the transport itself. Descendants read the pair with
 * {@link import('../use-chat-transport.js').useChatTransport} and hand
 * `chatTransport` straight to `useChat({ transport })`.
 */

import { type PropsWithChildren, type ReactNode, useContext, useEffect, useMemo, useRef } from 'react';

import type { Logger } from '../../../logger.js';
import type { ClientTransportProviderProps } from '../../../react/index.js';
import { ClientTransportProvider, useClientTransport } from '../../../react/index.js';
import type { VercelInput, VercelOutput } from '../../codec/index.js';
import { createUIMessageCodec } from '../../codec/index.js';
import { createChatTransport } from '../../transport/chat-transport.js';
import type { ChatTransportSlot } from './chat-transport-context.js';
import { ChatTransportContext } from './chat-transport-context.js';

/**
 * Props for {@link ChatTransportProvider}: the generic provider's props with
 * the codec supplied automatically, plus the useChat adapter's route options.
 */
export interface ChatTransportProviderProps
  extends Omit<ClientTransportProviderProps<VercelInput, VercelOutput>, 'codec'>, PropsWithChildren {
  /**
   * The chat route URL the adapter POSTs the invocation pointer to. Defaults
   * to `/api/chat`. Must stay constant for the provider's lifetime: the
   * adapter is recreated only when the transport is.
   */
  api?: string;
}

/**
 * The inner half: reads the transport the generic provider created and builds
 * the useChat adapter over it.
 * @param props - The adapter's route options plus children.
 * @param props.channelName - The conversation's channel name (also the provider key).
 * @param props.api - The chat route URL.
 * @param props.logger - Logger handed to the adapter, so its diagnostics reach the same place the transport's do.
 * @param props.children - Descendants that consume the pair.
 * @returns The children wrapped in {@link ChatTransportContext}.
 */
const ChatTransportBridge = ({
  channelName,
  api,
  logger,
  children,
}: PropsWithChildren<{ channelName: string; api?: string; logger?: Logger }>): ReactNode => {
  const { transport, error } = useClientTransport<VercelInput, VercelOutput>();

  const adapterRef = useRef<ChatTransportSlot['chatTransport']>(undefined);
  const adapterTransportRef = useRef<ChatTransportSlot['transport']>(undefined);
  const adaptersToCloseRef = useRef<NonNullable<ChatTransportSlot['chatTransport']>[]>([]);
  const pendingCloseRef = useRef(false);

  // Recreate the adapter when the transport it wraps changes (the generic
  // provider recreates the transport on a channelName change), queueing the
  // superseded adapter for the close effect below.
  if (transport !== adapterTransportRef.current) {
    adapterTransportRef.current = transport;
    if (adapterRef.current) {
      adaptersToCloseRef.current.push(adapterRef.current);
      adapterRef.current = undefined;
    }
    if (transport) {
      adapterRef.current = createChatTransport({
        transport,
        channelName,
        ...(api === undefined ? {} : { api }),
        ...(logger === undefined ? {} : { logger }),
      });
    }
  }
  const chatTransport = adapterRef.current;

  const slot = useMemo<ChatTransportSlot>(() => {
    if (!transport) return { transport: undefined, chatTransport: undefined, error };
    return { transport, chatTransport, error: undefined };
  }, [transport, chatTransport, error]);

  // Close adapters superseded by a transport change. The render path above
  // queues the stale adapter; this effect's cleanup — which runs on the next
  // transport change or on unmount — closes every queued one.
  useEffect(
    () => () => {
      for (const adapter of adaptersToCloseRef.current) adapter.close();
      adaptersToCloseRef.current = [];
    },
    [transport],
  );

  // Close the adapter when the component truly unmounts, mirroring the
  // generic provider's transport close: deferred a microtask so Strict
  // Mode's synchronous remount resets the flag and cancels it.
  useEffect(() => {
    pendingCloseRef.current = false;
    return () => {
      pendingCloseRef.current = true;
      void Promise.resolve().then(() => {
        if (pendingCloseRef.current) adapterRef.current?.close();
      });
    };
  }, []);

  const parentContext = useContext(ChatTransportContext);
  const contextValue = useMemo(
    () => ({ nearest: slot, providers: { ...parentContext.providers, [channelName]: slot } }),
    [channelName, parentContext, slot],
  );

  return <ChatTransportContext.Provider value={contextValue}>{children}</ChatTransportContext.Provider>;
};

/**
 * Provide a Vercel {@link ChatTransport} (and the {@link ClientTransport}
 * beneath it) to descendant components.
 *
 * ```tsx
 * <AblyProvider client={ably}>
 *   <ChatTransportProvider channelName="ai:demo">
 *     <Chat />
 *   </ChatTransportProvider>
 * </AblyProvider>
 *
 * // Inside Chat:
 * const { chatTransport } = useChatTransport();
 * const chat = useChat({ transport: chatTransport });
 * ```
 * @param props - Provider configuration; see {@link ChatTransportProviderProps}.
 * @param props.children - Descendant components that consume the pair.
 * @param props.api - The chat route URL.
 * @returns A React element wrapping children with both transport contexts.
 */
export const ChatTransportProvider = ({ children, api, ...providerProps }: ChatTransportProviderProps): ReactNode => {
  // `logger` rides ClientTransportOptions, so it reaches the generic provider
  // through the spread below; the adapter needs it handed over explicitly.
  const { logger } = providerProps;
  // The codec value is stable for the provider's lifetime so the generic
  // provider's channel options never churn.
  const codec = useMemo(() => createUIMessageCodec(), []);
  return (
    <ClientTransportProvider
      {...providerProps}
      codec={codec}
    >
      <ChatTransportBridge
        channelName={providerProps.channelName}
        api={api}
        logger={logger}
      >
        {children}
      </ChatTransportBridge>
    </ClientTransportProvider>
  );
};
