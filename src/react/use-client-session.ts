/**
 * useClientSession — read a ClientSession from the nearest ClientSessionProvider.
 *
 * The session is created by {@link ClientSessionProvider}, which reads the Ably
 * Realtime client from the surrounding `<AblyProvider>`. This hook is a thin
 * context reader — it does not create or manage session state.
 *
 * **Provider lookup**
 * - Omit `channelName` to use the innermost `ClientSessionProvider` in the tree.
 * - Pass `channelName` to look up a specific provider by name.
 * - Pass `skip: true` to receive a stub session that throws on any access —
 *   safe to hold in state before auth or other conditions are ready.
 *
 * **Error handling**
 * - When no matching provider is found, or when the provider's `createClientSession`
 *   call threw, `sessionError` is set on the returned object instead of throwing.
 *   The component can render an error state without an error boundary.
 * - Pass `onError` to receive post-construction session errors (e.g. send failures,
 *   channel continuity loss) without wiring `session.on('error', ...)` manually.
 */

import * as Ably from 'ably';
import { useContext, useEffect, useRef } from 'react';

import type { ClientSession, Tree, View } from '../core/transport/types.js';
import { ErrorCode } from '../errors.js';
import { ClientSessionContext } from './contexts/client-session-context.js';

const SKIPPED_SESSION: ClientSession<unknown, unknown, unknown> = {
  get tree(): Tree<unknown> {
    throw new Ably.ErrorInfo('unable to access tree; hook is skipped', ErrorCode.InvalidArgument, 400);
  },
  get view(): View<unknown, unknown, unknown> {
    throw new Ably.ErrorInfo('unable to access view; hook is skipped', ErrorCode.InvalidArgument, 400);
  },
  connect: () => {
    throw new Ably.ErrorInfo('unable to connect; hook is skipped', ErrorCode.InvalidArgument, 400);
  },
  createView: (): View<unknown, unknown, unknown> => {
    throw new Ably.ErrorInfo('unable to create view; hook is skipped', ErrorCode.InvalidArgument, 400);
  },
  cancel: () => {
    throw new Ably.ErrorInfo('unable to cancel; hook is skipped', ErrorCode.InvalidArgument, 400);
  },
  on: () => {
    throw new Ably.ErrorInfo('unable to subscribe; hook is skipped', ErrorCode.InvalidArgument, 400);
  },
  close: () => {
    throw new Ably.ErrorInfo('unable to close; hook is skipped', ErrorCode.InvalidArgument, 400);
  },
};

/**
 * Return value of {@link useClientSession}.
 *
 * `session` is always a valid object. When `skip` is `true`, when no provider was
 * found, or when the provider's session construction failed, `session` is a stub
 * that throws {@link Ably.ErrorInfo} on every access.
 * Check `sessionError` before using `session` to avoid those throws.
 */
export interface ClientSessionHandle<TEvent, TProjection, TMessage> {
  /**
   * The resolved session.
   *
   * A throwing stub when `skip` is `true`, when no matching {@link ClientSessionProvider}
   * was found in the tree, or when session construction failed.
   */
  session: ClientSession<TEvent, TProjection, TMessage>;
  /**
   * Set when no matching {@link ClientSessionProvider} was found, when session
   * construction failed, and `skip` is `false`.
   * `undefined` when the session resolved successfully or when `skip` is `true`.
   */
  sessionError?: Ably.ErrorInfo | undefined;
}

/**
 * Read a {@link ClientSession} from the nearest {@link ClientSessionProvider}.
 *
 * Returns `{ session, sessionError }`. When no provider is found or session
 * construction failed, `sessionError` is set and `session` is a stub that throws
 * on access — the hook never throws during render.
 *
 * Pass `onError` to subscribe to post-construction session errors
 * (e.g. {@link ErrorCode.SessionSendFailed}, {@link ErrorCode.ChannelContinuityLost})
 * without calling `session.on('error', …)` manually. The subscription is
 * created when the session resolves and removed on unmount.
 * @param props - Hook options.
 * @param props.channelName - Look up a specific provider by channel name; omit for the nearest.
 * @param props.skip - When `true`, return the stub session immediately without reading context.
 * @param props.onError - Called whenever the resolved session emits an error event.
 * @returns `{ session, sessionError }`.
 */
export const useClientSession = <TEvent, TProjection, TMessage>({
  channelName,
  skip,
  onError,
}: {
  /**
   * Channel name passed to the enclosing {@link ClientSessionProvider}.
   * Omit to use the nearest provider in the tree.
   */
  channelName?: string;
  /**
   * When `true`, skip context lookup and return a stub session that throws on
   * any access. Use when a condition (auth, feature flag) is not yet resolved.
   */
  skip?: boolean;
  /**
   * Called whenever the resolved session emits an error event.
   * The subscription is established once the session resolves and
   * automatically removed on unmount or when the session changes.
   */
  onError?: (error: Ably.ErrorInfo) => void;
} = {}): ClientSessionHandle<TEvent, TProjection, TMessage> => {
  const { nearest: nearestSlot, providers } = useContext(ClientSessionContext);
  const errorCallbackRef = useRef(onError);
  errorCallbackRef.current = onError;

  // Compute the session for the onError subscription *before* any conditional
  // returns to satisfy React's rules of hooks (no hooks in branches).
  // Erased generics — this ref is only used in the useEffect below.
  const resolvedForEffect: ClientSession<unknown, unknown, unknown> | undefined = skip
    ? undefined
    : channelName === undefined
      ? nearestSlot?.session
      : providers[channelName]?.session;

  useEffect(() => {
    if (!resolvedForEffect) return;
    return resolvedForEffect.on('error', (errorInfo: Ably.ErrorInfo) => {
      errorCallbackRef.current?.(errorInfo);
    });
  }, [resolvedForEffect]);

  if (skip) {
    return {
      session: SKIPPED_SESSION as unknown as ClientSession<TEvent, TProjection, TMessage>,
    };
  }

  if (channelName !== undefined) {
    const slot = providers[channelName];
    if (slot) {
      if (slot.session) {
        // CAST: ClientSessionContext stores sessions with erased generics.
        // The caller is responsible for using type parameters matching those of the ClientSessionProvider.
        return {
          session: slot.session as unknown as ClientSession<TEvent, TProjection, TMessage>,
        };
      }
      // Provider exists but construction failed.
      return {
        session: SKIPPED_SESSION as unknown as ClientSession<TEvent, TProjection, TMessage>,
        sessionError: slot.sessionError,
      };
    }
    return {
      session: SKIPPED_SESSION as unknown as ClientSession<TEvent, TProjection, TMessage>,
      sessionError: new Ably.ErrorInfo(
        `unable to use session; no ClientSessionProvider found for channelName "${channelName}"`,
        ErrorCode.BadRequest,
        400,
      ),
    };
  }

  if (nearestSlot) {
    if (nearestSlot.session) {
      // CAST: ClientSessionContext stores session with erased generics; types fixed at call site.
      return {
        session: nearestSlot.session as unknown as ClientSession<TEvent, TProjection, TMessage>,
      };
    }
    // Nearest provider exists but construction failed.
    return {
      session: SKIPPED_SESSION as unknown as ClientSession<TEvent, TProjection, TMessage>,
      sessionError: nearestSlot.sessionError,
    };
  }

  return {
    session: SKIPPED_SESSION as unknown as ClientSession<TEvent, TProjection, TMessage>,
    sessionError: new Ably.ErrorInfo(
      'unable to use session; no ClientSessionProvider found in the tree',
      ErrorCode.BadRequest,
      400,
    ),
  };
};
