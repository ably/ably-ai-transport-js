/**
 * useCreateView — create an independent view with the same API as useView.
 *
 * Calls {@link ClientSession.createView} to create an independent view over
 * the same conversation tree, then subscribes to it exactly like
 * {@link useView}. The view is closed automatically on unmount or when the
 * session reference changes.
 *
 * Pass `null` or omit `session` to defer creation (e.g. when a split pane is
 * collapsed). The returned handle has empty state until a session is provided.
 * When `session` is omitted entirely, defaults to the nearest
 * {@link ClientSessionProvider}'s session via context.
 * Pass `skip: true` to bypass all context reads and view creation entirely.
 */

import { useEffect, useState } from 'react';

import type { View } from '../core/transport/types.js';
import type { BaseSessionOption } from './internal/use-resolved-session.js';
import { useResolvedSession } from './internal/use-resolved-session.js';
import type { ViewHandle } from './use-view.js';
import { useView } from './use-view.js';

/** Options for {@link useCreateView}. */
export interface UseCreateViewOptions<TEvent, TMessage> extends BaseSessionOption<TEvent, TMessage> {
  /** When provided, auto-loads the first page on mount. Omit for manual load. */
  limit?: number;
  /** When `true`, skip view creation and return an empty handle immediately. */
  skip?: boolean;
}

/**
 * Create an independent {@link View} and subscribe to it.
 * Returns the same {@link ViewHandle} as {@link useView}, but backed by a
 * newly created view with its own branch selections and pagination state.
 * The view is closed on unmount or when the session changes.
 * When `session` is omitted, uses the nearest {@link ClientSessionProvider}'s session via context.
 * @param props - Options including optional `session`, `limit` for auto-load, and `skip`.
 * @param props.session - Session to create a view from; defaults to the nearest provider.
 * @param props.limit - Max older messages per page; when provided, auto-loads on mount.
 * @param props.skip - When `true`, skip view creation and return an empty handle.
 * @returns A {@link ViewHandle} with nodes, pagination, navigation, and write operations.
 */
export const useCreateView = <TEvent, TMessage>({
  session,
  limit,
  skip,
}: UseCreateViewOptions<TEvent, TMessage> = {}): ViewHandle<TEvent, TMessage> => {
  const resolved = useResolvedSession({ session, skip });

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
