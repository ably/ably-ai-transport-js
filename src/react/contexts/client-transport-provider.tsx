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
 * The transport is created inside an effect, not during render, and the
 * effect's own cleanup closes it. A render React throws away — a Suspense
 * retry, a discarded concurrent render, an offscreen tree — therefore creates
 * nothing and attaches no channel. Strict Mode's create/close/create cycle
 * needs no special handling either, because each setup is paired with its own
 * cleanup.
 *
 * The effect re-runs on the Ably client, the channel name, or the resolved
 * channel options (which track the codec and the requested modes), so a change
 * to any of them closes the old transport and builds a new one. Because
 * creation happens after the commit, `transport` is `undefined` for the first
 * render; both hooks already return it optional, so a consumer guards on it.
 *
 * If `createClientTransport` throws, the error is stored in the
 * {@link ClientTransportSlot} (alongside an undefined transport) so
 * {@link import('../use-client-transport.js').useClientTransport} can surface
 * it as `error` without crashing the component tree.
 */

import * as Ably from 'ably';
import { ChannelProvider, useAbly } from 'ably/react';
import { type PropsWithChildren, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { channelAgent } from '../../core/agent.js';
import { resolveChannelModes } from '../../core/channel-options.js';
import type { ClientTransportOptions } from '../../core/transport/client-transport.js';
import { createClientTransport } from '../../core/transport/client-transport.js';
import type { ClientTransport } from '../../core/transport/types.js';
import { ErrorCode } from '../../errors.js';
import { errorCause, errorMessage } from '../../utils.js';
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
   * channel). Changing the set rebuilds the transport on the newly resolved
   * channel; an inline array whose contents do not change is free, because the
   * comparison is on contents rather than identity.
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
  //
  // Keyed on what the options are actually built from, not on the identity of
  // the props carrying it: the codec contributes only its `adapterTag`, and the
  // modes only their contents. The transport is rebuilt whenever these options
  // change, so a caller writing `codec={createUIMessageCodec()}` or
  // `channelModes={[...]}` inline — a fresh value every render — would
  // otherwise close and reopen the channel on each one.
  const adapterTag = transportOptions.codec.adapterTag;
  const modesKey = channelModes === undefined ? '' : channelModes.join(',');
  const channelOptions = useMemo<Ably.ChannelOptions>(() => {
    const options: Ably.ChannelOptions = { params: { agent: channelAgent(transportOptions.codec) } };
    const modes = resolveChannelModes(channelModes);
    if (modes) options.modes = modes;
    return options;
    // `codec` and `channelModes` are read through the two keys above, which
    // track everything this memo reads off them.
  }, [adapterTag, modesKey]);

  const [slot, setSlot] = useState<ClientTransportSlot>({ transport: undefined, error: undefined });

  // The transport's own options are a rest object with a fresh identity every
  // render, so they cannot be effect deps. Read them through a ref: the effect
  // below owns when a transport is built, and these are the values it builds
  // from at that moment.
  const optionsRef = useRef(transportOptions);
  optionsRef.current = transportOptions;

  // Create, connect and close in one effect, so every transport that exists
  // has a cleanup paired with it. Keyed on everything the channel resolution
  // depends on; `channelOptions` is itself memoized on the codec and modes.
  useEffect(() => {
    const options = optionsRef.current;
    let transport: ClientTransport<TInput, TOutput>;
    try {
      const channel = client.channels.get(channelName, channelOptions);
      transport = createClientTransport({ ...options, channel });
    } catch (error) {
      // This is the only place a construction failure surfaces, so the
      // original has to survive: `client.channels.get()` throws a plain Error
      // on a closed client or a bad channel name, and "unknown error" leaves
      // the developer nothing to act on.
      options.logger
        ?.withContext({ component: 'ClientTransportProvider' })
        .error('ClientTransportProvider(); transport construction failed', { channelName, error: errorMessage(error) });
      // InvalidArgument, not InternalError: what reaches here is a bad
      // `channelName` or a closed client, which is the caller's own input and
      // lifecycle. InternalError promises the opposite, so stamping it would
      // send a developer hunting an SDK bug that is not there. The message
      // already carries the original's detail, so `errorCause` — which only
      // propagates a value that is already an ErrorInfo — is enough.
      setSlot({
        transport: undefined,
        error:
          error instanceof Ably.ErrorInfo
            ? error
            : new Ably.ErrorInfo(
                `unable to create client transport; ${errorMessage(error)}`,
                ErrorCode.InvalidArgument,
                400,
                errorCause(error),
              ),
      });
      return;
    }

    // The context stores transports with erased event types; the generic types
    // are re-applied at the useClientTransport boundary.
    setSlot({ transport, error: undefined });
    void transport.connect().catch(() => {
      // The rejection is also emitted on the transport's error stream, which
      // is where consumers observe it; this catch only silences the
      // unhandled-rejection the double delivery would otherwise raise.
    });
    return () => {
      transport.close();
    };
  }, [client, channelName, channelOptions]);

  const parentContext = useContext(ClientTransportContext);

  const contextValue = useMemo(
    () => ({ nearest: slot, providers: { ...parentContext.providers, [channelName]: slot } }),
    [channelName, parentContext, slot],
  );

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
