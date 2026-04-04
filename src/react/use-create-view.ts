/**
 * useCreateView — create an independent view with the same API as useView.
 *
 * Calls {@link ClientTransport.createView} to create an independent view over
 * the same conversation tree, then subscribes to it exactly like
 * {@link useView}. The view is closed automatically on unmount or when the
 * transport reference changes.
 *
 * Pass `null` or `undefined` to defer creation (e.g. when a split pane is
 * collapsed). The returned handle has empty state until a transport is provided.
 */

import { useEffect, useState } from 'react';

import type { ClientTransport, View } from '../core/transport/types.js';
import type { UseViewOptions, ViewHandle } from './use-view.js';
import { useView } from './use-view.js';

/**
 * Create an independent {@link View} and subscribe to it.
 * Returns the same {@link ViewHandle} as {@link useView}, but backed by a
 * newly created view with its own branch selections and pagination state.
 * The view is closed on unmount or when the transport changes.
 * @param transport - The transport to create a view from, or null/undefined to skip.
 * @param options - When provided, auto-loads the first page on mount. Omit or pass null for manual load.
 * @returns A {@link ViewHandle} with nodes, pagination, navigation, and write operations.
 */
export const useCreateView = <TEvent, TMessage>(
  transport: ClientTransport<TEvent, TMessage> | null | undefined,
  options?: UseViewOptions | null,
): ViewHandle<TEvent, TMessage> => {
  const [view, setView] = useState<View<TEvent, TMessage> | undefined>();

  useEffect(() => {
    if (!transport) {
      setView(undefined);
      return;
    }
    const v = transport.createView();
    setView(v);
    return () => {
      v.close();
    };
  }, [transport]);

  return useView(view, options);
};
