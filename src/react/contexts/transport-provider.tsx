/**
 * TransportProvider: creates a ClientTransport and makes it available to
 * descendants via TransportContext.
 *
 * Wraps children with Ably's ChannelProvider so the underlying channel
 * lifecycle is managed in one place. An inner component calls useChannel
 * to get the stable channel reference and creates the transport once on
 * first render (via useRef).
 *
 * The transport is NOT closed when the provider unmounts. Channel lifecycle
 * is managed by ChannelProvider, which detaches the channel and clears all
 * subscriptions. Auto-closing would break React Strict Mode (double-mount
 * calls close() on the first cleanup, leaving a dead transport on the second
 * mount). Call transport.close() explicitly if you need to tear down the
 * transport independently of the channel lifecycle.
 *
 * Multiple TransportProviders can be nested using distinct channelNames.
 * Each provider merges its transport into the parent record, so descendants
 * can access all registered transports via useClientTransport(channelName).
 */

import { ChannelProvider, useChannel } from 'ably/react';
import { type PropsWithChildren, type ReactNode, useContext, useEffect, useMemo, useRef } from 'react';

import { createClientTransport } from '../../core/transport/client-transport.js';
import type { ClientTransport, ClientTransportOptions } from '../../core/transport/types.js';
import { TransportContext } from '../contexts/transport-context.js';

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
  const transportRef = useRef<ClientTransport<TEvent, TMessage> | null>(null);
  const transportChannelRef = useRef<string>(channelName);
  const transportsToDisposeRef = useRef<ClientTransport<unknown, unknown>[]>([]);

  if (transportRef.current === null || transportChannelRef.current !== channelName) {
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

  useEffect(
    () => () => {
      void transportRef.current?.close();
    },
    [],
  );

  return <TransportContext.Provider value={contextValue}>{children}</TransportContext.Provider>;
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
 * const transport = useClientTransport('ai:demo');
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
 * const main = useClientTransport('ai:main');
 * const aux  = useClientTransport('ai:aux');
 * ```
 * @param props - Provider configuration including `channelName`, `codec`, and all other {@link ClientTransportOptions}.
 * @returns A React element wrapping children with ChannelProvider and TransportContext.
 */
export const TransportProvider = <TEvent, TMessage>(props: TransportProviderProps<TEvent, TMessage>): ReactNode => (
  <ChannelProvider channelName={props.channelName}>
    <TransportProviderInner {...props} />
  </ChannelProvider>
);
