/**
 * TransportProvider: creates a {@link Transport} on the named channel and
 * makes it available to descendants through {@link TransportContext}.
 *
 * Reads the Ably Realtime client from the surrounding `<AblyProvider>`,
 * resolves the channel through ably-js (`client.channels.get`) with this
 * SDK's channel agent and mode set, and creates the transport on it. The
 * provider also wraps its children in ably-js's own `<ChannelProvider>` for
 * the same channel with the identical options, so descendants can use ably-js
 * channel hooks (`usePresence`, `useChannel`, …) without adding their own, and
 * without the hooks' `setOptions` triggering a reattach or reverting the mode
 * set.
 *
 * The transport is created inside an effect, not during render, and the
 * effect's own cleanup closes it. A render React throws away (a Suspense
 * retry, a discarded concurrent render, an offscreen tree) therefore creates
 * nothing and attaches no channel. Strict Mode's create/close/create cycle
 * needs no special handling either, because each setup is paired with its own
 * cleanup. Nothing attaches the channel until a hook subscribes or reads
 * history.
 *
 * The effect re-runs on the Ably client, the channel name, or the resolved
 * channel options (which track the codec and the requested modes), so a change
 * to any of them closes the old transport and builds a new one. Because
 * creation happens after the commit, `transport` is `undefined` for the first
 * render; every hook returns it optional, so a consumer guards on it.
 *
 * If `createTransport` throws, the error is stored in the {@link TransportSlot}
 * beside an undefined transport, so {@link import('../use-transport.js').useTransport}
 * can report it as `error` without crashing the component tree.
 */

import * as Ably from 'ably';
import { ChannelProvider, useAbly } from 'ably/react';
import { type PropsWithChildren, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { channelAgent } from '../../core/agent.js';
import { resolveChannelModes } from '../../core/channel-options.js';
import type { Transport, TransportOptions } from '../../core/transport/index.js';
import { createTransport } from '../../core/transport/index.js';
import { ErrorCode } from '../../errors.js';
import { errorCause, errorMessage } from '../../utils.js';
import type { TransportSlot } from './transport-context.js';
import { TransportContext } from './transport-context.js';

/**
 * Props for {@link TransportProvider}: every {@link TransportOptions} field
 * except `channel`, which the provider resolves from the surrounding
 * `<AblyProvider>`'s client by `channelName`.
 * @template E - The codec's event union.
 */
export interface TransportProviderProps<E> extends Omit<TransportOptions<E>, 'channel'>, PropsWithChildren {
  /** The name of the channel to create the transport on. */
  channelName: string;
  /**
   * Extra Ably channel modes to request, on top of the modes the transport
   * always needs (pass `OBJECT_MODES` to use Ably LiveObjects on the same
   * channel). Changing the set rebuilds the transport on the newly resolved
   * channel; an inline array whose contents do not change is free, because the
   * comparison is on contents rather than identity.
   */
  channelModes?: readonly Ably.ChannelMode[];
}

/**
 * Provide a {@link Transport} to descendant components.
 *
 * ```tsx
 * <AblyProvider client={ably}>
 *   <TransportProvider channelName="ai:demo" codec={vercel}>
 *     <Chat />
 *   </TransportProvider>
 * </AblyProvider>
 *
 * // Inside Chat:
 * const { transport, error } = useTransport<VercelEvent>();
 * ```
 *
 * For multiple transports, nest providers with distinct channel names and
 * read a specific one with `useTransport({ channelName })`.
 * @template E - The codec's event union.
 * @param props - Provider configuration; see {@link TransportProviderProps}.
 * @param props.children - Descendant components that consume the transport.
 * @param props.channelName - The name of the channel to create the transport on.
 * @param props.channelModes - Extra Ably channel modes to request.
 * @returns A React element wrapping children with the transport context.
 */
export const TransportProvider = <E,>({
  children,
  channelName,
  channelModes,
  ...transportOptions
}: TransportProviderProps<E>): ReactNode => {
  const client = useAbly();

  // Resolve the channel options once per codec/modes pair: the SDK's channel
  // agent (so ably-js's React hooks append their agent rather than overwriting
  // it) and the resolved mode set. The provider and the ChannelProvider use
  // the identical options object, so ably-js's order- and duplicate-sensitive
  // mode comparison never sees a difference and never reattaches.
  //
  // Keyed on what the options are built from, not on the identity of the
  // props carrying it: the codec contributes only its `adapterTag`, and the
  // modes only their contents. The transport is rebuilt whenever these options
  // change, so a caller writing `codec={createVercelCodec()}` or
  // `channelModes={[...]}` inline, a fresh value every render, would otherwise
  // close and reopen the channel on each one.
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

  const [slot, setSlot] = useState<TransportSlot>({ transport: undefined, error: undefined });

  // The transport's own options are a rest object with a fresh identity every
  // render, so they cannot be effect deps. Read them through a ref: the effect
  // below owns when a transport is built, and these are the values it builds
  // from at that moment.
  const optionsRef = useRef(transportOptions);
  optionsRef.current = transportOptions;

  // Create and close in one effect, so every transport that exists has a
  // cleanup paired with it. Keyed on everything the channel resolution depends
  // on; `channelOptions` is itself memoized on the codec and modes.
  useEffect(() => {
    const options = optionsRef.current;
    let transport: Transport<E>;
    try {
      const channel = client.channels.get(channelName, channelOptions);
      transport = createTransport({ ...options, channel });
    } catch (error) {
      // This is the only place a construction failure surfaces, so the
      // original has to survive: `client.channels.get()` throws a plain Error
      // on a closed client or a bad channel name, and "unknown error" leaves
      // the developer nothing to act on.
      options.logger
        ?.withContext({ component: 'TransportProvider' })
        .error('TransportProvider(); transport construction failed', { channelName, error: errorMessage(error) });
      // InvalidArgument, not InternalError: what reaches here is a bad
      // `channelName` or a closed client, which is the caller's own input and
      // lifecycle. The message carries the original's detail, so `errorCause`,
      // which only propagates a value that is already an ErrorInfo, is enough.
      setSlot({
        transport: undefined,
        error:
          error instanceof Ably.ErrorInfo
            ? error
            : new Ably.ErrorInfo(
                `unable to create transport; ${errorMessage(error)}`,
                ErrorCode.InvalidArgument,
                400,
                errorCause(error),
              ),
      });
      return;
    }

    // The context stores the transport with its event type erased; the hooks
    // re-apply the caller's type argument.
    setSlot({ transport, error: undefined });
    return () => {
      // `close()` never rejects: it aborts the pipes in flight and waits for
      // each to settle; a pipe's own rejection is its caller's to observe.
      void transport.close();
    };
  }, [client, channelName, channelOptions]);

  const parentContext = useContext(TransportContext);

  const contextValue = useMemo(
    () => ({ nearest: slot, providers: { ...parentContext.providers, [channelName]: slot } }),
    [channelName, parentContext, slot],
  );

  return (
    <TransportContext.Provider value={contextValue}>
      <ChannelProvider
        channelName={channelName}
        options={channelOptions}
      >
        {children}
      </ChannelProvider>
    </TransportContext.Provider>
  );
};
