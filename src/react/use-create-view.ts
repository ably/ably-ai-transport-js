/**
 * useCreateView — create an independent view with the same API as useView.
 *
 * Calls {@link ClientTransport.createView} to create an independent view over
 * the same conversation tree, then subscribes to it exactly like
 * {@link useView}. The view is closed automatically on unmount or when the
 * transport reference changes.
 *
 * Pass `null` or omit `transport` to defer creation (e.g. when a split pane is
 * collapsed). The returned handle has empty state until a transport is provided.
 * When `transport` is omitted entirely, defaults to the nearest
 * {@link TransportProvider}'s transport via context.
 * Pass `skip: true` to bypass all context reads and view creation entirely.
 */

import { useEffect, useState } from 'react';

import type { ClientTransport, View } from '../core/transport/types.js';
import { useResolvedTransport } from './internal/use-resolved-transport.js';
import type { ViewHandle } from './use-view.js';
import { useView } from './use-view.js';

/**
 * Create an independent {@link View} and subscribe to it.
 * Returns the same {@link ViewHandle} as {@link useView}, but backed by a
 * newly created view with its own branch selections and pagination state.
 * The view is closed on unmount or when the transport changes.
 * When `transport` is omitted, uses the nearest {@link TransportProvider}'s transport via context.
 * @param props - Options including optional `transport`, `limit` for auto-load, and `skip`.
 * @param props.transport - Transport to create a view from; defaults to the nearest provider.
 * @param props.limit - Max older messages per page; when provided, auto-loads on mount.
 * @param props.skip - When `true`, skip view creation and return an empty handle.
 * @returns A {@link ViewHandle} with nodes, pagination, navigation, and write operations.
 */
export const useCreateView = <TEvent, TMessage>({
  transport,
  limit,
  skip,
}: {
  /** The transport to create a view from, or null/undefined to use the nearest provider. */
  transport?: ClientTransport<TEvent, TMessage> | null;
  /** When provided, auto-loads the first page on mount. Omit for manual load. */
  limit?: number;
  /** When `true`, skip view creation and return an empty handle immediately. */
  skip?: boolean;
} = {}): ViewHandle<TEvent, TMessage> => {
  const resolved = useResolvedTransport({ transport, skip });

  const [view, setView] = useState<View<TEvent, TMessage> | undefined>();

  useEffect(() => {
    if (!resolved) {
      setView(undefined);
      return;
    }
    const v = resolved.createView();
    setView(v);
    return () => {
      v.close();
    };
  }, [resolved]);

  return useView({ view, limit, skip });
};
