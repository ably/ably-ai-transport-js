/**
 * ChatTransportProvider: the Vercel entry point for `useChat`. Builds on the
 * generic {@link ClientTransportProvider} — which creates and connects a
 * {@link ClientTransport} pre-bound to the Vercel codec on the named channel —
 * and layers the {@link ChatTransport} useChat adapter over it.
 *
 * The adapter holds no conversation state, so it is created once per
 * transport (a channel-name change recreates both). A replaced adapter — a
 * new transport, or changed route options — is closed once its successor
 * commits, so it stops observing the transport; the final adapter needs no
 * unmount close, because the generic provider closes the transport it
 * subscribes to. Descendants read the pair with
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
   * to `/api/chat`. Changing it rebuilds the adapter and closes the one it
   * replaces, which terminates any stream `useChat` is reading — so change it
   * only when you mean to, never as a value recomputed per render.
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

  // Every adapter this bridge has created but not yet reconciled against a
  // commit. The adapter subscribes to the transport on construction, so one
  // created in a render that never commits (Strict Mode discards one of its
  // double renders' memo results) must still be closed.
  const createdAdaptersRef = useRef<ChatTransportSlot['chatTransport'][]>([]);

  // `logger` is an object, so an inline one would change identity every render
  // and rebuild the adapter each time — closing the previous one, which ends
  // the stream useChat is mid-read on. It is read through a ref instead, so
  // only the transport, the channel name and the route URL rebuild.
  const loggerRef = useRef(logger);
  loggerRef.current = logger;

  const slot = useMemo<ChatTransportSlot>(() => {
    if (!transport) return { transport: undefined, chatTransport: undefined, error };
    const chatTransport = createChatTransport({
      transport,
      channelName,
      ...(api === undefined ? {} : { api }),
      ...(loggerRef.current === undefined ? {} : { logger: loggerRef.current }),
    });
    createdAdaptersRef.current.push(chatTransport);
    return { transport, chatTransport, error: undefined };
  }, [transport, error, channelName, api]);

  // Close every adapter the committed one replaced or superseded: a prior
  // adapter (a new transport or a changed route URL) and any discarded
  // render's creation. Without this a replaced adapter would stay subscribed
  // to a live transport, holding its live buffer for the transport's lifetime.
  useEffect(() => {
    const survivors: ChatTransportSlot['chatTransport'][] = [];
    for (const adapter of createdAdaptersRef.current) {
      if (adapter === slot.chatTransport) survivors.push(adapter);
      else adapter?.close();
    }
    createdAdaptersRef.current = survivors;
  }, [slot]);

  // Close the surviving adapter when the component truly unmounts. Closing
  // the underlying ClientTransport does not cover it: `ChatTransport.close()`
  // also terminates the readers useChat holds, and a stream that never ends
  // leaves useChat stuck on `streaming`.
  //
  // The close is scheduled as a microtask, the same shape the generic
  // provider uses: Strict Mode remounts synchronously before any microtask
  // drains, so the remount's setup clears the flag and cancels the close.
  const pendingCloseRef = useRef(false);
  useEffect(() => {
    pendingCloseRef.current = false;
    return () => {
      pendingCloseRef.current = true;
      const adapter = slot.chatTransport;
      void Promise.resolve().then(() => {
        if (pendingCloseRef.current) adapter?.close();
      });
    };
  }, [slot]);

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
