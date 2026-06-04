/** View types: history pagination, branch selection, run info, and the windowed View contract. */

import type * as Ably from 'ably';

import type { CodecInputEvent, CodecMessage } from '../../codec/types.js';
import type { ActiveRun, SendOptions } from './client.js';
import type { RunEndReason } from './shared.js';
import type { RunLifecycleEvent } from './tree.js';

// ---------------------------------------------------------------------------
// History / pagination
// ---------------------------------------------------------------------------

/** A page of raw history wires from the channel. Internal to View/decodeHistory. */
export interface HistoryPage {
  /** Raw Ably messages that produced this page, in chronological order (oldest first). */
  rawMessages: Ably.InboundMessage[];
  /** Whether there are older pages available. */
  hasNext(): boolean;
  /** Fetch the next (older) page. Returns undefined if no more pages. */
  next(): Promise<HistoryPage | undefined>;
}

/** Options for loading channel history. */
export interface LoadHistoryOptions {
  /** Max messages per page. Default: 100. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// View — windowed projection over the tree
// ---------------------------------------------------------------------------

/**
 * Projection-free, View-facing snapshot of a Run.
 *
 * Exposes the Run facts a UI consumer needs (`runId`, owner `clientId`,
 * lifecycle `status`, `invocationId`) without leaking the codec's
 * opaque per-Run projection or the Tree's structural fields. Callers
 * that need the full Run record (parent / fork relationships, serials,
 * projection) reach `session.tree.getRunNode(runId)` directly.
 */
export interface RunInfo {
  /** The Run's unique identifier. */
  runId: string;
  /**
   * Identity of the Ably client that started this Run. Empty string
   * when the wire didn't carry an owner client id.
   */
  clientId: string;
  /**
   * Run lifecycle status. `'active'` while the Run is streaming;
   * `'suspended'` while it is paused awaiting input (still live, a
   * continuation re-activates it); otherwise the {@link RunEndReason} the Run
   * terminated with. Literal lifecycle vocabulary — UIs that want `'streaming'`
   * rendering language translate at the component boundary.
   */
  status: 'active' | 'suspended' | RunEndReason;
  /**
   * The agent-minted `invocationId` observed for this Run, adopted from the
   * wire `ai-run-start`. Stable across the Run's lifecycle once observed.
   * Empty string until run-start arrives (the client no longer mints it, so an
   * optimistic Run carries none) or when the wire didn't carry an
   * invocation-id.
   */
  invocationId: string;
}

/**
 * Bundle returned by {@link View.branchSelection} describing the
 * sibling group anchored at a given codec-message-id.
 *
 * Total / always-defined — `view.branchSelection(id)` is safe to call
 * for any message:
 *
 *  - **Branch anchor (N ≥ 2 siblings)**: `siblings` carries every
 *    sibling Run's view of the anchor slot, `index` is the selected
 *    sibling's position, `selected === siblings[index]`,
 *    `hasSiblings: true`.
 *  - **Known non-anchor message**: `siblings = [thisMessage]`,
 *    `index: 0`, `selected: thisMessage`, `hasSiblings: false`.
 *  - **Unknown codec-message-id**: `siblings: []`, `index: 0`,
 *    `selected: undefined`, `hasSiblings: false`.
 *
 * Because `siblings` always contains the currently rendered message
 * (for known ids), `siblings.length` is `1` for a plain bubble (not
 * `0`) and the indexing space matches between read and write —
 * passing `branch.index` back into {@link View.selectSibling} is a
 * round-trip no-op.
 */
export interface BranchSelection<TMessage> {
  /** True when the codec-message-id is a branch anchor with more than one sibling. Equivalent to `siblings.length > 1`. */
  hasSiblings: boolean;
  /**
   * The selected sibling and any alternatives, in tree-order (oldest
   * first). Always contains the currently rendered message itself for
   * known codec-message-ids; empty only when the id is unknown to the
   * view.
   */
  siblings: TMessage[];
  /** Index of the selected sibling within `siblings`. `0` when there is no real branching or the id is unknown. */
  index: number;
  /** Convenience reference to `siblings[index]`. `undefined` only when `siblings` is empty. */
  selected: TMessage | undefined;
}

/**
 * A paginated, branch-aware projection of the conversation tree.
 *
 * Returns only the visible portion of the selected branch. New live messages
 * appear immediately; older messages are revealed progressively via
 * `loadOlder()`. Events are scoped to the visible window — subscribers
 * are only notified when the visible output changes.
 */
export interface View<TInput extends CodecInputEvent, TMessage> {
  /**
   * The visible domain messages along the selected branch. Computed by
   * walking the visible Run chain (newest to root) and concatenating
   * each Run's `codec.getMessages(projection)` in chronological order.
   */
  getMessages(): TMessage[];

  /**
   * The same visible messages as {@link getMessages}, in the same order,
   * but each paired with its codec-message-id (see {@link CodecMessage}).
   * Use this when correlating a rendered message back to the transport —
   * e.g. routing a continuation input or resolving a regenerate/edit
   * target — so correlation keys on the SDK's codec-message-id rather than
   * the domain `message.id`, which the SDK never treats as an identity.
   */
  getMessagesWithIds(): CodecMessage<TMessage>[];

  /**
   * Snapshot of the visible Runs along the selected branch, in
   * chronological order — already filtered by this view's pagination
   * window, branch selection, and regenerate substitution. The
   * companion to {@link getMessages}: same scope, exposed as
   * projection-free {@link RunInfo} so consumers can iterate Run
   * identity (runId, clientId, status, invocationId) without touching
   * the Tree.
   */
  runs(): RunInfo[];

  /** Whether there are older Runs that can be loaded or revealed. */
  hasOlder(): boolean;

  /**
   * Reveal older Runs. Loads from channel history if the tree doesn't have
   * enough, then advances the pagination window by up to `limit` Runs.
   * Emits 'update' when the visible list changes.
   *
   * The pagination unit is the **Run**, not the message. A single Run
   * typically contributes more than one message to the flat list returned
   * by {@link View.getMessages} (e.g. a user prompt + assistant reply
   * pair). Revealing `limit` Runs may add 1..N messages each to the
   * visible window.
   * @param limit - Maximum number of older Runs to reveal. Defaults to 100.
   */
  loadOlder(limit?: number): Promise<void>;

  // --- Run lookup ---

  /**
   * Look up the {@link RunInfo} for the Run that owns
   * `codecMessageId`. Returns `undefined` when the codec-message-id
   * hasn't been observed by the view.
   * @param codecMessageId - The codec-message-id to look up.
   */
  runOf(codecMessageId: string): RunInfo | undefined;

  /**
   * Direct lookup by Run id. Kept for symmetry with {@link runOf} so
   * callers that hold a `runId` (e.g. cancel handlers) get a one-step
   * lookup. Returns `undefined` when the Run hasn't been observed.
   * @param runId - The Run id to look up.
   */
  run(runId: string): RunInfo | undefined;

  // --- Branch navigation ---

  /**
   * Resolve the {@link BranchSelection} bundle anchored at
   * `codecMessageId`. Always returns a safe object — see
   * {@link BranchSelection} for the per-case shape.
   *
   * Per AITRFC-014, branch points are message-anchored: edit forks
   * point at the user prompt's codec-message-id, regenerate forks
   * point at the assistant message's codec-message-id.
   * @param codecMessageId - The codec-message-id of the bubble being rendered.
   */
  branchSelection(codecMessageId: string): BranchSelection<TMessage>;

  /**
   * Select a sibling at the branch point anchored at
   * `codecMessageId`. `index` is clamped to
   * `[0, siblings.length - 1]`. Silent no-op when `codecMessageId`
   * is not a branch anchor. Emits 'update' when the visible output
   * changes.
   * @param codecMessageId - The codec-message-id of the bubble being rendered.
   * @param index - The index of the sibling to select.
   */
  selectSibling(codecMessageId: string, index: number): void;

  // --- Write operations ---

  /**
   * Send one or more user messages and start a new run. Each TMessage is
   * wrapped into a `UserMessage` TInput via `Codec.createUserMessage`
   * before being published, so callers can pass TMessage values directly
   * without manually constructing the input shape.
   *
   * The parent is auto-computed from this view's selected branch unless
   * overridden. The HTTP POST is fire-and-forget — the returned stream is
   * available immediately. If the POST fails, the error is surfaced via
   * the session's `on("error")` and the stream is errored.
   */
  sendMessage(messages: TMessage | TMessage[], options?: SendOptions): Promise<ActiveRun>;

  /**
   * Send one or more TInputs on the channel and fire a POST. Each TInput
   * carries its own routing metadata (`parent` / `target` / `codecMessageId`)
   * via the {@link CodecInputEvent} base; the SDK reads those fields
   * directly without runtime classification.
   *
   * Convention: a send containing at least one `UserMessage` is a
   * fresh send (mints a new `runId`). A send containing only
   * tool-resolution inputs is a continuation — pair with
   * `options.runId` to extend a suspended run.
   */
  sendInput(events: TInput | TInput[], options?: SendOptions): Promise<ActiveRun>;

  /**
   * Regenerate an assistant message. Creates a new run that forks the
   * target message with no new user inputs. Automatically computes
   * `target` (the assistant being regenerated), `parent`, and truncated
   * `history` from this view's branch.
   */
  regenerate(messageId: string, options?: SendOptions): Promise<ActiveRun>;

  /**
   * Edit a user message. Creates a new run that forks the target message
   * with replacement content. Automatically computes `forkOf`, `parent`,
   * and `history` from this view's branch.
   */
  edit(messageId: string, inputs: TInput | TInput[], options?: SendOptions): Promise<ActiveRun>;

  // --- Observation ---

  /** The visible message list changed (new visible node, branch switch, window shift). */
  on(event: 'update', handler: () => void): () => void;

  /** A raw Ably message arrived that corresponds to a visible node. */
  on(event: 'ably-message', handler: (msg: Ably.InboundMessage) => void): () => void;

  /** A run event occurred for a run with visible messages in the window. */
  on(event: 'run', handler: (event: RunLifecycleEvent) => void): () => void;

  /** Tear down the view — unsubscribe from tree events and clear internal state. */
  close(): void;
}
