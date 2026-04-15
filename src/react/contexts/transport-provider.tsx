/**
 * TransportProvider: creates a ClientTransport and makes it available to
 * descendants via TransportContext.
 *
 * Wraps children with Ably's ChannelProvider so the underlying channel
 * lifecycle is managed in one place. An inner component calls useChannel
 * to get the stable channel reference and creates the transport once on
 * first render (via useRef).
 *
 * The transport is closed synchronously when the provider unmounts (via
 * useLayoutEffect) so that any in-progress operations are aborted before
 * the channel is detached by ChannelProvider.
 *
 * Multiple TransportProviders can be nested using distinct channelNames.
 * Each provider merges its transport into the parent record, so descendants
 * can access all registered transports via useClientTransport(channelName).
 */

import { ChannelProvider, useChannel } from 'ably/react';
import { type PropsWithChildren, type ReactNode, useContext, useEffect, useLayoutEffect, useMemo, useRef } from 'react';

import { createClientTransport } from '../../core/transport/client-transport.js';
import type { ClientTransport, ClientTransportOptions } from '../../core/transport/types.js';
import { NearestTransportContext, TransportContext } from '../contexts/transport-context.js';

/**
 * Props for {@link TransportProvider}.
 *
 * All {@link ClientTransportOptions} except `channel` (managed internally) plus `channelName`.
 */
export interface TransportProviderProps<TEvent, TMessage>
  extends Omit<ClientTransportOptions<TEvent, TMessage>, 'channel'>, PropsWithChildren {
  /** The Ably channel name to subscribe to. Also used as the context registry key. */
  channelName: string;
}

// Inner component: rendered inside ChannelProvider so useChannel resolves to
// the channel created by the outer wrapper.
const TransportProviderInner = <TEvent, TMessage>({
  channelName,
  children,
  ...transportOptions
}: TransportProviderProps<TEvent, TMessage>) => {
  const { channel } = useChannel({ channelName });
  const transportRef = useRef<ClientTransport<TEvent, TMessage> | undefined>(undefined);
  const transportChannelRef = useRef<string>(channelName);
  const transportsToDisposeRef = useRef<ClientTransport<unknown, unknown>[]>([]);

  if (!transportRef.current || transportChannelRef.current !== channelName) {
    transportChannelRef.current = channelName;
    if (transportRef.current) transportsToDisposeRef.current.push(transportRef.current);
    transportRef.current = createClientTransport({ ...transportOptions, channel });
  }

  const parentMap = useContext(TransportContext);

  const contextValue = useMemo(
    () => ({
      ...parentMap,
      // CAST: TransportContext stores transports with erased generics.
      // The generic types are fixed at the TransportProvider<TEvent, TMessage> boundary.
      [channelName]: transportRef.current as ClientTransport<unknown, unknown>,
    }),
    [channelName, parentMap],
  );

  useEffect(
    () => () => {
      for (const transport of transportsToDisposeRef.current) void transport.close();
    },
    [channelName],
  );

  // Synchronously clear the ref on unmount so stale consumers can't call the closed transport.
  useLayoutEffect(
    () => () => {
      void transportRef.current?.close();
      transportRef.current = undefined;
    },
    [],
  );

  return (
    <TransportContext.Provider value={contextValue}>
      <NearestTransportContext.Provider value={transportRef.current as ClientTransport<unknown, unknown>}>
        {children}
      </NearestTransportContext.Provider>
    </TransportContext.Provider>
  );
};

/**
 * Provide a {@link ClientTransport} to descendant components.
 *
 * Wraps children with Ably's `ChannelProvider` using `channelName`, creates a
 * transport from the resolved channel and the remaining options, and registers it
 * in `TransportContext` under `channelName`. Descendants call
 * {@link useClientTransport} with the same `channelName` to access the transport.
 *
 * ```tsx
 * <TransportProvider channelName="ai:demo" codec={UIMessageCodec}>
 *   <Chat />
 * </TransportProvider>
 *
 * // Inside Chat:
 * const transport = useClientTransport({ channelName: 'ai:demo' });
 * ```
 *
 * For multiple transports, nest providers with distinct channelNames:
 *
 * ```tsx
 * <TransportProvider channelName="ai:main" codec={UIMessageCodec}>
 *   <TransportProvider channelName="ai:aux" codec={UIMessageCodec}>
 *     <App />
 *   </TransportProvider>
 * </TransportProvider>
 *
 * // Inside App:
 * const main = useClientTransport({ channelName: 'ai:main' });
 * const aux  = useClientTransport({ channelName: 'ai:aux' });
 * ```
 * @param props - Provider configuration including `channelName`, `codec`, and all other {@link ClientTransportOptions}.
 * @returns A React element wrapping children with ChannelProvider and TransportContext.
 */
export const TransportProvider = <TEvent, TMessage>(props: TransportProviderProps<TEvent, TMessage>): ReactNode => (
  <ChannelProvider channelName={props.channelName}>
    <TransportProviderInner {...props} />
  </ChannelProvider>
);
