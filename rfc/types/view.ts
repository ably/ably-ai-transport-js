import type { MessageNode } from './message-node.js';
import type { AgentRun, ClientRun, Run } from './run.js';
import type { Step } from './step.js';

/** Options for creating a view from a session. */
export interface CreateViewOptions {
  /**
   * Initial branch selection: a map of parent message ID to selected child
   * message ID. Omit for default selection (latest child at each branch).
   */
  initialSelection?: Record<string, string>;
}

/**
 * Optional behaviour for {@link ClientView.createRegenerate} and
 * {@link ClientView.createEdit}.
 */
export interface CreateForkOptions {
  /**
   * Whether the view should switch selection to the new branch as soon as
   * the fork is created. Defaults to `true` — the common UI pattern where
   * regenerating or editing a message should immediately display the new
   * branch. Pass `{ autoSelect: false }` to leave the current selection
   * untouched (e.g. when forking multiple branches for later navigation).
   */
  autoSelect?: boolean;
}

/**
 * Base read projection over a session's tree. A view holds a linear sequence
 * of messages — one selected sibling at each branch point, ordered from root
 * to leaf — and a state-oriented subscription for observing changes to that
 * sequence. Both ClientView and AgentView share this contract.
 */
export interface View<TMessage, TRun extends Run<TMessage> = Run<TMessage>> {
  /**
   * Messages visible in this view's projection — one selected sibling at each
   * branch point, ordered linearly. Includes all messages regardless of step
   * status; use message.step.status to filter in rendering or before passing
   * to a model.
   *
   * Each node's `run` is typed to the session's run variant, so per-message
   * controls (e.g. `node.run?.abort()`, `node.run?.sendMessages(...)`) are
   * directly callable from the rendered node.
   */
  readonly messages: readonly MessageNode<TMessage, TRun>[];

  /**
   * Subscribe to view state changes. The callback fires whenever the visible
   * output changes — messages added, updated, or removed from the projection.
   * Returns an unsubscribe function.
   *
   * This is the primary subscription for UI rendering (client) and for
   * reacting to ancestry fill-in and steering messages (agent). React hooks
   * build on this via useSyncExternalStore. The Tree uses on/off for granular
   * typed events; the View uses subscribe/unsubscribe for state-oriented
   * observation — different patterns because they serve different purposes.
   */
  subscribe(callback: () => void): () => void;

  /**
   * Release this view's subscriptions and resources. After close(), the view
   * no longer updates and should not be read. Session.close() closes all
   * views automatically.
   *
   * Idempotent — calling close() a second time is a no-op.
   */
  close(): void;
}

/**
 * Read projection scoped to the client's UI perspective. Branch selection is
 * mutable — the user drives it via select() and loadMore(). Factory for new
 * runs: createRun, createRegenerate, and createEdit all produce a ClientRun
 * positioned by the view's current branch state.
 *
 * The generic carries `TPart` as well as `TMessage` for symmetry with
 * {@link AgentView} and for forward compatibility with future part-typed
 * client-side operations.
 */
export interface ClientView<TPart, TMessage> extends View<TMessage, ClientRun<TPart, TMessage>> {
  /** Runs whose messages are visible in this view's projection. */
  readonly runs: readonly ClientRun<TPart, TMessage>[];

  /** Whether more history is available to load. */
  readonly hasMore: boolean;

  /** Load more history into the view. */
  loadMore(): Promise<void>;

  /**
   * Select a sibling at a branch point, switching which branch this view shows.
   *
   * @param messageId - The ID of a node in the tree to select.
   * @throws An `Ably.ErrorInfo` with code {@link ErrorCode.ViewNodeNotFound}
   *   when `messageId` does not identify any node in the tree.
   */
  select(messageId: string): void;

  // --- Run creation (branch-context-aware) ---

  /**
   * Create a new run, positioned at the current branch tip. The run is not
   * yet live — call run.start() to publish `x-ably-run-start` to the channel.
   */
  createRun(): ClientRun<TPart, TMessage>;

  /**
   * Create a new run that forks the tree at the given message (regenerate).
   * The original response is preserved alongside the new branch. By default
   * the view selects the new branch immediately; pass `{ autoSelect: false }`
   * to leave selection untouched. The run is not yet live — call run.start()
   * to publish `x-ably-run-start`.
   *
   * @param messageId - The message the regenerate should fork from.
   * @param options - Optional fork behaviour; see {@link CreateForkOptions}.
   */
  createRegenerate(messageId: string, options?: CreateForkOptions): ClientRun<TPart, TMessage>;

  /**
   * Create a new run that forks the tree at the given message (edit).
   * The conversation branches from the edit point. By default the view
   * selects the new branch immediately; pass `{ autoSelect: false }` to
   * leave selection untouched. The run is not yet live — call run.start()
   * to publish `x-ably-run-start`.
   *
   * @param messageId - The message the edit should fork from.
   * @param options - Optional fork behaviour; see {@link CreateForkOptions}.
   */
  createEdit(messageId: string, options?: CreateForkOptions): ClientRun<TPart, TMessage>;
}

/**
 * Read projection scoped to the run an agent invocation names. Branch
 * selection is pinned by the invocation's run ID — the view shows the
 * ancestry from root down to the run's parent, then every message published
 * within the run. This is the conversation the agent passes to the model.
 *
 * view.messages begins empty and fills in as the session materialises the
 * channel; it is complete once step.start() has resolved. Subscribe to
 * receive updates as the projection populates during hydration and as
 * steering messages arrive during execution.
 *
 * No mutable branch selection and no pagination — the invocation has
 * already determined the branch, and the agent needs the full ancestry
 * to pass to the model.
 */
export interface AgentView<TPart, TMessage> extends View<TMessage, AgentRun<TMessage>> {
  /**
   * The run this view is scoped to. The step created from this view
   * executes work against this run. Use view.run.end() / view.run.suspend()
   * to manage run lifecycle.
   */
  readonly run: AgentRun<TMessage>;

  /**
   * Create a step that executes this view's run. The step is not yet
   * active — call step.start() to wait for the invocation's preconditions
   * and publish `x-ably-step-start`. The gap between createStep and start is
   * the setup window for registering signal handlers (e.g. step.on('pause', ...)).
   *
   * Each call returns a fresh {@link Step}; multiple steps per view are
   * permitted (a single run can span multiple steps, each publishing its
   * own step-start/step-end pair). Precondition-wait is a view-level state,
   * so in practice only the first step in a view blocks on it — once the
   * view has materialised the invocation's preconditions, later steps see
   * an already-satisfied condition and `start()` proceeds immediately.
   */
  createStep(): Step<TPart, TMessage>;
}
