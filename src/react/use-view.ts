/**
 * useView — reactive paginated view of the conversation.
 *
 * Subscribes to view updates and exposes the visible messages, msg-anchored
 * branch navigation, write operations, pagination state, and a `loadOlder`
 * callback. Pass `session` to use a session's default view, or `view` to
 * subscribe to a specific {@link View} directly. When both are omitted,
 * defaults to the nearest {@link ClientSessionProvider}'s session via context.
 */

import * as Ably from 'ably';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { CodecInputEvent, CodecMessage, CodecOutputEvent } from '../core/codec/types.js';
import type { BranchHandle, ClientRun, ClientView, RunInfo, SendOptions } from '../core/transport/types.js';
import { ErrorCode } from '../errors.js';
import type { BaseSessionOption } from './internal/use-resolved-session.js';
import { useResolvedSession } from './internal/use-resolved-session.js';

/** Options for {@link useView}. */
export interface UseViewOptions<
  TInput extends CodecInputEvent,
  TOutput extends CodecOutputEvent,
  TProjection,
  TMessage,
> extends BaseSessionOption<TInput, TOutput, TProjection, TMessage> {
  /** A specific {@link ClientView} to subscribe to directly. Takes priority over `session`. */
  view?: ClientView<TInput, TMessage> | null;
  /** Number of older codecMessages to reveal per page (exactly `limit`, fewer only at the end of history). When provided, auto-loads the first page on mount. */
  limit?: number;
  /** When `true`, skip all subscriptions and return an empty handle immediately. */
  skip?: boolean;
}

/** Handle for the paginated, branch-aware conversation view. */
export interface ViewHandle<TInput extends CodecInputEvent, TMessage> {
  /**
   * The visible messages along the selected branch, concatenated across all
   * visible Runs, each paired with its codec-message-id (see
   * {@link CodecMessage}). Read the domain object from each entry's
   * `message` field.
   *
   * Correlate a rendered message back to the View — `runOf`,
   * `branchSelection`, `regenerate`, or `edit` — via its
   * `codecMessageId`, which the SDK assigns and tracks independently of any
   * identity the domain `message` may carry. See {@link View.getMessages}.
   */
  messages: CodecMessage<TMessage>[];
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
   * Load older messages into the view, resolving to the revealed page
   * (oldest-first — see {@link View.loadOlder}). Returns `[]` when nothing was
   * revealed: already loading, no view resolved, channel history exhausted, or
   * the load failed. On failure, `loadError` is set; on success, `loadError` is
   * cleared.
   */
  loadOlder: () => Promise<CodecMessage<TMessage>[]>;
  /**
   * Look up the {@link RunInfo} for the Run that owns `codecMessageId`.
   * Returns `undefined` when the codec-message-id hasn't been observed.
   * See {@link View.runOf}.
   */
  runOf: (codecMessageId: string) => RunInfo | undefined;
  /**
   * Direct lookup by runId. Returns `undefined` when the Run hasn't been
   * observed. See {@link View.run}.
   */
  run: (runId: string) => RunInfo | undefined;
  /**
   * Snapshot of the visible Runs along the selected branch, in
   * chronological order. Returns `[]` when the view isn't resolved.
   * See {@link View.runs}.
   */
  runs: () => RunInfo[];
  /**
   * Resolve the {@link BranchHandle} anchored at `codecMessageId`: the
   * sibling state plus a `select` verb to navigate it. Always returns a
   * safe handle — see {@link BranchHandle}. See {@link ClientView.branchSelection}.
   */
  branchSelection: (codecMessageId: string) => BranchHandle<TMessage>;
  /**
   * Send one input message on the channel and fire a POST. See {@link ClientView.send}.
   * @throws Ably.ErrorInfo with code {@link ErrorCode.InvalidArgument} when no view is resolved (before the session is available, or when `skip` is `true`).
   */
  send: (events: TInput | TInput[], options?: SendOptions) => Promise<ClientRun<TMessage>>;
  /**
   * Regenerate an assistant message, using this view's branch for history.
   * @throws Ably.ErrorInfo with code {@link ErrorCode.InvalidArgument} when no view is resolved (before the session is available, or when `skip` is `true`).
   */
  regenerate: (messageId: string, options?: SendOptions) => Promise<ClientRun<TMessage>>;
  /**
   * Edit a user message, forking from this view's branch.
   * Rejects with an `Ably.ErrorInfo` (code {@link ErrorCode.InvalidArgument}) if no view is resolved — e.g. before the session is available, or when `skip` is `true`.
   */
  edit: (messageId: string, inputs: TInput | TInput[], options?: SendOptions) => Promise<ClientRun<TMessage>>;
}

/**
 * Fallback returned by `branchSelection` when the view isn't resolved.
 * Same shape the view returns for an unknown codec-message-id, so callers
 * can destructure uniformly; `select` is a no-op (there is no view to
 * navigate).
 */
const EMPTY_BRANCH_HANDLE: BranchHandle<never> = {
  hasSiblings: false,
  siblings: [],
  index: 0,
  selected: undefined,
  select: () => {
    // no view resolved — nothing to select
  },
};

/**
 * Subscribe to a view and return the visible messages with pagination, navigation, and write operations.
 *
 * `view` takes priority over `session`. When neither is provided, the nearest
 * {@link ClientSessionProvider}'s session is used. When `limit` is provided, auto-loads
 * the first page on mount (SWR-style).
 * @param props - Options for selecting the view source and configuring auto-load.
 * @param props.session - Client session whose default view to subscribe to; defaults to the nearest provider.
 * @param props.view - A specific {@link View} to subscribe to directly. Takes priority over `session`.
 * @param props.limit - Number of older codecMessages to reveal per page (exactly `limit`, fewer only at end of history); when provided, auto-loads the first page on mount.
 * @param props.skip - When `true`, skip all subscriptions and return an empty handle.
 * @returns A {@link ViewHandle} with messages, pagination state, navigation, write operations, and loadOlder.
 */
export const useView = <TInput extends CodecInputEvent, TOutput extends CodecOutputEvent, TProjection, TMessage>({
  session,
  view,
  limit,
  skip,
}: UseViewOptions<TInput, TOutput, TProjection, TMessage> = {}): ViewHandle<TInput, TMessage> => {
  const resolvedSession = useResolvedSession({ session, skip });
  const resolvedView = skip ? undefined : (view ?? resolvedSession?.view);

  const [messages, setMessages] = useState<CodecMessage<TMessage>[]>(() => resolvedView?.getMessages() ?? []);
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
      setMessages([]);
      setHasOlder(false);
      setLoadError(undefined);
      return;
    }

    // Reset auto-load flag so the new view gets its first page loaded
    autoLoadedRef.current = false;

    // Sync initial state
    setMessages(resolvedView.getMessages());
    setHasOlder(resolvedView.hasOlder());
    setLoadError(undefined);

    const unsub = resolvedView.on('update', () => {
      setMessages(resolvedView.getMessages());
      setHasOlder(resolvedView.hasOlder());
    });
    return unsub;
  }, [resolvedView]);

  const loadOlder = useCallback(async (): Promise<CodecMessage<TMessage>[]> => {
    if (!resolvedView || loadingRef.current) return [];
    loadingRef.current = true;
    setLoading(true);
    try {
      const revealed = await resolvedView.loadOlder(limit);
      setLoadError(undefined);
      return revealed;
    } catch (error) {
      if (error instanceof Ably.ErrorInfo) {
        setLoadError(error);
      } else {
        setLoadError(new Ably.ErrorInfo('Unknown error loading older messages', ErrorCode.BadRequest, 400));
      }
      return [];
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

  // Run lookups
  const runOf = useCallback(
    (codecMessageId: string): RunInfo | undefined => resolvedView?.runOf(codecMessageId),
    [resolvedView],
  );

  const run = useCallback((runId: string): RunInfo | undefined => resolvedView?.run(runId), [resolvedView]);

  const runs = useCallback((): RunInfo[] => resolvedView?.runs() ?? [], [resolvedView]);

  // Branch navigation — the handle carries `select`, bound to the view.
  const branchSelection = useCallback(
    (codecMessageId: string): BranchHandle<TMessage> =>
      // CAST: `EMPTY_BRANCH_HANDLE` is typed `BranchHandle<never>`; `never` is
      // assignable to any `TMessage`, so the empty handle is a valid fallback for
      // the not-yet-resolved view case.
      resolvedView?.branchSelection(codecMessageId) ?? (EMPTY_BRANCH_HANDLE as BranchHandle<TMessage>),
    [resolvedView],
  );

  // Write operation callbacks
  const send = useCallback(
    async (events: TInput | TInput[], opts?: SendOptions) => {
      if (!resolvedView)
        throw new Ably.ErrorInfo('unable to send; view is not available', ErrorCode.InvalidArgument, 400);
      return resolvedView.send(events, opts);
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
    async (messageId: string, inputs: TInput | TInput[], opts?: SendOptions) => {
      if (!resolvedView)
        throw new Ably.ErrorInfo('unable to edit; view is not available', ErrorCode.InvalidArgument, 400);
      return resolvedView.edit(messageId, inputs, opts);
    },
    [resolvedView],
  );

  return {
    messages,
    hasOlder,
    loading,
    loadError,
    loadOlder,
    runOf,
    run,
    runs,
    branchSelection,
    send,
    regenerate,
    edit,
  };
};
