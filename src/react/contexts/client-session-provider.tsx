/**
 * ClientSessionProvider: creates a ClientSession and makes it available to
 * descendants via ClientSessionContext.
 *
 * Reads the Ably Realtime client from the surrounding `<AblyProvider>` and
 * forwards it to `createClientSession` along with the supplied `channelName`.
 *
 * The session is created once on first render (via useRef) and `connect()`
 * is invoked from a `useEffect` so the session is subscribed/attached
 * before the first descendant operation. If `createClientSession` throws,
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
 */

import * as Ably from 'ably';
import { useAbly } from 'ably/react';
import { type PropsWithChildren, type ReactNode, useContext, useEffect, useMemo, useRef } from 'react';

import { createClientSession } from '../../core/transport/client-session.js';
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
export interface ClientSessionProviderProps<TEvent, TProjection, TMessage>
  extends Omit<ClientSessionOptions<TEvent, TProjection, TMessage>, 'client'>, PropsWithChildren {}

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
 *   <ClientSessionProvider channelName="ai:demo" codec={UIMessageCodec}>
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
 * <ClientSessionProvider channelName="ai:main" codec={UIMessageCodec}>
 *   <ClientSessionProvider channelName="ai:aux" codec={UIMessageCodec}>
 *     <App />
 *   </ClientSessionProvider>
 * </ClientSessionProvider>
 *
 * // Inside App:
 * const { session: main } = useClientSession({ channelName: 'ai:main' });
 * const { session: aux }  = useClientSession({ channelName: 'ai:aux' });
 * ```
 * @param props - Provider configuration including `channelName`, `codec`, and all other {@link ClientSessionOptions} except `client`.
 * @param props.children - Descendant components that consume the session via {@link useClientSession}.
 * @returns A React element wrapping children with ClientSessionContext.
 */
export const ClientSessionProvider = <TEvent, TProjection, TMessage>({
  children,
  ...sessionOptions
}: ClientSessionProviderProps<TEvent, TProjection, TMessage>): ReactNode => {
  const client = useAbly();
  const { channelName } = sessionOptions;
  const sessionRef = useRef<ClientSession<TEvent, TProjection, TMessage> | undefined>(undefined);
  const sessionChannelRef = useRef<string>(channelName);
  const sessionsToDisposeRef = useRef<ClientSession<unknown, unknown, unknown>[]>([]);
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
  // The generic types are fixed at the ClientSessionProvider<TEvent, TProjection, TMessage> boundary.
  const currentSession = sessionRef.current as ClientSession<unknown, unknown, unknown> | undefined;
  const currentError = constructionErrorRef.current;

  const slot = useMemo<ClientSessionSlot>(
    () => ({ session: currentSession, sessionError: currentError }),
    [currentSession, currentError],
  );

  const contextValue = useMemo(
    () => ({ nearest: slot, providers: { ...parentContext.providers, [channelName]: slot } }),
    [channelName, parentContext, slot],
  );

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

  return <ClientSessionContext.Provider value={contextValue}>{children}</ClientSessionContext.Provider>;
};
