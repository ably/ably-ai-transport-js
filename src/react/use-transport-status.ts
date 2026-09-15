/**
 * useTransportStatus: the discontinuities and errors the transport reports.
 */

import type * as Ably from 'ably';
import { useEffect, useState } from 'react';

import { useTransportSlot } from './use-transport.js';

/** Options for {@link useTransportStatus}. */
export interface UseTransportStatusOptions {
  /** The channel name of the provider to read. Omit to use the nearest enclosing provider. */
  channelName?: string;
}

/** What {@link useTransportStatus} returns. */
export interface TransportStatusHandle {
  /** True once the transport has reported a discontinuity, a channel state change after which messages may have been missed. Cleared when the provider recreates the transport. */
  discontinuity: boolean;
  /** The most recent error the transport reported with no caller to reject, or `undefined`. */
  error: Ably.ErrorInfo | undefined;
}

const initial: TransportStatusHandle = { discontinuity: false, error: undefined };

/**
 * Observe the transport's discontinuity and error events. The hook holds no
 * subscription of its own, so it never keeps a handler on the channel. Whether
 * the channel is attached is the channel's own state, readable through
 * ably-js's `useChannelStateListener` under the provider's `ChannelProvider`.
 * An application recovering from a discontinuity reads history back to the
 * last serial it applied, through `useHistory` or `transport.history()`.
 * @param options - The provider to read; see {@link UseTransportStatusOptions}.
 * @returns The status; see {@link TransportStatusHandle}.
 * @throws {Ably.ErrorInfo} `InvalidArgument` when no matching provider encloses the caller.
 */
export const useTransportStatus = (options: UseTransportStatusOptions = {}): TransportStatusHandle => {
  const { transport } = useTransportSlot(options.channelName);
  const [state, setState] = useState<TransportStatusHandle>(initial);

  useEffect(() => {
    if (transport === undefined) return;
    setState(initial);
    const offDiscontinuity = transport.on('discontinuity', () => {
      setState((prev) => ({ ...prev, discontinuity: true }));
    });
    const offError = transport.on('error', (error) => {
      setState((prev) => ({ ...prev, error }));
    });
    return () => {
      offDiscontinuity();
      offError();
    };
  }, [transport]);

  return state;
};
