/**
 * ClientSessionProvider: creates a ClientSession and makes it available to
 * descendants via ClientSessionContext.
 *
 * Wraps children with Ably's ChannelProvider so the underlying channel
 * lifecycle is managed in one place. An inner component calls useChannel
 * to get the stable channel reference, creates the session once on first
 * render (via useRef), and calls `await session.connect()` from a
 * `useEffect` so the session is subscribed/attached before the first
 * descendant operation.
 *
 * If createClientSession throws, the error is stored in the
 * ClientSessionSlot (alongside an undefined session) so that
 * useClientSession can surface it as sessionError without crashing the
 * component tree.
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
import { ChannelProvider, useChannel } from 'ably/react';
import { type PropsWithChildren, type ReactNode, useContext, useEffect, useMemo, useRef } from 'react';

import { createClientSession } from '../../core/transport/client-session.js';
import type { ClientSession, ClientSessionOptions } from '../../core/transport/types.js';
import { ErrorCode } from '../../errors.js';
import type { ClientSessionSlot } from './client-session-context.js';
import { ClientSessionContext } from './client-session-context.js';

/**
 * Props for {@link ClientSessionProvider}.
 *
 * All {@link ClientSessionOptions} except `channel` (managed internally) plus `channelName`.
 */
export interface ClientSessionProviderProps<TEvent, TMessage>
  extends Omit<ClientSessionOptions<TEvent, TMessage>, 'channel'>, PropsWithChildren {
  /** The Ably channel name to subscribe to. Also used as the context registry key. */
  channelName: string;
}

// Inner component: rendered inside ChannelProvider so useChannel resolves to
// the channel created by the outer wrapper.
const ClientSessionProviderInner = <TEvent, TMessage>({
  channelName,
  children,
  ...sessionOptions
}: ClientSessionProviderProps<TEvent, TMessage>) => {
  const { channel } = useChannel({ channelName });
  const sessionRef = useRef<ClientSession<TEvent, TMessage> | undefined>(undefined);
  const sessionChannelRef = useRef<string>(channelName);
  const sessionsToDisposeRef = useRef<ClientSession<unknown, unknown>[]>([]);
  const pendingCloseRef = useRef(false);
  const constructionErrorRef = useRef<Ably.ErrorInfo | undefined>(undefined);

  const alreadyCreatedOrFailed = !!sessionRef.current || !!constructionErrorRef.current;

  if (!alreadyCreatedOrFailed || sessionChannelRef.current !== channelName) {
    sessionChannelRef.current = channelName;
    if (sessionRef.current) sessionsToDisposeRef.current.push(sessionRef.current);
    try {
      sessionRef.current = createClientSession({ ...sessionOptions, channel });
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
  // The generic types are fixed at the ClientSessionProvider<TEvent, TMessage> boundary.
  const currentSession = sessionRef.current as ClientSession<unknown, unknown> | undefined;
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

/**
 * Provide a {@link ClientSession} to descendant components.
 *
 * Wraps children with Ably's `ChannelProvider` using `channelName`, creates a
 * session from the resolved channel and the remaining options, calls
 * `connect()` on mount, and registers it in `ClientSessionContext` under
 * `channelName`. Descendants call {@link useClientSession} with the same
 * `channelName` to access the session.
 *
 * If `createClientSession` throws during construction, the error is surfaced
 * through `useClientSession` as `sessionError` — the component tree does not
 * crash and children are still rendered.
 *
 * ```tsx
 * <ClientSessionProvider channelName="ai:demo" codec={UIMessageCodec}>
 *   <Chat />
 * </ClientSessionProvider>
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
 * @param props - Provider configuration including `channelName`, `codec`, and all other {@link ClientSessionOptions}.
 * @returns A React element wrapping children with ChannelProvider and ClientSessionContext.
 */
export const ClientSessionProvider = <TEvent, TMessage>(
  props: ClientSessionProviderProps<TEvent, TMessage>,
): ReactNode => (
  <ChannelProvider channelName={props.channelName}>
    <ClientSessionProviderInner {...props} />
  </ChannelProvider>
);
