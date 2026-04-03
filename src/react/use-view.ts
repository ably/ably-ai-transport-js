/**
 * useView — reactive paginated view of the conversation.
 *
 * Subscribes to view updates and exposes the visible nodes, branch navigation,
 * write operations, pagination state, and a `loadOlder` callback. Accepts either
 * a {@link ClientTransport} (uses its default view) or a {@link View} directly.
 * When `options` are provided, auto-loads the first page on mount (SWR-style).
 */

import * as Ably from 'ably';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ActiveTurn, ClientTransport, SendOptions, TreeNode, View } from '../core/transport/types.js';
import { ErrorCode } from '../errors.js';

/** Options for configuring the view's initial load behavior. */
export interface ViewOptions {
  /** Maximum number of older messages to load per page. Defaults to 100. */
  limit?: number;
}

/** Handle for the paginated, branch-aware conversation view. */
export interface ViewHandle<TEvent, TMessage> {
  /** The visible domain messages along the selected branch. */
  messages: TMessage[];
  /** Visible conversation nodes along the selected branch. */
  nodes: TreeNode<TMessage>[];
  /** Whether there are older messages that can be revealed via `loadOlder`. */
  hasOlder: boolean;
  /** Whether a page load is currently in progress. */
  loading: boolean;
  /** Load older messages into the view. No-op if already loading. */
  loadOlder: () => Promise<void>;
  /** Select a sibling at a fork point by index. Triggers a view update with the new branch. */
  select: (msgId: string, index: number) => void;
  /** Index of the currently selected sibling at a fork point. */
  getSelectedIndex: (msgId: string) => number;
  /** Get all sibling messages at a fork point, ordered chronologically by serial. */
  getSiblings: (msgId: string) => TMessage[];
  /** Whether a message has sibling alternatives (i.e., show navigation arrows). */
  hasSiblings: (msgId: string) => boolean;
  /** Get a node by msgId, or undefined if not found. */
  getNode: (msgId: string) => TreeNode<TMessage> | undefined;
  /** Send one or more messages in the context of this view's selected branch. */
  send: (messages: TMessage | TMessage[], options?: SendOptions) => Promise<ActiveTurn<TEvent>>;
  /** Regenerate an assistant message, using this view's branch for history. */
  regenerate: (messageId: string, options?: SendOptions) => Promise<ActiveTurn<TEvent>>;
  /** Edit a user message, forking from this view's branch. */
  edit: (messageId: string, newMessages: TMessage | TMessage[], options?: SendOptions) => Promise<ActiveTurn<TEvent>>;
}

/**
 * Resolve a {@link View} from either a {@link ClientTransport} or a direct {@link View} reference.
 * @param source - The transport or view to resolve, or undefined if not yet available.
 * @returns The resolved View, or undefined if not available.
 */
const resolveView = <TEvent, TMessage>(
  source: ClientTransport<TEvent, TMessage> | View<TEvent, TMessage> | undefined,
): View<TEvent, TMessage> | undefined => {
  if (!source) return undefined;
  // Discriminate: ClientTransport has a `.view` property; View does not.
  if ('view' in source) return source.view;
  return source;
};

/**
 * Subscribe to a view and return the visible node list with pagination, navigation, and write operations.
 * @param source - A client transport (uses its default view), a View directly, or null/undefined.
 * @param options - When provided, auto-loads the first page on mount. Omit or pass null for manual loading.
 * @returns A {@link ViewHandle} with nodes, pagination state, navigation, write operations, and loadOlder.
 */
export const useView = <TEvent, TMessage>(
  source: ClientTransport<TEvent, TMessage> | View<TEvent, TMessage> | null | undefined,
  options?: ViewOptions | null,
): ViewHandle<TEvent, TMessage> => {
  const view = resolveView(source ?? undefined);

  const [nodes, setNodes] = useState<TreeNode<TMessage>[]>(() => view?.flattenNodes() ?? []);
  const [hasOlder, setHasOlder] = useState(() => view?.hasOlder() ?? false);
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);

  // Subscribe to view updates
  useEffect(() => {
    if (!view) return;

    // Sync initial state
    setNodes(view.flattenNodes());
    setHasOlder(view.hasOlder());

    const unsub = view.on('update', () => {
      setNodes(view.flattenNodes());
      setHasOlder(view.hasOlder());
    });
    return unsub;
  }, [view]);

  const loadOlder = useCallback(async () => {
    if (!view || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      await view.loadOlder(options?.limit);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [view, options?.limit]);

  // Auto-load first page on mount when options are provided (SWR-style).
  const autoLoad = options !== undefined && options !== null;
  const autoLoadedRef = useRef(false);

  useEffect(() => {
    if (!autoLoad || autoLoadedRef.current || !view) return;
    autoLoadedRef.current = true;
    void loadOlder();
  }, [autoLoad, view, loadOlder]);

  const messages = useMemo(() => nodes.map((n) => n.message), [nodes]);

  // Branch navigation callbacks
  const select = useCallback(
    (msgId: string, index: number) => {
      view?.select(msgId, index);
    },
    [view],
  );

  const getSelectedIndex = useCallback((msgId: string) => view?.getSelectedIndex(msgId) ?? 0, [view]);

  const getSiblings = useCallback((msgId: string) => view?.getSiblings(msgId) ?? [], [view]);

  const hasSiblings = useCallback((msgId: string) => view?.hasSiblings(msgId) ?? false, [view]);

  const getNode = useCallback((msgId: string) => view?.getNode(msgId), [view]);

  // Write operation callbacks
  const send = useCallback(
    async (msgs: TMessage | TMessage[], opts?: SendOptions) => {
      if (!view) throw new Ably.ErrorInfo('unable to send; view is not available', ErrorCode.InvalidArgument, 400);
      return view.send(msgs, opts);
    },
    [view],
  );

  const regenerate = useCallback(
    async (messageId: string, opts?: SendOptions) => {
      if (!view)
        throw new Ably.ErrorInfo('unable to regenerate; view is not available', ErrorCode.InvalidArgument, 400);
      return view.regenerate(messageId, opts);
    },
    [view],
  );

  const edit = useCallback(
    async (messageId: string, newMessages: TMessage | TMessage[], opts?: SendOptions) => {
      if (!view) throw new Ably.ErrorInfo('unable to edit; view is not available', ErrorCode.InvalidArgument, 400);
      return view.edit(messageId, newMessages, opts);
    },
    [view],
  );

  return {
    messages,
    nodes,
    hasOlder,
    loading,
    loadOlder,
    select,
    getSelectedIndex,
    getSiblings,
    hasSiblings,
    getNode,
    send,
    regenerate,
    edit,
  };
};
