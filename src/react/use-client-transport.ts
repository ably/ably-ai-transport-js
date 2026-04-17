/**
 * useClientTransport — read a ClientTransport from the nearest TransportProvider.
 *
 * The transport is created by {@link TransportProvider}, which also wraps the subtree
 * with Ably's `ChannelProvider`. This hook is a thin context reader — it does not
 * create or manage transport state.
 *
 * **Provider lookup**
 * - Omit `channelName` to use the innermost `TransportProvider` in the tree.
 * - Pass `channelName` to look up a specific provider by name.
 * - Pass `skip: true` to receive a stub transport that throws on any access —
 *   safe to hold in state before auth or other conditions are ready.
 *
 * **Error handling**
 * - When no matching provider is found, or when the provider's `createClientTransport`
 *   call threw, `transportError` is set on the returned object instead of throwing.
 *   The component can render an error state without an error boundary.
 * - Pass `onError` to receive post-construction transport errors (e.g. send failures,
 *   channel continuity loss) without wiring `transport.on('error', ...)` manually.
 */

import * as Ably from 'ably';
import { useContext, useEffect, useRef } from 'react';

import type { ClientTransport, Tree, View } from '../core/transport/types.js';
import { ErrorCode } from '../errors.js';
import { TransportContext } from './contexts/transport-context.js';

const SKIPPED_TRANSPORT: ClientTransport<unknown, unknown> = {
  get tree(): Tree<unknown> {
    throw new Ably.ErrorInfo('unable to access tree; hook is skipped', ErrorCode.InvalidArgument, 400);
  },
  get view(): View<unknown, unknown> {
    throw new Ably.ErrorInfo('unable to access view; hook is skipped', ErrorCode.InvalidArgument, 400);
  },
  createView: (): View<unknown, unknown> => {
    throw new Ably.ErrorInfo('unable to create view; hook is skipped', ErrorCode.InvalidArgument, 400);
  },
  cancel: () => {
    throw new Ably.ErrorInfo('unable to cancel; hook is skipped', ErrorCode.InvalidArgument, 400);
  },
  stageEvents: () => {
    throw new Ably.ErrorInfo('unable to stage events; hook is skipped', ErrorCode.InvalidArgument, 400);
  },
  stageMessage: () => {
    throw new Ably.ErrorInfo('unable to stage message; hook is skipped', ErrorCode.InvalidArgument, 400);
  },
  waitForTurn: () => {
    throw new Ably.ErrorInfo('unable to wait for turn; hook is skipped', ErrorCode.InvalidArgument, 400);
  },
  on: () => {
    throw new Ably.ErrorInfo('unable to subscribe; hook is skipped', ErrorCode.InvalidArgument, 400);
  },
  close: () => {
    throw new Ably.ErrorInfo('unable to close; hook is skipped', ErrorCode.InvalidArgument, 400);
  },
};

/**
 * Return value of {@link useClientTransport}.
 *
 * `transport` is always a valid object. When `skip` is `true`, when no provider was
 * found, or when the provider's transport construction failed, `transport` is a stub
 * that throws {@link Ably.ErrorInfo} on every access.
 * Check `transportError` before using `transport` to avoid those throws.
 */
export interface ClientTransportHandle<TEvent, TMessage> {
  /**
   * The resolved transport.
   *
   * A throwing stub when `skip` is `true`, when no matching {@link TransportProvider}
   * was found in the tree, or when transport construction failed.
   */
  transport: ClientTransport<TEvent, TMessage>;
  /**
   * Set when no matching {@link TransportProvider} was found, when transport
   * construction failed, and `skip` is `false`.
   * `undefined` when the transport resolved successfully or when `skip` is `true`.
   */
  transportError?: Ably.ErrorInfo | undefined;
}

/**
 * Read a {@link ClientTransport} from the nearest {@link TransportProvider}.
 *
 * Returns `{ transport, transportError }`. When no provider is found or transport
 * construction failed, `transportError` is set and `transport` is a stub that throws
 * on access — the hook never throws during render.
 *
 * Pass `onError` to subscribe to post-construction transport errors
 * (e.g. {@link ErrorCode.TransportSendFailed}, {@link ErrorCode.ChannelContinuityLost})
 * without calling `transport.on('error', …)` manually. The subscription is
 * created when the transport resolves and removed on unmount.
 * @param props - Hook options.
 * @param props.channelName - Look up a specific provider by channel name; omit for the nearest.
 * @param props.skip - When `true`, return the stub transport immediately without reading context.
 * @param props.onError - Called whenever the resolved transport emits an error event.
 * @returns `{ transport, transportError }`.
 */
export const useClientTransport = <TEvent, TMessage>({
  channelName,
  skip,
  onError,
}: {
  /**
   * Channel name passed to the enclosing {@link TransportProvider}.
   * Omit to use the nearest provider in the tree.
   */
  channelName?: string;
  /**
   * When `true`, skip context lookup and return a stub transport that throws on
   * any access. Use when a condition (auth, feature flag) is not yet resolved.
   */
  skip?: boolean;
  /**
   * Called whenever the resolved transport emits an error event.
   * The subscription is established once the transport resolves and
   * automatically removed on unmount or when the transport changes.
   */
  onError?: (error: Ably.ErrorInfo) => void;
} = {}): ClientTransportHandle<TEvent, TMessage> => {
  const { nearest: nearestSlot, providers } = useContext(TransportContext);
  const errorCallbackRef = useRef(onError);
  errorCallbackRef.current = onError;

  // Compute the transport for the onError subscription *before* any conditional
  // returns to satisfy React's rules of hooks (no hooks in branches).
  // Erased generics — this ref is only used in the useEffect below.
  const resolvedForEffect: ClientTransport<unknown, unknown> | undefined = skip
    ? undefined
    : channelName === undefined
      ? nearestSlot?.transport
      : providers[channelName]?.transport;

  useEffect(() => {
    if (!resolvedForEffect) return;
    return resolvedForEffect.on('error', (errorInfo) => {
      errorCallbackRef.current?.(errorInfo);
    });
  }, [resolvedForEffect]);

  if (skip) {
    return {
      transport: SKIPPED_TRANSPORT as unknown as ClientTransport<TEvent, TMessage>,
    };
  }

  if (channelName !== undefined) {
    const slot = providers[channelName];
    if (slot) {
      if (slot.transport) {
        // CAST: TransportContext stores transports with erased generics.
        // The caller is responsible for using type parameters matching those of the TransportProvider.
        return {
          transport: slot.transport as unknown as ClientTransport<TEvent, TMessage>,
        };
      }
      // Provider exists but construction failed.
      return {
        transport: SKIPPED_TRANSPORT as unknown as ClientTransport<TEvent, TMessage>,
        transportError: slot.error,
      };
    }
    return {
      transport: SKIPPED_TRANSPORT as unknown as ClientTransport<TEvent, TMessage>,
      transportError: new Ably.ErrorInfo(
        `unable to use transport; no TransportProvider found for channelName "${channelName}"`,
        ErrorCode.BadRequest,
        400,
      ),
    };
  }

  if (nearestSlot) {
    if (nearestSlot.transport) {
      // CAST: NearestTransportContext stores transport with erased generics; types fixed at call site.
      return {
        transport: nearestSlot.transport as unknown as ClientTransport<TEvent, TMessage>,
      };
    }
    // Nearest provider exists but construction failed.
    return {
      transport: SKIPPED_TRANSPORT as unknown as ClientTransport<TEvent, TMessage>,
      transportError: nearestSlot.error,
    };
  }

  return {
    transport: SKIPPED_TRANSPORT as unknown as ClientTransport<TEvent, TMessage>,
    transportError: new Ably.ErrorInfo(
      'unable to use transport; no TransportProvider found in the tree',
      ErrorCode.BadRequest,
      400,
    ),
  };
};
