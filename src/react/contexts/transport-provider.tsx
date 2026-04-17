/**
 * TransportProvider: creates a ClientTransport and makes it available to
 * descendants via TransportContext.
 *
 * Wraps children with Ably's ChannelProvider so the underlying channel
 * lifecycle is managed in one place. An inner component calls useChannel
 * to get the stable channel reference and creates the transport once on
 * first render (via useRef).
 *
 * If createClientTransport throws, the error is stored in the TransportSlot
 * (alongside an undefined transport) so that useClientTransport can surface it
 * as transportError without crashing the component tree.
 *
 * The transport is closed when the provider truly unmounts. The close is
 * scheduled as a microtask so that React Strict Mode's synchronous
 * remount cycle (mount → fake-unmount → remount) can cancel it before it
 * fires, avoiding unnecessary transport teardown in development.
 *
 * Multiple TransportProviders can be nested using distinct channelNames.
 * Each provider merges its slot into the parent record so descendants
 * can access all registered transports via useClientTransport(channelName).
 */

import * as Ably from 'ably';
import { ChannelProvider, useChannel } from 'ably/react';
import { type PropsWithChildren, type ReactNode, useContext, useEffect, useMemo, useRef } from 'react';

import { createClientTransport } from '../../core/transport/client-transport.js';
import type { ClientTransport, ClientTransportOptions } from '../../core/transport/types.js';
import { ErrorCode } from '../../errors.js';
import type { TransportSlot } from '../contexts/transport-context.js';
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
  const transportRef = useRef<ClientTransport<TEvent, TMessage> | undefined>(undefined);
  const transportChannelRef = useRef<string>(channelName);
  const transportsToDisposeRef = useRef<ClientTransport<unknown, unknown>[]>([]);
  const pendingCloseRef = useRef(false);
  const constructionErrorRef = useRef<Ably.ErrorInfo | undefined>(undefined);

  const alreadyCreatedOrFailed = !!transportRef.current || !!constructionErrorRef.current;

  if (!alreadyCreatedOrFailed || transportChannelRef.current !== channelName) {
    transportChannelRef.current = channelName;
    if (transportRef.current) transportsToDisposeRef.current.push(transportRef.current);
    try {
      transportRef.current = createClientTransport({ ...transportOptions, channel });
      constructionErrorRef.current = undefined;
    } catch (error) {
      transportRef.current = undefined;
      constructionErrorRef.current =
        error instanceof Ably.ErrorInfo
          ? error
          : new Ably.ErrorInfo('Unknown error while creating transport', ErrorCode.BadRequest, 400);
    }
  }

  const parentMap = useContext(TransportContext);

  // Capture ref values as locals so useMemo deps track changes correctly.
  // CAST: TransportContext stores transports with erased generics.
  // The generic types are fixed at the TransportProvider<TEvent, TMessage> boundary.
  const currentTransport = transportRef.current as ClientTransport<unknown, unknown> | undefined;
  const currentError = constructionErrorRef.current;

  const slot = useMemo<TransportSlot>(
    () => ({ transport: currentTransport, error: currentError }),
    [currentTransport, currentError],
  );

  const contextValue = useMemo(
    () => ({ nearest: slot, providers: { ...parentMap.providers, [channelName]: slot } }),
    [channelName, parentMap, slot],
  );

  useEffect(
    () => () => {
      for (const transport of transportsToDisposeRef.current) void transport.close();
    },
    [channelName],
  );

  // Close the transport when the component truly unmounts. The close is
  // scheduled as a microtask: in React Strict Mode (dev) the component
  // remounts synchronously before any microtask can drain, so the remount's
  // effect setup resets pendingCloseRef.current = false and cancels the
  // close. On a real unmount no remount follows, the microtask fires, and
  // the transport is closed.
  useEffect(() => {
    pendingCloseRef.current = false;
    return () => {
      pendingCloseRef.current = true;
      void Promise.resolve().then(() => {
        if (pendingCloseRef.current) {
          void transportRef.current?.close();
        }
      });
    };
  }, []);

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
 * If `createClientTransport` throws during construction, the error is surfaced
 * through `useClientTransport` as `transportError` — the component tree does not
 * crash and children are still rendered.
 *
 * ```tsx
 * <TransportProvider channelName="ai:demo" codec={UIMessageCodec}>
 *   <Chat />
 * </TransportProvider>
 *
 * // Inside Chat:
 * const { transport, transportError } = useClientTransport({ channelName: 'ai:demo' });
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
 * const { transport: main } = useClientTransport({ channelName: 'ai:main' });
 * const { transport: aux }  = useClientTransport({ channelName: 'ai:aux' });
 * ```
 * @param props - Provider configuration including `channelName`, `codec`, and all other {@link ClientTransportOptions}.
 * @returns A React element wrapping children with ChannelProvider and TransportContext.
 */
export const TransportProvider = <TEvent, TMessage>(props: TransportProviderProps<TEvent, TMessage>): ReactNode => (
  <ChannelProvider channelName={props.channelName}>
    <TransportProviderInner {...props} />
  </ChannelProvider>
);
