/**
 * useView — reactive paginated view of the conversation.
 *
 * Subscribes to view updates and exposes the visible nodes, branch navigation,
 * write operations, pagination state, and a `loadOlder` callback. Pass `session`
 * to use a session's default view, or `view` to subscribe to a specific
 * {@link View} directly. When both are omitted, defaults to the nearest
 * {@link ClientSessionProvider}'s session via context.
 */

import * as Ably from 'ably';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ActiveRun, MessageMetadata, RunNode, SendOptions, View } from '../core/transport/types.js';
import { ErrorCode } from '../errors.js';
import type { BaseSessionOption } from './internal/use-resolved-session.js';
import { useResolvedSession } from './internal/use-resolved-session.js';

/** Options for {@link useView}. */
export interface UseViewOptions<TEvent, TProjection, TMessage> extends BaseSessionOption<
  TEvent,
  TProjection,
  TMessage
> {
  /** A specific {@link View} to subscribe to directly. Takes priority over `session`. */
  view?: View<TEvent, TProjection, TMessage> | null;
  /** Maximum number of older messages to load per page. When provided, auto-loads on mount. */
  limit?: number;
  /** When `true`, skip all subscriptions and return an empty handle immediately. */
  skip?: boolean;
}

/** Handle for the paginated, branch-aware conversation view. */
export interface ViewHandle<TEvent, TProjection, TMessage> {
  /**
   * The visible domain messages along the selected branch, concatenated
   * across all visible Runs.
   */
  messages: TMessage[];
  /** Visible Run nodes along the selected branch. */
  nodes: RunNode<TProjection>[];
  /** Whether there are older messages that can be revealed via `loadOlder`. */
  hasOlder: boolean;
  /** Whether a page load is currently in progress. */
  loading: boolean;
  /**
   * Set when the most recent `loadOlder` call failed.
   * Cleared automatically on the next successful load.
   * `undefined` when no error has occurred or when `skip` is `true`.
   */
  loadError: Ably.ErrorInfo | undefined;
  /**
   * Load older messages into the view. No-op if already loading.
   * On failure, `error` is set; on success, `error` is cleared.
   */
  loadOlder: () => Promise<void>;
  /** Select a sibling Run at a fork point by index. Triggers a view update with the new branch. */
  select: (runId: string, index: number) => void;
  /** Index of the currently selected sibling Run at a fork point. */
  getSelectedIndex: (runId: string) => number;
  /**
   * Per-message metadata derived from the owning Run. The natural
   * per-message accessor for the rendering layer: returns primitives
   * without leaking {@link RunNode} or the codec's projection generic
   * into UI components. See {@link View.getMessageMetadata}.
   */
  getMessageMetadata: (msgId: string) => MessageMetadata | undefined;
  /**
   * Whether the message at `codecMessageId` is a branch-point anchor. Use this for
   * per-bubble UI decisions about rendering navigation arrows; see
   * {@link View.hasMessageSiblings}.
   */
  hasMessageSiblings: (codecMessageId: string) => boolean;
  /**
   * Resolved sibling messages at the branch point anchored at
   * `codecMessageId` — one TMessage per sibling. Use `.length` for the
   * sibling count. See {@link View.getMessageSiblings}.
   */
  getMessageSiblings: (codecMessageId: string) => TMessage[];
  /** Index of the currently selected sibling for the branch point anchored at `codecMessageId`. */
  getSelectedMessageSiblingIndex: (codecMessageId: string) => number;
  /** Select a sibling at the branch point anchored at `codecMessageId`. */
  selectMessageSibling: (codecMessageId: string, index: number) => void;
  /** Get a Run by runId, or undefined if not found. */
  getRunNode: (runId: string) => RunNode<TProjection> | undefined;
  /** Send one or more user messages on the channel and fire a POST. See {@link View.sendMessage}. */
  sendMessage: (messages: TMessage | TMessage[], options?: SendOptions) => Promise<ActiveRun<TEvent>>;
  /** Send one or more TEvents on the channel and fire a POST. See {@link View.sendEvent}. */
  sendEvent: (
    events: TEvent | TEvent[] | { event: TEvent; domainMessageId?: string }[],
    options?: SendOptions,
  ) => Promise<ActiveRun<TEvent>>;
  /** Regenerate an assistant message, using this view's branch for history. */
  regenerate: (messageId: string, options?: SendOptions) => Promise<ActiveRun<TEvent>>;
  /** Edit a user message, forking from this view's branch. */
  edit: (messageId: string, newEvents: TEvent | TEvent[], options?: SendOptions) => Promise<ActiveRun<TEvent>>;
}

/**
 * Subscribe to a view and return the visible node list with pagination, navigation, and write operations.
 *
 * `view` takes priority over `session`. When neither is provided, the nearest
 * {@link ClientSessionProvider}'s session is used. When `limit` is provided, auto-loads
 * the first page on mount (SWR-style).
 * @param props - Options for selecting the view source and configuring auto-load.
 * @param props.session - Client session whose default view to subscribe to; defaults to the nearest provider.
 * @param props.view - A specific {@link View} to subscribe to directly. Takes priority over `session`.
 * @param props.limit - Max older messages per page; when provided, auto-loads on mount.
 * @param props.skip - When `true`, skip all subscriptions and return an empty handle.
 * @returns A {@link ViewHandle} with nodes, pagination state, navigation, write operations, and loadOlder.
 */
export const useView = <TEvent, TProjection, TMessage>({
  session,
  view,
  limit,
  skip,
}: UseViewOptions<TEvent, TProjection, TMessage> = {}): ViewHandle<TEvent, TProjection, TMessage> => {
  const resolvedSession = useResolvedSession({ session, skip });
  const resolvedView = skip ? undefined : (view ?? resolvedSession?.view);

  const [nodes, setNodes] = useState<RunNode<TProjection>[]>(() => resolvedView?.flattenNodes() ?? []);
  const [messages, setMessages] = useState<TMessage[]>(() => resolvedView?.getMessages() ?? []);
  const [hasOlder, setHasOlder] = useState(() => resolvedView?.hasOlder() ?? false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<Ably.ErrorInfo | undefined>();
  const loadingRef = useRef(false);

  // Auto-load first page on mount when limit is provided (SWR-style).
  // Fires once per view instance — subsequent changes to limit
  // only affect manual loadOlder() calls, not the initial auto-load.
  const autoLoad = limit !== undefined;
  const autoLoadedRef = useRef(false);

  // Subscribe to view updates
  useEffect(() => {
    if (!resolvedView) {
      setNodes([]);
      setMessages([]);
      setHasOlder(false);
      setLoadError(undefined);
      return;
    }

    // Reset auto-load flag so the new view gets its first page loaded
    autoLoadedRef.current = false;

    // Sync initial state
    setNodes(resolvedView.flattenNodes());
    setMessages(resolvedView.getMessages());
    setHasOlder(resolvedView.hasOlder());
    setLoadError(undefined);

    const unsub = resolvedView.on('update', () => {
      setNodes(resolvedView.flattenNodes());
      setMessages(resolvedView.getMessages());
      setHasOlder(resolvedView.hasOlder());
    });
    return unsub;
  }, [resolvedView]);

  const loadOlder = useCallback(async () => {
    if (!resolvedView || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      await resolvedView.loadOlder(limit);
      setLoadError(undefined);
    } catch (error) {
      if (error instanceof Ably.ErrorInfo) {
        setLoadError(error);
      } else {
        setLoadError(new Ably.ErrorInfo('Unknown error loading older messages', ErrorCode.BadRequest, 400));
      }
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [resolvedView, limit]);

  useEffect(() => {
    if (!autoLoad || autoLoadedRef.current || !resolvedView) return;
    autoLoadedRef.current = true;
    void loadOlder();
  }, [autoLoad, resolvedView, loadOlder]);

  // Branch navigation callbacks
  const select = useCallback(
    (runId: string, index: number) => {
      resolvedView?.select(runId, index);
    },
    [resolvedView],
  );

  const getSelectedIndex = useCallback((runId: string) => resolvedView?.getSelectedIndex(runId) ?? 0, [resolvedView]);

  const getMessageMetadata = useCallback((msgId: string) => resolvedView?.getMessageMetadata(msgId), [resolvedView]);

  const hasMessageSiblings = useCallback(
    (codecMessageId: string) => resolvedView?.hasMessageSiblings(codecMessageId) ?? false,
    [resolvedView],
  );

  const getMessageSiblings = useCallback(
    (codecMessageId: string) => resolvedView?.getMessageSiblings(codecMessageId) ?? [],
    [resolvedView],
  );

  const getSelectedMessageSiblingIndex = useCallback(
    (codecMessageId: string) => resolvedView?.getSelectedMessageSiblingIndex(codecMessageId) ?? 0,
    [resolvedView],
  );

  const selectMessageSibling = useCallback(
    (codecMessageId: string, index: number) => {
      resolvedView?.selectMessageSibling(codecMessageId, index);
    },
    [resolvedView],
  );

  const getRunNode = useCallback((runId: string) => resolvedView?.getRunNode(runId), [resolvedView]);

  // Write operation callbacks
  const sendMessage = useCallback(
    async (msgs: TMessage | TMessage[], opts?: SendOptions) => {
      if (!resolvedView)
        throw new Ably.ErrorInfo('unable to send; view is not available', ErrorCode.InvalidArgument, 400);
      return resolvedView.sendMessage(msgs, opts);
    },
    [resolvedView],
  );

  const sendEvent = useCallback(
    async (events: TEvent | TEvent[] | { event: TEvent; domainMessageId?: string }[], opts?: SendOptions) => {
      if (!resolvedView)
        throw new Ably.ErrorInfo('unable to send; view is not available', ErrorCode.InvalidArgument, 400);
      return resolvedView.sendEvent(events, opts);
    },
    [resolvedView],
  );

  const regenerate = useCallback(
    async (messageId: string, opts?: SendOptions) => {
      if (!resolvedView)
        throw new Ably.ErrorInfo('unable to regenerate; view is not available', ErrorCode.InvalidArgument, 400);
      return resolvedView.regenerate(messageId, opts);
    },
    [resolvedView],
  );

  const edit = useCallback(
    async (messageId: string, newEvents: TEvent | TEvent[], opts?: SendOptions) => {
      if (!resolvedView)
        throw new Ably.ErrorInfo('unable to edit; view is not available', ErrorCode.InvalidArgument, 400);
      return resolvedView.edit(messageId, newEvents, opts);
    },
    [resolvedView],
  );

  return {
    messages,
    nodes,
    hasOlder,
    loading,
    loadError,
    loadOlder,
    select,
    getSelectedIndex,
    getMessageMetadata,
    hasMessageSiblings,
    getMessageSiblings,
    getSelectedMessageSiblingIndex,
    selectMessageSibling,
    getRunNode,
    sendMessage,
    sendEvent,
    regenerate,
    edit,
  };
};
