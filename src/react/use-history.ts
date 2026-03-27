/**
 * useHistory — history pagination handle for a ClientTransport.
 *
 * Returns a `HistoryHandle` with `load()`, `next()`, `hasNext`, and
 * `loading` — mirroring the transport's `history()` and
 * `PaginatedMessages` API.
 *
 * The transport's `history()` is branch-aware: `limit` means "keep loading
 * until N new messages appear on the selected branch." Messages on
 * unselected branches are loaded into the tree but not counted toward the
 * limit. The returned `items` contain only the newly visible messages.
 *
 * When `options` are provided, auto-loads the first page on mount
 * (SWR-style: options present = enabled). When omitted or null,
 * no auto-load — call `load()` manually.
 *
 * Usage:
 * ```tsx
 * // Auto-load on mount
 * const history = useHistory(transport, { limit: 30 });
 *
 * // Manual load (e.g. on button press)
 * const history = useHistory(transport);
 * // ...later: await history.load({ limit: 30 });
 *
 * // Scroll-back
 * if (history.hasNext) await history.next();
 * ```
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ClientTransport, LoadHistoryOptions, PaginatedMessages } from '../core/transport/client/types.js';

/** Handle for paginated history loading. */
export interface HistoryHandle {
  /** Are there older pages available? False until `load()` has been called. */
  hasNext: boolean;
  /** Is a page being fetched? */
  loading: boolean;
  /** Load the first page (or re-load with different options). Inserts into the conversation tree. */
  load: (options?: LoadHistoryOptions) => Promise<void>;
  /** Fetch the next (older) page. No-op if loading or no more pages. Inserts into the conversation tree. */
  next: () => Promise<void>;
}

/**
 * Paginated history handle for a client transport.
 * @param transport - The client transport to load history from, or null/undefined if not yet available.
 * @param options - When provided, auto-loads the first page on mount. Omit or pass null for manual loading.
 * @returns A {@link HistoryHandle} for loading and paginating through history.
 */
export const useHistory = <TEvent, TMessage>(
  transport: ClientTransport<TEvent, TMessage> | null | undefined,
  options?: LoadHistoryOptions | null,
): HistoryHandle => {
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);
  const pageRef = useRef<PaginatedMessages<TMessage> | null>(null);
  const transportRef = useRef(transport);
  transportRef.current = transport;

  const load = useCallback(async (loadOptions?: LoadHistoryOptions) => {
    if (!transportRef.current || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const page = await transportRef.current.history(loadOptions);
      pageRef.current = page;
      setHasNext(page.hasNext());
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, []);

  const next = useCallback(async () => {
    const page = pageRef.current;
    if (!page || !page.hasNext() || loadingRef.current || !transportRef.current) return;

    loadingRef.current = true;
    setLoading(true);
    try {
      const older = await page.next();
      if (older) {
        pageRef.current = older;
        setHasNext(older.hasNext());
      } else {
        setHasNext(false);
      }
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, []);

  // Auto-load first page on mount when options are provided (SWR-style).
  const autoLoad = options !== undefined && options !== null;
  const autoLoadedRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!autoLoad || autoLoadedRef.current || !transportRef.current) return;
    autoLoadedRef.current = true;
    void load(optionsRef.current ?? undefined);
  }, [autoLoad, load]);

  return { hasNext, loading, load, next };
};
