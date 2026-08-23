/**
 * ClientSessionProvider: creates a ClientSession and makes it available to
 * descendants via ClientSessionContext.
 *
 * Reads the Ably Realtime client from the surrounding `<AblyProvider>` and
 * forwards it to `createClientSession` along with the supplied `channelName`.
 *
 * The session is created on first render (via useRef) and recreated when
 * `channelName` changes; the previous session is queued for disposal.
 * `connect()` is invoked from a `useEffect` so the session is
 * subscribed/attached before the first descendant operation. If
 * `createClientSession` throws,
 * the error is stored in the ClientSessionSlot (alongside an undefined
 * session) so that useClientSession can surface it as `sessionError`
 * without crashing the component tree.
 *
 * The session is closed when the provider truly unmounts. The close is
 * scheduled as a microtask so that React Strict Mode's synchronous
 * remount cycle (mount → fake-unmount → remount) can cancel it before it
 * fires, avoiding unnecessary session teardown in development.
 *
 * Multiple ClientSessionProviders can be nested using distinct channelNames.
 * Each provider merges its slot into the parent record so descendants
 * can access all registered sessions via useClientSession(channelName).
 *
 * The provider also wraps its children in ably-js's `<ChannelProvider>` for the
 * session's channel, so descendants can use ably-js channel hooks
 * (`usePresence`, `useChannel`, etc.) against it without adding their own. It
 * seeds the ChannelProvider's `options` with this SDK's channel agent so the
 * hooks' agent is appended rather than overwriting it (ably-js >= 2.22).
 */

import * as Ably from 'ably';
import { ChannelProvider, useAbly } from 'ably/react';
import { type PropsWithChildren, type ReactNode, useContext, useEffect, useMemo, useRef } from 'react';

import { channelAgent } from '../../core/agent.js';
import { resolveChannelModes } from '../../core/channel-options.js';
import { createClientSession } from '../../core/transport/client-session.js';
import type { CodecInputEvent, CodecOutputEvent } from '../../core/transport/session-codec.js';
import type { ClientSession, ClientSessionOptions } from '../../core/transport/types.js';
import { ErrorCode } from '../../errors.js';
import type { ClientSessionSlot } from './client-session-context.js';
import { ClientSessionContext } from './client-session-context.js';

/**
 * Props for {@link ClientSessionProvider}.
 *
 * All {@link ClientSessionOptions} except `client` (read from the surrounding
 * `<AblyProvider>`).
 */
export interface ClientSessionProviderProps<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
>
  extends Omit<ClientSessionOptions<TInput, TOutput, TProjection, TMessage>, 'client'>, PropsWithChildren {}

/**
 * Provide a {@link ClientSession} to descendant components.
 *
 * Reads the Ably Realtime client from the surrounding `<AblyProvider>`,
 * creates a session bound to `channelName`, calls `connect()` on mount,
 * and registers it in `ClientSessionContext` under `channelName`.
 * Descendants call {@link useClientSession} with the same `channelName` to
 * access the session.
 *
 * If `createClientSession` throws during construction, the error is surfaced
 * through `useClientSession` as `sessionError` — the component tree does not
 * crash and children are still rendered.
 *
 * ```tsx
 * <AblyProvider client={ably}>
 *   <ClientSessionProvider channelName="ai:demo" codec={createUIMessageCodec()}>
 *     <Chat />
 *   </ClientSessionProvider>
 * </AblyProvider>
 *
 * // Inside Chat:
 * const { session, sessionError } = useClientSession({ channelName: 'ai:demo' });
 * ```
 *
 * For multiple sessions, nest providers with distinct channelNames:
 *
 * ```tsx
 * <ClientSessionProvider channelName="ai:main" codec={createUIMessageCodec()}>
 *   <ClientSessionProvider channelName="ai:aux" codec={createUIMessageCodec()}>
 *     <App />
 *   </ClientSessionProvider>
 * </ClientSessionProvider>
 *
 * // Inside App:
 * const { session: main } = useClientSession({ channelName: 'ai:main' });
 * const { session: aux }  = useClientSession({ channelName: 'ai:aux' });
 * ```
 * `channelModes` must stay constant for the provider's lifetime: the session is
 * only recreated when `channelName` changes, and removing the modes after mount
 * silently reverts the channel's mode set without a reattach.
 * @param props - Provider configuration including `channelName`, `codec`, and all other {@link ClientSessionOptions} except `client`.
 * @param props.children - Descendant components that consume the session via {@link useClientSession}.
 * @returns A React element wrapping children with ClientSessionContext.
 */
export const ClientSessionProvider = <
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
>({
  children,
  ...sessionOptions
}: ClientSessionProviderProps<TInput, TOutput, TProjection, TMessage>): ReactNode => {
  const client = useAbly();
  const { channelName } = sessionOptions;

  // Seed the ChannelProvider with this SDK's channel agent so ably-js's React
  // hooks append their agent (`channelOptionsForReactHooks`) rather than
  // overwriting it. Memoised on the codec, which determines the agent string.
  //
  // Spec: AIT-CT23 — resolve the channel modes through the same helper the
  // session uses so the provider and the session request an identical,
  // identically-ordered mode set. ably-js compares modes order- and
  // duplicate-sensitively, so matching arrays mean the provider's setOptions
  // never triggers a reattach and never silently reverts the session's modes.
  const channelOptions = useMemo<Ably.ChannelOptions>(() => {
    const options: Ably.ChannelOptions = { params: { agent: channelAgent(sessionOptions.codec) } };
    const modes = resolveChannelModes(sessionOptions.channelModes);
    if (modes) options.modes = modes;
    return options;
  }, [sessionOptions.codec, sessionOptions.channelModes]);
  const sessionRef = useRef<ClientSession<TInput, TOutput, TProjection, TMessage> | undefined>(undefined);
  const sessionChannelRef = useRef<string>(channelName);
  const sessionsToDisposeRef = useRef<ClientSession<CodecInputEvent, CodecOutputEvent, unknown, unknown>[]>([]);
  const pendingCloseRef = useRef(false);
  const constructionErrorRef = useRef<Ably.ErrorInfo | undefined>(undefined);

  const alreadyCreatedOrFailed = !!sessionRef.current || !!constructionErrorRef.current;

  if (!alreadyCreatedOrFailed || sessionChannelRef.current !== channelName) {
    sessionChannelRef.current = channelName;
    if (sessionRef.current) sessionsToDisposeRef.current.push(sessionRef.current);
    try {
      sessionRef.current = createClientSession({ ...sessionOptions, client });
      constructionErrorRef.current = undefined;
    } catch (error) {
      sessionRef.current = undefined;
      constructionErrorRef.current =
        error instanceof Ably.ErrorInfo
          ? error
          : new Ably.ErrorInfo('Unknown error while creating client session', ErrorCode.BadRequest, 400);
    }
  }

  const parentContext = useContext(ClientSessionContext);

  // Capture ref values as locals so useMemo deps track changes correctly.
  // CAST: ClientSessionContext stores sessions with erased generics.
  // The generic types are fixed at the ClientSessionProvider<TInput, TOutput, TProjection, TMessage> boundary.
  const currentSession = sessionRef.current as
    | ClientSession<CodecInputEvent, CodecOutputEvent, unknown, unknown>
    | undefined;
  const currentError = constructionErrorRef.current;

  const slot = useMemo<ClientSessionSlot>(
    () => ({ session: currentSession, sessionError: currentError }),
    [currentSession, currentError],
  );

  const contextValue = useMemo(
    () => ({ nearest: slot, providers: { ...parentContext.providers, [channelName]: slot } }),
    [channelName, parentContext, slot],
  );

  // Dispose sessions superseded by a channelName change. When channelName
  // changes, the render path above pushes the now-stale session into
  // sessionsToDisposeRef and creates a replacement. This effect's cleanup —
  // which runs on the next channelName change or on unmount — closes every
  // queued session.
  useEffect(
    () => () => {
      for (const session of sessionsToDisposeRef.current) void session.close();
    },
    [channelName],
  );

  // Trigger connect() once the session is created. Re-runs when channelName
  // changes so the freshly-recreated session connects too. Any error is
  // stored on the session's emitter and surfaced via on('error');
  // useClientSession doesn't need to await this.
  useEffect(() => {
    void sessionRef.current?.connect();
  }, [channelName]);

  // Close the session when the component truly unmounts. The close is
  // scheduled as a microtask: in React Strict Mode (dev) the component
  // remounts synchronously before any microtask can drain, so the remount's
  // effect setup resets pendingCloseRef.current = false and cancels the
  // close. On a real unmount no remount follows, the microtask fires, and
  // the session is closed.
  useEffect(() => {
    pendingCloseRef.current = false;
    return () => {
      pendingCloseRef.current = true;
      void Promise.resolve().then(() => {
        if (pendingCloseRef.current) {
          void sessionRef.current?.close();
        }
      });
    };
  }, []);

  return (
    <ClientSessionContext.Provider value={contextValue}>
      <ChannelProvider
        channelName={channelName}
        options={channelOptions}
      >
        {children}
      </ChannelProvider>
    </ClientSessionContext.Provider>
  );
};
