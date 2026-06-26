/** View types: history pagination, branch selection, run info, and the windowed View contract. */

import type * as Ably from 'ably';

import type { CodecInputEvent, CodecMessage } from '../../codec/types.js';
import type { ClientRun, SendOptions } from './client.js';
import type { RunEndReason } from './shared.js';
import type { RunLifecycleEvent } from './tree.js';

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
 * Handle returned by {@link ClientView.branchSelection} for the sibling group
 * anchored at a given codec-message-id: the resolved sibling state plus the
 * `select` verb that navigates it.
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
 * passing `branch.index` back into {@link BranchHandle.select} is a
 * round-trip no-op.
 */
export interface BranchHandle<TMessage> {
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
  /**
   * Select a sibling at this branch point. `index` is clamped to
   * `[0, siblings.length - 1]`. Silent no-op when the anchoring
   * codec-message-id is not a branch anchor. Emits 'update' when the
   * visible output changes.
   * @param index - The index of the sibling to select.
   */
  select(index: number): void;
}

/**
 * A read-only, paginated, branch-aware projection of the conversation tree.
 *
 * Returns only the visible portion of one branch, ending at a leaf. New live
 * messages appear immediately; older messages are revealed progressively via
 * `loadOlder()`. Events are scoped to the visible window — subscribers are only
 * notified when the visible output changes.
 *
 * This is the read base the client surfaces as `session.view`, extended with
 * navigation and the write path by {@link ClientView}. It is also the shared
 * read contract the agent's leaf-pinned `run.view` will expose, so both sides
 * read the conversation through one surface — differing only in the branch the
 * projection walks.
 */
export interface View<TMessage> {
  /**
   * The visible messages along the branch, each paired with its
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
   * Snapshot of the visible Runs along the branch, in chronological order —
   * already filtered by this view's pagination window, branch selection, and
   * regenerate substitution. The companion to {@link getMessages}: same scope,
   * exposed as projection-free {@link RunInfo} so consumers can iterate Run
   * identity (runId, clientId, status, invocationId) without touching the Tree.
   */
  runs(): RunInfo[];

  /** Whether there are older messages that can be loaded or revealed. */
  hasOlder(): boolean;

  /**
   * Reveal exactly `limit` older codecMessages — fewer only when channel history
   * is exhausted. Loads from channel history when the tree doesn't already hold
   * `limit` hidden messages, then advances the pagination window. Emits 'update'
   * when the visible list changes.
   *
   * The pagination unit is the **codecMessage**. A node (a user prompt, or a
   * reply Run) contributes 1..N messages to the flat list returned by
   * {@link View.getMessages}; the window counts those messages, so a node
   * straddling the boundary is **partially revealed** — only its newest messages
   * enter the window — and the page lands exactly on `limit` rather than on a
   * node boundary. Such a partially-revealed run still appears in
   * {@link View.runs} and is event-scoped.
   * @param limit - Number of older codecMessages to reveal. Defaults to 10.
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

/**
 * A {@link View} the client navigates and writes through. Extends the read base
 * with whole-tree branch navigation ({@link ClientView.branchSelection}) and the
 * write path ({@link ClientView.send} / {@link ClientView.regenerate} /
 * {@link ClientView.edit}). This is the surface behind `session.view` and the
 * `useView` hook.
 */
export interface ClientView<TInput extends CodecInputEvent, TMessage> extends View<TMessage> {
  // --- Branch navigation ---

  /**
   * Resolve the {@link BranchHandle} anchored at `codecMessageId`: the
   * sibling state plus a `select` verb to navigate it. Always returns a
   * safe handle — see {@link BranchHandle} for the per-case shape.
   *
   * Per AITRFC-014, branch points are message-anchored: edit forks
   * point at the user prompt's codec-message-id, regenerate forks
   * point at the assistant message's codec-message-id. Switch sibling
   * via the returned handle's {@link BranchHandle.select}.
   * @param codecMessageId - The codec-message-id of the bubble being rendered.
   */
  branchSelection(codecMessageId: string): BranchHandle<TMessage>;

  // --- Write operations ---

  /**
   * Send one input message on the channel. Each TInput carries its own routing
   * metadata (`parent` / `target` / `codecMessageId`) via the
   * {@link CodecInputEvent} base; the SDK reads those fields directly without
   * runtime classification.
   *
   * To send a fresh user message, wrap the domain message with
   * {@link Codec.createUserMessage} and pass the result here, e.g.
   * `view.send(codec.createUserMessage(message))`.
   *
   * A send introduces at most one new message: exactly one `UserMessage` for a
   * fresh send (which mints a new `runId`), or none for a continuation. The
   * array form exists only to carry the wire-only inputs that resolve a single
   * assistant turn (e.g. the tool results / approval responses for that turn's
   * parallel tool calls, published atomically); pair it with `options.runId`
   * to extend a suspended run. Passing more than one new (non-wire-only)
   * message rejects with `InvalidArgument`.
   *
   * The parent is auto-computed from this view's selected branch unless
   * overridden. The HTTP POST is fire-and-forget — the returned stream is
   * available immediately. If the POST fails, the error is surfaced via
   * the session's `on("error")` and the stream is errored.
   */
  send(events: TInput | TInput[], options?: SendOptions): Promise<ClientRun<TMessage>>;

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
  regenerate(messageId: string, options?: SendOptions): Promise<ClientRun<TMessage>>;

  /**
   * Edit a user message. Creates a new run that forks the target message
   * with replacement content. Automatically computes `forkOf` (the edited
   * message) and `parent` from this view's branch. The replacement is a
   * single new message — the same single-message rule as {@link ClientView.send}
   * applies.
   */
  edit(messageId: string, inputs: TInput | TInput[], options?: SendOptions): Promise<ClientRun<TMessage>>;
}
