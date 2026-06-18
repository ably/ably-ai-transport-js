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

/** Fields common to every {@link RunInfo} arm. */
interface RunInfoBase {
  /** The Run's unique identifier. */
  runId: string;
  /**
   * Identity of the Ably client that started this Run. Empty string
   * when the wire didn't carry an owner client id.
   */
  clientId: string;
  /**
   * The agent-minted `invocationId` observed for this Run, adopted from the
   * wire `ai-run-start`. Stable across the Run's lifecycle once observed.
   * Empty string until run-start arrives (the agent mints it, so an
   * optimistic Run carries none) or when the wire didn't carry an
   * invocation-id.
   */
  invocationId: string;
}

/**
 * Projection-free, View-facing snapshot of a Run.
 *
 * Exposes the Run facts a UI consumer needs (`runId`, owner `clientId`,
 * lifecycle `status`, `invocationId`, and — only when it failed — the terminal
 * `error`) without leaking the codec's opaque per-Run projection or the Tree's
 * structural fields. Callers that need the full Run record (parent / fork
 * relationships, serials, projection) reach `session.tree.getRunNode(runId)`
 * directly.
 *
 * Discriminated on `status`: a Run with `status: 'error'` carries the terminal
 * `error`; every other status has no `error`. So `info.error` is defined
 * exactly when `info.status === 'error'`.
 */
export type RunInfo =
  | (RunInfoBase & {
      /**
       * Run lifecycle status. `'active'` while the Run is streaming;
       * `'suspended'` while it is paused awaiting input (still live, a
       * continuation re-activates it); otherwise the non-error terminal
       * {@link RunEndReason} (`'complete'` or `'cancelled'`). Literal lifecycle
       * vocabulary — UIs that want `'streaming'` rendering language translate
       * at the component boundary. The `'error'` terminal status lives on the
       * other arm of this union, where it is paired with the terminal `error`.
       */
      status: 'active' | 'suspended' | Exclude<RunEndReason, 'error'>;
      /** Never present for a non-error status. */
      error?: never;
    })
  | (RunInfoBase & {
      /** Terminal error status — the Run ended with {@link RunEndReason} `'error'`, carrying the terminal `error` below. */
      status: 'error';
      /**
       * The terminal error. Carries the agent-stamped `error-code` /
       * `error-message` detail (or a generic fallback when the run ended in
       * error without detail), so a UI can show *why* a run failed alongside
       * its `'error'` status. Mirrors the `Ably.ErrorInfo` delivered via
       * `ClientSession.on('error')`.
       */
      error: Ably.ErrorInfo;
    });

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
   * The visible messages along the selected branch, each paired with its
   * codec-message-id (see {@link CodecMessage}). Computed by walking the
   * visible Run chain (newest to root) and concatenating each Run's
   * `codec.getMessages(projection)` in chronological order.
   *
   * Correlate a message back to the transport — routing a continuation
   * input, resolving a regenerate/edit target, looking up the owning Run —
   * via its `codecMessageId`, which the SDK assigns and tracks
   * independently of any identity the domain `message` may carry. Read the
   * domain object from each entry's `message` field.
   */
  getMessages(): CodecMessage<TMessage>[];

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
   * Look up the {@link RunInfo} for the Run that owns `codecMessageId`.
   * For a user input node's codec-message-id, resolves to its
   * currently-selected reply run. Returns `undefined` when the
   * codec-message-id hasn't been observed by the view, or when it names
   * an input node that has no reply run yet.
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
   * Send one or more TInputs on the channel and fire a POST. Each TInput
   * carries its own routing metadata (`parent` / `target` / `codecMessageId`)
   * via the {@link CodecInputEvent} base; the SDK reads those fields
   * directly without runtime classification.
   *
   * To send a fresh user message, wrap the domain message with
   * {@link Codec.createUserMessage} and pass the result here, e.g.
   * `view.send(codec.createUserMessage(message))`.
   *
   * Convention: a send containing at least one `UserMessage` is a
   * fresh send (mints a new `runId`). A send containing only
   * tool-resolution inputs is a continuation — pair with
   * `options.runId` to extend a suspended run.
   *
   * The parent is auto-computed from this view's selected branch unless
   * overridden. The HTTP POST is fire-and-forget — the returned stream is
   * available immediately. If the POST fails, the error is surfaced via
   * the session's `on("error")` and the stream is errored.
   */
  send(events: TInput | TInput[], options?: SendOptions): Promise<ActiveRun>;

  /**
   * Regenerate an assistant message. Mints a codec `Regenerate` input
   * carrying `target` (the assistant codec-message-id being regenerated)
   * and `parent` (the preceding user prompt's codec-message-id), both
   * auto-computed from this view's branch — there are no new user inputs.
   * The new reply run is not a `forkOf` fork; it continues the
   * regenerated message's run, and the message-level replacement (the new
   * assistant superseding the original) happens at projection-extraction
   * time.
   */
  regenerate(messageId: string, options?: SendOptions): Promise<ActiveRun>;

  /**
   * Edit a user message. Creates a new run that forks the target message
   * with replacement content. Automatically computes `forkOf` (the edited
   * message) and `parent` from this view's branch.
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
