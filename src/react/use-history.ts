/**
 * useHistory: walk the channel's history backwards from the attach point,
 * oldest first in the accumulated list.
 */

import type * as Ably from 'ably';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { Delivery } from '../core/codec/index.js';
import type { HistoryPage } from '../core/transport/index.js';
import { toErrorInfo } from './internal.js';
import { useTransportSlot } from './use-transport.js';

/** Options for {@link useHistory}. */
export interface UseHistoryOptions {
  /** How many messages to read per page. */
  limit: number;
  /** The channel name of the provider to read. Omit to use the nearest enclosing provider. */
  channelName?: string;
}

/**
 * What {@link useHistory} returns: the pages read so far and the means to read
 * the next older one.
 * @template E - The codec's event union.
 */
export interface HistoryHandle<E = unknown> {
  /** Every delivery read so far, oldest first; each `loadMore` prepends an older page. */
  items: Delivery<E>[];
  /** Whether an older page exists. True until a page reports the end. */
  hasNext: boolean;
  /** Whether a page is being read. */
  loading: boolean;
  /** The error the last read failed with, or `undefined`. */
  error: Ably.ErrorInfo | undefined;
  /** Read the next older page. Resolves once the page is in `items`; a call while one is loading, or after the end, does nothing. */
  loadMore: () => Promise<void>;
}

interface HistoryState<E> {
  items: Delivery<E>[];
  hasNext: boolean;
  loading: boolean;
  error: Ably.ErrorInfo | undefined;
}

const initial = <E>(): HistoryState<E> => ({ items: [], hasNext: true, loading: false, error: undefined });

/**
 * Read the channel's history through the transport's codec, one page per
 * call, backwards from the attach point. The walk opens and its first page is
 * read when the transport is available; `loadMore` reads the next older page
 * of the same walk. The list starts over when the provider recreates the
 * transport. Reading history attaches the channel.
 * @template E - The codec's event union.
 * @param options - The page size and the provider to read; see {@link UseHistoryOptions}.
 * @returns The pages so far and `loadMore`; see {@link HistoryHandle}.
 * @throws {Ably.ErrorInfo} `InvalidArgument` when no matching provider encloses the caller.
 */
export const useHistory = <E = unknown>(options: UseHistoryOptions): HistoryHandle<E> => {
  const { transport } = useTransportSlot(options.channelName);
  const { limit } = options;
  const [state, setState] = useState<HistoryState<E>>(initial);
  // The transport a page was requested from, so a page that lands after the
  // provider rebuilt the transport is not merged into the new list.
  const currentRef = useRef(transport);
  currentRef.current = transport;
  const loadingRef = useRef(false);
  /** The last page read of the current walk; `undefined` before the walk opens. */
  const pageRef = useRef<HistoryPage<unknown> | undefined>(undefined);

  const loadMore = useCallback(async (): Promise<void> => {
    if (transport === undefined || loadingRef.current) return;
    const last = pageRef.current;
    if (last !== undefined && !last.hasNext) return;
    loadingRef.current = true;
    setState((prev) => ({ ...prev, loading: true, error: undefined }));
    try {
      const page = last === undefined ? await transport.history({ limit }) : await last.next();
      if (currentRef.current !== transport) return;
      pageRef.current = page;
      setState((prev) => ({
        // CAST: the provider stores the transport with its event type erased;
        // the caller's type argument re-applies the codec's type here.
        items: [...(page.items as Delivery<E>[]), ...prev.items],
        hasNext: page.hasNext,
        loading: false,
        error: undefined,
      }));
    } catch (error) {
      if (currentRef.current !== transport) return;
      setState((prev) => ({ ...prev, loading: false, error: toErrorInfo(error, 'read history') }));
    } finally {
      loadingRef.current = false;
    }
  }, [transport, limit]);

  useEffect(() => {
    setState(initial());
    loadingRef.current = false;
    pageRef.current = undefined;
    if (transport === undefined) return;
    // The first page; its failure lands in `error` through loadMore.
    void loadMore();
  }, [transport, loadMore]);

  return { ...state, loadMore };
};
