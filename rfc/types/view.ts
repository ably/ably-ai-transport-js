import type { AnyCodec, CodecMessage } from './codec.js';
import type { MessageNode } from './message-node.js';
import type { AgentRun, ClientRun, Run } from './run.js';

/** Options for creating a view from a session. */
export interface CreateViewOptions {
  /**
   * Initial branch selection: a map of parent message ID to selected child
   * message ID. Omit for default selection (latest child at each branch).
   */
  initialSelection?: Record<string, string>;
}

/**
 * Optional behaviour for {@link ClientView.regenerate} and
 * {@link ClientView.edit}.
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
 * Options accepted by {@link ClientView.createRun} — the escape-hatch
 * factory for callers that need split lifecycle control. The verb methods
 * (`view.send`, `view.regenerate`, `view.edit`) handle the common cases and
 * do not take these options.
 */
export interface CreateRunOptions {
  /**
   * Fork the tree at this message. Omit for a run at the current branch tip.
   */
  forkFrom?: string;
  /**
   * When `forkFrom` is set, whether the view should switch selection to
   * the new branch. Defaults to `true`. Ignored when `forkFrom` is omitted.
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
 * runs: the verb methods `send`, `regenerate`, and `edit` open a live
 * `ClientRun` atomically (single batch publish on the channel) for the
 * three common UI gestures. `createRun` is the escape-hatch factory for
 * callers that need split lifecycle control.
 *
 * Parameterised by the session's codec — `C extends Codec<TPart, TMessage,
 * TEvent>` — so callers name the variant with a single type argument.
 */
export interface ClientView<C extends AnyCodec> extends View<CodecMessage<C>, ClientRun<C>> {
  /** Runs whose messages are visible in this view's projection. */
  readonly runs: readonly ClientRun<C>[];

  /** Whether more history is available to load. */
  readonly hasMore: boolean;

  /** Load more history into the view. */
  loadMore(): Promise<void>;

  /**
   * Select a sibling at a branch point, switching which branch this view shows.
   * @param messageId - The ID of a node in the tree to select.
   * @throws An `Ably.ErrorInfo` with code {@link ErrorCode.ViewNodeNotFound}
   *   when `messageId` does not identify any node in the tree.
   */
  select(messageId: string): void;

  // --- Run creation (branch-context-aware) ---

  /**
   * Open a new run at the current branch tip and publish the user
   * message(s) on it. `x-ably-run-start` and the message(s) ship together
   * in a single Ably batch publish — the run either lands fully live with
   * its message, or not at all. POST `run.toInvocation()` to wake the
   * agent.
   * @param messages - The user message or messages to publish onto the
   *   newly opened run.
   * @returns The live `ClientRun`, with `status === 'active'`.
   */
  send(messages: CodecMessage<C> | CodecMessage<C>[]): Promise<ClientRun<C>>;

  /**
   * Open a new run that forks the tree at the given message (regenerate).
   * No user message is published — the agent picks up the conversation up
   * to the fork point's parent and produces a new response. The fork
   * point's siblings are preserved on the prior branch. By default the
   * view switches selection to the new branch; pass `{ autoSelect: false }`
   * to leave the current selection untouched.
   *
   * `x-ably-run-start` (with `x-ably-fork-of` set to `messageId`) is
   * published atomically; the returned run is live.
   * @param messageId - The message the regenerate should fork from.
   * @param options - Optional fork behaviour; see {@link CreateForkOptions}.
   * @returns The live `ClientRun` on the new branch.
   */
  regenerate(messageId: string, options?: CreateForkOptions): Promise<ClientRun<C>>;

  /**
   * Open a new run that forks the tree at the given message (edit) and
   * publish the replacement message(s). The conversation branches from
   * the edit point; the original is preserved on the prior branch. By
   * default the view switches selection to the new branch; pass
   * `{ autoSelect: false }` to leave the current selection untouched.
   *
   * `x-ably-run-start` (with `x-ably-fork-of` set to `messageId`) and the
   * replacement message(s) ship together in a single Ably batch publish.
   * @param messageId - The message the edit should fork from.
   * @param messages - The replacement message or messages.
   * @param options - Optional fork behaviour; see {@link CreateForkOptions}.
   * @returns The live `ClientRun` on the new branch.
   */
  edit(
    messageId: string,
    messages: CodecMessage<C> | CodecMessage<C>[],
    options?: CreateForkOptions,
  ): Promise<ClientRun<C>>;

  /**
   * Create a run handle without publishing anything. The run is **not yet
   * live**: callers drive `run.start()` and `run.sendMessages(...)`
   * themselves. Reach for this only when the verb methods (`send`,
   * `regenerate`, `edit`) don't fit — e.g. when batching custom publishes
   * across multiple calls, or when start needs to be deferred.
   *
   * 99% of callers should use the verb methods instead.
   * @param options - Optional positioning and fork behaviour; see
   *   {@link CreateRunOptions}. Omit the argument for a run at the current
   *   branch tip with default selection behaviour.
   */
  createRun(options?: CreateRunOptions): ClientRun<C>;
}

/**
 * Read projection scoped to the run an agent invocation names. Reached via
 * `run.view` on the {@link AgentRun} returned from
 * {@link AgentSession.createRun}. Branch selection is pinned by the
 * invocation's run ID — the view shows the ancestry from root down to the
 * run's parent, then every message published within the run. This is the
 * conversation the agent passes to the model.
 *
 * view.messages begins empty and fills in as the session materialises the
 * channel; it is complete once step.start() has resolved. Subscribe to
 * receive updates as the projection populates during hydration and as
 * steering messages arrive during execution.
 *
 * No mutable branch selection and no pagination — the invocation has
 * already determined the branch, and the agent needs the full ancestry
 * to pass to the model. Run lifecycle (`end`, `suspend`) and step creation
 * live on the parent {@link AgentRun}, not on the view — the view is a
 * pure read projection.
 */
export type AgentView<C extends AnyCodec> = View<CodecMessage<C>, AgentRun<C>>;
