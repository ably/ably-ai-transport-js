/**
 * useView — reactive paginated view of the conversation.
 *
 * Subscribes to `transport.view.on('update')` and exposes the visible nodes,
 * pagination state, and a `loadOlder` callback. When `options` are provided,
 * auto-loads the first page on mount (SWR-style).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ClientTransport, TreeNode } from '../core/transport/types.js';

/** Options for configuring the view's initial load behavior. */
export interface ViewOptions {
  /** Maximum number of older messages to load per page. Defaults to 100. */
  limit?: number;
}

/** Handle for the paginated, branch-aware conversation view. */
export interface ViewHandle<TMessage> {
  /** Visible conversation nodes along the selected branch. */
  nodes: TreeNode<TMessage>[];
  /** Whether there are older messages that can be revealed via `loadOlder`. */
  hasOlder: boolean;
  /** Whether a page load is currently in progress. */
  loading: boolean;
  /** Load older messages into the view. No-op if already loading. */
  loadOlder: () => Promise<void>;
}

/**
 * Subscribe to the transport's view and return the visible node list with pagination.
 * @param transport - The client transport whose view to observe, or null/undefined if not yet available.
 * @param options - When provided, auto-loads the first page on mount. Omit or pass null for manual loading.
 * @returns A {@link ViewHandle} with nodes, pagination state, and loadOlder.
 */
export const useView = <TEvent, TMessage>(
  transport: ClientTransport<TEvent, TMessage> | null | undefined,
  options?: ViewOptions | null,
): ViewHandle<TMessage> => {
  const [nodes, setNodes] = useState<TreeNode<TMessage>[]>(() => transport?.view.flattenNodes() ?? []);
  const [hasOlder, setHasOlder] = useState(() => transport?.view.hasOlder() ?? false);
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);

  // Subscribe to view updates
  useEffect(() => {
    if (!transport) return;

    // Sync initial state
    setNodes(transport.view.flattenNodes());
    setHasOlder(transport.view.hasOlder());

    const unsub = transport.view.on('update', () => {
      setNodes(transport.view.flattenNodes());
      setHasOlder(transport.view.hasOlder());
    });
    return unsub;
  }, [transport]);

  const loadOlder = useCallback(async () => {
    if (!transport || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      await transport.view.loadOlder(options?.limit);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [transport, options?.limit]);

  // Auto-load first page on mount when options are provided (SWR-style).
  const autoLoad = options !== undefined && options !== null;
  const autoLoadedRef = useRef(false);

  useEffect(() => {
    if (!autoLoad || autoLoadedRef.current || !transport) return;
    autoLoadedRef.current = true;
    void loadOlder();
  }, [autoLoad, transport, loadOlder]);

  return { nodes, hasOlder, loading, loadOlder };
};
