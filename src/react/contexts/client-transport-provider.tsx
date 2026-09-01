/**
 * ClientTransportProvider: creates a {@link ClientTransport} on the named
 * channel and makes it available to descendants via
 * {@link ClientTransportContext}.
 *
 * Reads the Ably Realtime client from the surrounding `<AblyProvider>`,
 * resolves the channel through ably-js (`client.channels.get`) with this
 * SDK's channel agent and mode set, creates the transport on it, and calls
 * `connect()` from an effect. The provider also wraps its children in
 * ably-js's own `<ChannelProvider>` for the same channel with the identical
 * options, so descendants can use ably-js channel hooks (`usePresence`,
 * `useChannel`, …) without adding their own — and without the hooks'
 * `setOptions` triggering a reattach or reverting the mode set.
 *
 * The transport is created on first render (via useRef) and recreated when
 * `channelName` changes; the previous transport is queued for closing. It is
 * closed when the provider truly unmounts; the close is scheduled as a
 * microtask so React Strict Mode's synchronous remount cycle (mount →
 * fake-unmount → remount) cancels it before it fires.
 *
 * If `createClientTransport` throws, the error is stored in the
 * {@link ClientTransportSlot} (alongside an undefined transport) so
 * {@link import('../use-client-transport.js').useClientTransport} can surface
 * it as `error` without crashing the component tree.
 */

import * as Ably from 'ably';
import { ChannelProvider, useAbly } from 'ably/react';
import { type PropsWithChildren, type ReactNode, useContext, useEffect, useMemo, useRef } from 'react';

import { channelAgent } from '../../core/agent.js';
import { resolveChannelModes } from '../../core/channel-options.js';
import type { ClientTransportOptions } from '../../core/transport/client-transport.js';
import { createClientTransport } from '../../core/transport/client-transport.js';
import type { ClientTransport } from '../../core/transport/types.js';
import { ErrorCode } from '../../errors.js';
import { errorMessage } from '../../utils.js';
import type { ClientTransportSlot } from './client-transport-context.js';
import { ClientTransportContext } from './client-transport-context.js';

/**
 * Props for {@link ClientTransportProvider}: every
 * {@link ClientTransportOptions} field except `channel`, which the provider
 * resolves from the surrounding `<AblyProvider>`'s client by `channelName`.
 * @template TInput - The codec's input-event domain type.
 * @template TOutput - The codec's output-event domain type.
 */
export interface ClientTransportProviderProps<TInput, TOutput>
  extends Omit<ClientTransportOptions<TInput, TOutput>, 'channel'>, PropsWithChildren {
  /** The name of the channel to create the transport on. */
  channelName: string;
  /**
   * Extra Ably channel modes to request, on top of the modes AI Transport
   * always needs (pass `OBJECT_MODES` to use Ably LiveObjects on the same
   * channel). Must stay constant for the provider's lifetime: the transport is
   * only recreated when `channelName` changes.
   */
  channelModes?: readonly Ably.ChannelMode[];
}

/**
 * Provide a {@link ClientTransport} to descendant components.
 *
 * ```tsx
 * <AblyProvider client={ably}>
 *   <ClientTransportProvider channelName="ai:demo" codec={createUIMessageCodec()}>
 *     <Chat />
 *   </ClientTransportProvider>
 * </AblyProvider>
 *
 * // Inside Chat:
 * const { transport, error } = useClientTransport();
 * ```
 *
 * For multiple transports, nest providers with distinct channel names and
 * read a specific one with `useClientTransport({ channelName })`.
 * @template TInput - The codec's input-event domain type.
 * @template TOutput - The codec's output-event domain type.
 * @param props - Provider configuration; see {@link ClientTransportProviderProps}.
 * @param props.children - Descendant components that consume the transport.
 * @param props.channelName - The name of the channel to create the transport on.
 * @param props.channelModes - Extra Ably channel modes to request.
 * @returns A React element wrapping children with the transport context.
 */
export const ClientTransportProvider = <TInput, TOutput>({
  children,
  channelName,
  channelModes,
  ...transportOptions
}: ClientTransportProviderProps<TInput, TOutput>): ReactNode => {
  const client = useAbly();

  // Resolve the channel options once per codec/modes pair: the SDK's channel
  // agent (so ably-js's React hooks append their agent rather than overwriting
  // it) and the resolved mode set. The provider and the ChannelProvider use
  // the identical options object, so ably-js's order- and duplicate-sensitive
  // mode comparison never sees a difference and never reattaches.
  const channelOptions = useMemo<Ably.ChannelOptions>(() => {
    const options: Ably.ChannelOptions = { params: { agent: channelAgent(transportOptions.codec) } };
    const modes = resolveChannelModes(channelModes);
    if (modes) options.modes = modes;
    return options;
  }, [transportOptions.codec, channelModes]);

  const transportRef = useRef<ClientTransport<TInput, TOutput> | undefined>(undefined);
  const transportChannelRef = useRef<string>(channelName);
  const transportsToCloseRef = useRef<ClientTransport<unknown, unknown>[]>([]);
  const pendingCloseRef = useRef(false);
  const constructionErrorRef = useRef<Ably.ErrorInfo | undefined>(undefined);

  const alreadyCreatedOrFailed = !!transportRef.current || !!constructionErrorRef.current;

  if (!alreadyCreatedOrFailed || transportChannelRef.current !== channelName) {
    transportChannelRef.current = channelName;
    if (transportRef.current) {
      // The disposal queue erases the event types; close() reads none of them.
      transportsToCloseRef.current.push(transportRef.current);
    }
    try {
      const channel = client.channels.get(channelName, channelOptions);
      transportRef.current = createClientTransport({ ...transportOptions, channel });
      constructionErrorRef.current = undefined;
    } catch (error) {
      transportRef.current = undefined;
      // This is the only place a construction failure surfaces, so the
      // original has to survive: `client.channels.get()` throws a plain Error
      // on a closed client or a bad channel name, and "unknown error" leaves
      // the developer nothing to act on. InternalError rather than BadRequest,
      // because a fault inside the SDK is not invalid caller input.
      transportOptions.logger?.error('ClientTransportProvider(); transport construction failed', {
        channelName,
        error,
      });
      // `errorCause` only propagates a value that is already an ErrorInfo, and
      // `client.channels.get()` throws a plain Error — so wrap it to give the
      // chain something to carry rather than passing an always-undefined cause.
      constructionErrorRef.current =
        error instanceof Ably.ErrorInfo
          ? error
          : new Ably.ErrorInfo(
              `unable to create client transport; ${errorMessage(error)}`,
              ErrorCode.InternalError,
              500,
              error instanceof Error ? new Ably.ErrorInfo(error.message, ErrorCode.InternalError, 500) : undefined,
            );
    }
  }

  const parentContext = useContext(ClientTransportContext);

  // Capture ref values as locals so useMemo deps track changes correctly.
  // CAST: the context stores transports with erased event types. The generic
  // types are re-applied at the useClientTransport boundary.
  const currentTransport = transportRef.current as ClientTransport<unknown, unknown> | undefined;
  const currentError = constructionErrorRef.current;

  const slot = useMemo<ClientTransportSlot>(
    () => ({ transport: currentTransport, error: currentError }),
    [currentTransport, currentError],
  );

  const contextValue = useMemo(
    () => ({ nearest: slot, providers: { ...parentContext.providers, [channelName]: slot } }),
    [channelName, parentContext, slot],
  );

  // Close transports superseded by a channelName change. The render path
  // above queues the now-stale transport; this effect's cleanup — which runs
  // on the next channelName change or on unmount — closes every queued one.
  useEffect(
    () => () => {
      for (const transport of transportsToCloseRef.current) transport.close();
      transportsToCloseRef.current = [];
    },
    [channelName],
  );

  // Trigger connect() once the transport is created. Re-runs when channelName
  // changes so the freshly-recreated transport connects too. A failure is
  // emitted on the transport's `error` stream; descendants observe it there.
  useEffect(() => {
    void transportRef.current?.connect().catch(() => {
      // The rejection is also emitted on the transport's error stream, which
      // is where consumers observe it; this catch only silences the
      // unhandled-rejection the double delivery would otherwise raise.
    });
  }, [channelName]);

  // Close the transport when the component truly unmounts. The close is
  // scheduled as a microtask: in React Strict Mode (dev) the component
  // remounts synchronously before any microtask can drain, so the remount's
  // effect setup resets pendingCloseRef.current = false and cancels the
  // close. On a real unmount no remount follows and the transport is closed.
  useEffect(() => {
    pendingCloseRef.current = false;
    return () => {
      pendingCloseRef.current = true;
      void Promise.resolve().then(() => {
        if (pendingCloseRef.current) {
          transportRef.current?.close();
        }
      });
    };
  }, []);

  return (
    <ClientTransportContext.Provider value={contextValue}>
      <ChannelProvider
        channelName={channelName}
        options={channelOptions}
      >
        {children}
      </ChannelProvider>
    </ClientTransportContext.Provider>
  );
};
