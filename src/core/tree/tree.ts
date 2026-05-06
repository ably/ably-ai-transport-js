import { EventEmitter } from '../../event-emitter.js';
import type { Logger } from '../../logger.js';
import type { Run, RunStatus } from '../run/index.js';
import type { StepRecord, StepStatus } from '../step/index.js';
import type { ControlSignal } from './control-signal.js';

/**
 * A node in the session's conversation tree. Carries the domain message
 * plus transport metadata (identity, attribution) and the Ably message
 * serial that ordered it on the channel.
 *
 * Generic over `TRun` so the projection layer (`ClientView`, `AgentView`)
 * can attach the codec-typed run handle (`ClientRun<C>` / `AgentRun<C>`)
 * the consumer expects on `node.run`. Tree-level nodes leave `run`
 * undefined — the views that project them in fill it in.
 *
 * Phase 7 subset of the RFC's `MessageNode` — `parentId`, `children`,
 * and the typed `step` reference are deferred and land additively in
 * later phases. `runId` is exposed as a string so `AgentRun` and
 * `AgentView` can filter messages by their owning run regardless of
 * whether `run` has been resolved.
 */
export interface MessageNode<TMessage, TRun extends Run<TMessage> = Run<TMessage>> {
  /** Unique message ID (from the `x-ably-msg-id` header). */
  readonly id: string;

  /**
   * The participant type that produced this message (from the `x-ably-role`
   * header). Client-initiated publishes are `user`; agent-initiated publishes
   * are `assistant`. This is the protocol role, which may differ from the
   * role the codec encodes inside the domain message — use this when filtering
   * or attributing at the transport level.
   */
  readonly role: 'user' | 'assistant';

  /**
   * The clientId this message is attributed to. Taken from the
   * `x-ably-client-id` header when present (a backend publishing on behalf
   * of an end-user), otherwise from the publishing connection's
   * `message.clientId`. Use this for UI attribution, access checks, and
   * filtering to a specific user's activity.
   */
  readonly clientId: string;

  /**
   * The id of the run this message was published into (from the
   * `x-ably-run-id` header). Stable for the lifetime of the node;
   * `AgentRun.messages` and `AgentView.messages` filter on it.
   */
  readonly runId: string;

  /**
   * The id of the step this message was published into (from the
   * `x-ably-step-id` header), or `undefined` for messages published
   * outside any step (typically client-published user messages).
   * Stable for the lifetime of the node.
   *
   * Reads as the natural unit of "this step's output" — UI projections
   * that want to discard a failed step's partial output keep the
   * step-id and filter; the run as a whole stays visible.
   */
  readonly stepId?: string;

  /**
   * The run this message belongs to, typed to the session variant — a
   * `ClientRun<C>` on a `ClientView`'s nodes, the plain {@link Run} record
   * on the tree itself. Filled in by the projecting view; tree-level nodes
   * leave it undefined.
   *
   * Lets UI code drive per-message controls directly from the rendered
   * node — `node.run?.abort()` rather than a separate lookup through
   * `view.runs`. Undefined when the node represents a message published
   * before its run-start was observed (rare; can happen mid-hydration
   * when out-of-order delivery brings a message ahead of the run-start
   * for its run).
   */
  readonly run?: TRun;

  /**
   * The step this message was published into, mirroring the
   * {@link StepRecord} on the tree. Filled in by the projecting view;
   * tree-level nodes leave it undefined.
   *
   * Lets UI code drive per-message rendering decisions directly from the
   * rendered node — `node.step?.status` rather than a separate lookup
   * through {@link View.steps}. Undefined when:
   *
   *   - The message has no `stepId` (user messages and other client
   *     publishes outside any step).
   *   - The message arrived before its owning step's `x-ably-step-start`
   *     was observed (rare; can happen mid-hydration when out-of-order
   *     delivery brings a message ahead of the step-start for its step).
   */
  readonly step?: StepRecord;

  /** The domain message in the codec's representation. */
  readonly message: TMessage;

  /**
   * Whether any part of this message is still being streamed. `true` while
   * streaming chunks are being appended; `false` once the message is
   * complete. Set by the session decode loop:
   *
   *   - Streaming-part wires (`kind: 'part'`) produce nodes with
   *     `streaming: true`.
   *   - Complete-message wires (`kind: 'message'`) produce nodes with
   *     `streaming: false`.
   *   - Lifecycle wires (`x-ably-run-end`, `x-ably-step-end`) flip every
   *     still-streaming node for the affected run to `streaming: false`
   *     — no further chunks can land coherently after those wires.
   *     Control-signal observations do not flip the flag; the agent
   *     reacting to a signal publishes the lifecycle wire that does.
   */
  readonly streaming: boolean;

  /**
   * The Ably message serial that delivered this node. Retained on the
   * node so later phases (step supersession in particular) can reason
   * about total ordering on the channel without having to thread the
   * inbound message through.
   */
  readonly serial: string;

  /**
   * Whether this message contributes to the run's current state.
   *
   * Mirrors the canonical flag of the step that produced this message
   * (see {@link import('../step/index.js').StepRecord.canonical}). Always
   * `true` when the message has no `stepId` — user messages and other
   * client publishes are not retry-targetable. Otherwise tracks the
   * step's flag: when a later `x-ably-step-start` arrives that retires
   * a prior step (failed/aborted predecessor of a retry, or an
   * `'active'` step being abandoned), the tree flips `canonical` on
   * every message that step produced. Spec: AIT-CN2.
   *
   * Consumers project this field. The agent's model-bound view typically
   * filters by `canonical` so the model never sees a retried attempt's
   * partial output; UI projections render non-canonical bubbles
   * distinctly while preserving them as history.
   */
  readonly canonical: boolean;
}

/**
 * Typed event surface emitted by the {@link Tree}. Granular alternative to
 * the coarse {@link Tree.subscribe} callback for consumers that want to
 * react to specific transitions without re-reading the full tree.
 *
 * - `'step-ended'` fires when a step transitions from `'active'` to a
 *   terminal status via observed `x-ably-step-end`. Carries the
 *   updated {@link StepRecord} and its parent {@link Run} record.
 * - `'control-signal'` fires when a control-signal wire is observed
 *   on the channel. Carries the {@link ControlSignal} record and the
 *   targeted run.
 *
 * Other tree-level transitions (run-started/run-ended,
 * step-started, message-added/updated) remain accessible via
 * {@link Tree.subscribe}; granular events for them land if and when
 * concrete consumers need them.
 */
export interface TreeEvents<TMessage> {
  /** A step transitioned from `'active'` to a terminal status. */
  'step-ended': { step: StepRecord; run: Run<TMessage> };
  /** A control-signal wire was observed for a known run. */
  'control-signal': { signal: ControlSignal; run: Run<TMessage> };
}

/**
 * The unfiltered conversation tree: every node, run, step, and observed
 * control signal the session has materialised. The tree is the canonical
 * source of conversation structure; views project it.
 */
export interface Tree<TMessage> {
  /** All message nodes the tree has observed, ordered by serial. */
  readonly messages: readonly MessageNode<TMessage>[];

  /**
   * All runs the tree has observed, in the order their `x-ably-run-start`
   * arrived on the channel. A run's entry transitions in place from
   * `'active'` to a terminal status as later wire messages land — callers
   * re-read this collection on each {@link subscribe} notification rather
   * than holding references to entries.
   */
  readonly runs: readonly Run<TMessage>[];

  /**
   * All steps the tree has observed, in the order their `x-ably-step-start`
   * arrived on the channel. Phase 9 records steps as `'active'`; later
   * phases transition entries in place to terminal statuses.
   */
  readonly steps: readonly StepRecord[];

  /**
   * Look up a run record by id. Returns `undefined` when the tree has not
   * observed an `x-ably-run-start` for that id. Lets the projecting view
   * resolve the {@link MessageNode.run} reference without scanning
   * {@link runs} on every node it materialises.
   * @param id The run id to look up.
   * @returns The run record, or `undefined` when unknown.
   */
  getRun(id: string): Run<TMessage> | undefined;

  /**
   * Look up a step record by id. Returns `undefined` when the tree has not
   * observed an `x-ably-step-start` for that id. Lets the projecting view
   * resolve the {@link MessageNode.step} reference without scanning
   * {@link steps} on every node it materialises.
   * @param id The step id to look up.
   * @returns The step record, or `undefined` when unknown.
   */
  getStep(id: string): StepRecord | undefined;

  /**
   * Register a coarse change listener. The handler fires after every
   * structural change to the tree — callers re-read {@link messages} or
   * {@link runs} to project the new state. Returns an unsubscribe function;
   * subsequent calls to it are idempotent.
   * @param callback Invoked with no arguments after each change.
   * @returns A function that removes the listener when called.
   */
  subscribe(callback: () => void): () => void;

  /**
   * Register a typed listener for a granular tree event. See
   * {@link TreeEvents} for the available event names and payloads.
   *
   * Listener exceptions are isolated — a throwing listener is logged
   * and does not prevent other listeners from firing or subsequent
   * events from being delivered.
   * @param event The event name to subscribe to.
   * @param handler The callback invoked with the event's payload.
   */
  on<K extends keyof TreeEvents<TMessage>>(event: K, handler: (event: TreeEvents<TMessage>[K]) => void): void;

  /**
   * Remove a previously registered granular event listener.
   * @param event The event name the handler was registered for.
   * @param handler The handler to remove.
   */
  off<K extends keyof TreeEvents<TMessage>>(event: K, handler: (event: TreeEvents<TMessage>[K]) => void): void;
}

/**
 * Internal extension of {@link Tree}. The decode loop and other SDK
 * components apply observed messages through this surface; consumers
 * see only the read-only {@link Tree}.
 * @internal
 */
export interface TreeInternal<TMessage> extends Tree<TMessage> {
  /**
   * Insert a node into the tree at its serial-ordered position and notify
   * subscribers. Out-of-order serials still land in serial order so the
   * tree's `messages` array remains a stable projection of channel order
   * regardless of arrival sequence.
   * @param node The node to insert.
   */
  applyMessage(node: MessageNode<TMessage>): void;

  /**
   * Replace the composed `message` payload of an existing node and notify
   * subscribers. Used by the decode loop when subsequent chunks arrive under
   * the same `x-ably-msg-id` — the accumulator has already absorbed the new
   * part, and the tree mirrors the resulting composed state.
   *
   * If `id` does not match an existing node the call is logged and ignored —
   * the session's decode loop only invokes this method after confirming the
   * id is present, so a not-found case is a programming error worth surfacing
   * but not throwing on.
   * @param id Identifier of the node to update.
   * @param message Replacement composed message payload.
   */
  updateMessage(id: string, message: TMessage): void;

  /**
   * Record a `'active'` run observed via `x-ably-run-start`. A duplicate id
   * (a second `x-ably-run-start` for the same run) is logged and ignored —
   * run-start is one-shot per run on the wire, so a duplicate indicates
   * either history hydration replaying a known run or a faulty publisher.
   * @param run The run record to record. Status must be `'active'`.
   */
  applyRunStart(run: Run<TMessage>): void;

  /**
   * Transition a known run to the terminal status carried by
   * `x-ably-run-end`. The terminal is taken at face value — a later
   * `x-ably-step-start` (e.g. driven by retry) re-activates the run via
   * {@link applyStepStart}.
   *
   * If `runId` does not match a recorded run the call is logged and
   * ignored — a session that subscribed mid-run can legitimately see
   * run-end without prior run-start.
   * @param options Identification and target status for the transition.
   * @param options.runId The id of the run to transition.
   * @param options.status The status to transition the run into.
   */
  applyRunEnd(options: { runId: string; status: RunStatus }): void;

  /**
   * Record a control signal observed on the channel and emit
   * {@link TreeEvents.control-signal}. Appends to the targeted run's
   * {@link Run.controlSignals} list. Status is **never** mutated — the
   * agent that processes the signal publishes the lifecycle wire that
   * actually transitions state.
   *
   * If `runId` does not match a known run the call is logged and
   * ignored. Idempotent on `messageId` — a duplicate observation
   * (history replay) is recorded once.
   * @param signal The control signal to record.
   */
  applyControlSignal(signal: ControlSignal): void;

  /**
   * Record a `'active'` step observed via `x-ably-step-start`. If the
   * step's run is currently in a terminal status (`'failed'`,
   * `'aborted'`, or `'complete'`), the run transitions back to
   * `'active'` — this is the retry mechanic: the agent processing a
   * retry signal publishes a fresh step-start, which re-activates the
   * run.
   *
   * The arrival also retires prior steps in the same run as the
   * canonical-step rule requires (Spec: AIT-CN2, AIT-CN3):
   *
   *   - Any prior `'active'` step in the same run is mutated to
   *     `'abandoned'` (tree-derived; never wire-published) and its
   *     nodes' `streaming` flag cleared. Crash detection without
   *     heartbeats — the new step-start is unambiguous proof the prior
   *     worker is no longer running.
   *   - Any prior `'failed'` or `'aborted'` step in the same run flips
   *     `canonical` to `false` — the new step is the retry attempt, so
   *     the failed predecessor's output no longer contributes to the
   *     run's current state.
   *   - `'complete'` and `'paused'` predecessors stay canonical
   *     (multi-step continuations all contribute to current state).
   *
   * A duplicate id (a second `x-ably-step-start` for the same step)
   * is logged and ignored — step-start is one-shot per step on the
   * wire.
   * @param step The step record to record. Status must be `'active'`,
   *   `canonical` must be `true`, and `serial` must carry the inbound
   *   `x-ably-step-start` wire's serial.
   */
  applyStepStart(step: StepRecord): void;

  /**
   * Transition a known step to a terminal status in response to
   * `x-ably-step-end`. If `stepId` does not match a recorded step the call
   * is logged and ignored — without history hydration (phase 13) a session
   * that subscribed mid-run can legitimately see step-end without prior
   * step-start.
   * @param options Identification and target status for the transition.
   * @param options.stepId The id of the step to transition.
   * @param options.status The terminal status to transition the step into.
   */
  applyStepEnd(options: { stepId: string; status: StepStatus }): void;
}

/** Options for constructing a {@link DefaultTree}. */
export interface TreeOptions {
  /** Logger inherited from the owning session. */
  logger: Logger;
}

/**
 * Default {@link TreeInternal} implementation. Maintains a single array
 * of nodes ordered by serial and a flat set of coarse subscribers.
 * Granular event delivery is handled by an internal {@link EventEmitter}.
 * @internal
 */
export class DefaultTree<TMessage> implements TreeInternal<TMessage> {
  private readonly _logger: Logger;
  private readonly _messages: MessageNode<TMessage>[] = [];
  private readonly _runs: Run<TMessage>[] = [];
  private readonly _steps: StepRecord[] = [];
  private readonly _subscribers = new Set<() => void>();
  private readonly _emitter: EventEmitter<TreeEvents<TMessage>>;

  constructor(options: TreeOptions) {
    this._logger = options.logger.withContext({ component: 'Tree' });
    this._emitter = new EventEmitter<TreeEvents<TMessage>>(this._logger);
    this._logger.trace('DefaultTree(); initialized');
  }

  get messages(): readonly MessageNode<TMessage>[] {
    return this._messages;
  }

  get runs(): readonly Run<TMessage>[] {
    return this._runs;
  }

  get steps(): readonly StepRecord[] {
    return this._steps;
  }

  getRun(id: string): Run<TMessage> | undefined {
    return this._runs.find((run) => run.id === id);
  }

  getStep(id: string): StepRecord | undefined {
    return this._steps.find((step) => step.id === id);
  }

  applyMessage(node: MessageNode<TMessage>): void {
    this._logger.trace('DefaultTree.applyMessage();', { id: node.id, serial: node.serial });

    // Project `canonical` from the current step state. Messages without a
    // stepId are always canonical (user messages, run-start time messages
    // are not retry-targetable). Messages whose step has not yet been
    // observed default to `true` — out-of-order delivery typically lands
    // the step-start shortly afterwards, and the alternative (default
    // false) would render the bubble as historical from the start.
    // Spec: AIT-CN2.
    const stepCanonical = node.stepId === undefined ? true : (this._stepCanonical(node.stepId) ?? true);
    const projected: MessageNode<TMessage> = { ...node, canonical: stepCanonical };

    const insertAt = this._messages.findIndex((existing) => existing.serial > projected.serial);
    const targetIndex = insertAt === -1 ? this._messages.length : insertAt;
    this._messages.splice(targetIndex, 0, projected);

    this._notify();
  }

  /**
   * Read the canonical flag of a step by id. Returns `undefined` when the
   * step has not been observed — the caller decides the default for that
   * case.
   * @param stepId The step id to look up.
   * @returns The step's canonical flag, or `undefined` if not yet observed.
   */
  private _stepCanonical(stepId: string): boolean | undefined {
    return this._steps.find((s) => s.id === stepId)?.canonical;
  }

  updateMessage(id: string, message: TMessage): void {
    this._logger.trace('DefaultTree.updateMessage();', { id });

    const index = this._messages.findIndex((node) => node.id === id);
    const existing = index === -1 ? undefined : this._messages[index];
    if (existing === undefined) {
      this._logger.warn('DefaultTree.updateMessage(); node not found', { id });
      return;
    }
    this._messages[index] = { ...existing, message };
    this._notify();
  }

  /**
   * Flip `streaming` to `false` on every node belonging to the given run
   * that is currently streaming. Called from {@link applyRunEnd} and
   * {@link applyStepEnd} — after either lifecycle wire lands no further
   * parts can coherently extend a message in the run. Control-signal
   * observation does not call this: signals never end a stream
   * directly; the agent reacting to a signal publishes the lifecycle
   * wire that does.
   *
   * Mutates each affected node into a fresh object (so identity-based
   * change detection in consumers picks the transition up) and notifies
   * subscribers exactly once when at least one node was updated.
   * @param runId The id of the run whose streaming nodes should be marked
   *   complete.
   * @returns `true` when at least one node was updated, otherwise `false`.
   */
  private _clearStreamingForRun(runId: string): boolean {
    let changed = false;
    for (let i = 0; i < this._messages.length; i++) {
      const existing = this._messages[i];
      if (existing === undefined) {
        continue;
      }
      if (existing.runId !== runId || !existing.streaming) {
        continue;
      }
      this._messages[i] = { ...existing, streaming: false };
      changed = true;
    }
    return changed;
  }

  applyRunStart(run: Run<TMessage>): void {
    this._logger.trace('DefaultTree.applyRunStart();', { runId: run.id });

    if (this._runs.some((existing) => existing.id === run.id)) {
      this._logger.warn('DefaultTree.applyRunStart(); duplicate run id', { runId: run.id });
      return;
    }
    this._runs.push(run);
    this._notify();
  }

  applyRunEnd(options: { runId: string; status: RunStatus }): void {
    this._logger.trace('DefaultTree.applyRunEnd();', { runId: options.runId, status: options.status });

    const index = this._runs.findIndex((run) => run.id === options.runId);
    const existing = index === -1 ? undefined : this._runs[index];
    if (existing === undefined) {
      this._logger.warn('DefaultTree.applyRunEnd(); run not found', { runId: options.runId });
      return;
    }

    this._runs[index] = { ...existing, status: options.status };
    this._clearStreamingForRun(options.runId);
    this._notify();
  }

  applyControlSignal(signal: ControlSignal): void {
    this._logger.trace('DefaultTree.applyControlSignal();', {
      type: signal.type,
      runId: signal.runId,
      stepId: signal.stepId,
      messageId: signal.messageId,
    });

    const index = this._runs.findIndex((run) => run.id === signal.runId);
    const existing = index === -1 ? undefined : this._runs[index];
    if (existing === undefined) {
      this._logger.warn('DefaultTree.applyControlSignal(); run not found', {
        type: signal.type,
        runId: signal.runId,
      });
      return;
    }

    if (existing.controlSignals.some((s) => s.messageId === signal.messageId)) {
      // Idempotent on messageId — history replay can re-deliver the same
      // signal wire. Re-recording would skew callers that read the list as
      // an arrival-ordered log.
      return;
    }

    const updated: Run<TMessage> = { ...existing, controlSignals: [...existing.controlSignals, signal] };
    this._runs[index] = updated;
    this._notify();
    this._emitter.emit('control-signal', { signal, run: updated });
  }

  applyStepStart(step: StepRecord): void {
    this._logger.trace('DefaultTree.applyStepStart();', { stepId: step.id, runId: step.runId, serial: step.serial });

    if (this._steps.some((existing) => existing.id === step.id)) {
      this._logger.warn('DefaultTree.applyStepStart(); duplicate step id', { stepId: step.id });
      return;
    }

    // Retire prior steps in the same run before adding the new entry. The
    // canonical-step rule (Spec: AIT-CN2) treats a later-serial step-start
    // as the current latest, so any earlier-serial sibling that's
    // `'active'` is abandoned (Spec: AIT-CN3), and any `'failed'`/
    // `'aborted'` predecessor flips to non-canonical (it was retried).
    // Out-of-order delivery is handled by serial comparison inside the
    // helper — a later-serial sibling that lands first must not retire
    // the newer arrival.
    this._retirePriorStepsForRun(step.runId, step.serial);

    this._steps.push(step);

    // Re-activate the run if it was in a terminal status — this is what
    // makes retry-after-{failed,aborted,complete} work. The signal alone
    // never changed status; the agent's step-start is the lifecycle wire
    // that does. Status only ever moves through observed lifecycle wires.
    const runIndex = this._runs.findIndex((r) => r.id === step.runId);
    const existingRun = runIndex === -1 ? undefined : this._runs[runIndex];
    if (existingRun !== undefined && existingRun.status !== 'active') {
      this._logger.debug('DefaultTree.applyStepStart(); re-activating run from terminal', {
        runId: step.runId,
        previousStatus: existingRun.status,
      });
      this._runs[runIndex] = { ...existingRun, status: 'active' };
    }

    this._notify();
  }

  /**
   * Walk the steps in a run and retire predecessors of a newly-arriving
   * step-start, per the canonical-step rule (Spec: AIT-CN2, AIT-CN3):
   *
   *   - `'active'` step → mutate to `'abandoned'`, canonical → `false`,
   *     and clear `streaming` on its nodes (worker is provably gone).
   *   - `'failed'` / `'aborted'` step that was canonical → flip
   *     canonical → `false` (it was retried; the new step-start is
   *     proof). Status stays as recorded so observers can still see the
   *     attempt's terminal.
   *   - Other statuses (`'complete'`, `'paused'`, already-non-canonical
   *     `'abandoned'`/`'superseded'`) are left untouched.
   *
   * Only siblings with an earlier `serial` are considered — a later-
   * serial sibling that happens to land first (out-of-order delivery)
   * must not retire the newer arrival. The rule is "no later-serial
   * step-start exists in the same run", read directly. Spec: AIT-CN2.
   *
   * Each affected step's nodes are projected onto a fresh node object
   * with the new `canonical` (and, for abandoned, `streaming: false`)
   * so identity-based change detection picks the transition up.
   * @param runId The run whose prior steps to retire.
   * @param newSerial Serial of the newly-arriving step-start; only
   *   siblings whose serial sorts strictly earlier are considered.
   */
  private _retirePriorStepsForRun(runId: string, newSerial: string): void {
    for (let i = 0; i < this._steps.length; i++) {
      const existing = this._steps[i];
      if (existing?.runId !== runId) {
        continue;
      }
      if (existing.serial >= newSerial) {
        // Lex-compare on the Ably serial — `>=` rules out same-serial
        // (the duplicate-id guard already rejects exact resubmissions)
        // and any later-serial sibling that landed before its
        // step-start in delivery order.
        continue;
      }
      if (existing.status === 'active') {
        const updated: StepRecord = { ...existing, status: 'abandoned', canonical: false };
        this._steps[i] = updated;
        this._flipNodeFlagsForStep(existing.id, { canonical: false, clearStreaming: true });
        continue;
      }
      if ((existing.status === 'failed' || existing.status === 'aborted') && existing.canonical) {
        const updated: StepRecord = { ...existing, canonical: false };
        this._steps[i] = updated;
        this._flipNodeFlagsForStep(existing.id, { canonical: false, clearStreaming: false });
      }
    }
  }

  /**
   * Mutate the stored nodes for a given step to reflect a status
   * transition that retired the step. Used by
   * {@link _retirePriorStepsForRun} to flip `canonical` (and optionally
   * `streaming`) on every node carrying the step's id.
   * @param stepId The id of the step whose nodes to update.
   * @param updates Per-flag instructions; see field descriptions.
   * @param updates.canonical New `canonical` value to set on every
   *   matching node.
   * @param updates.clearStreaming When `true`, also flip `streaming` to
   *   `false` on every matching node that is currently streaming.
   */
  private _flipNodeFlagsForStep(stepId: string, updates: { canonical: boolean; clearStreaming: boolean }): void {
    for (let i = 0; i < this._messages.length; i++) {
      const existing = this._messages[i];
      if (existing?.stepId !== stepId) {
        continue;
      }
      const next: MessageNode<TMessage> = { ...existing, canonical: updates.canonical };
      this._messages[i] = updates.clearStreaming && existing.streaming ? { ...next, streaming: false } : next;
    }
  }

  applyStepEnd(options: { stepId: string; status: StepStatus }): void {
    this._logger.trace('DefaultTree.applyStepEnd();', { stepId: options.stepId, status: options.status });

    const index = this._steps.findIndex((step) => step.id === options.stepId);
    const existing = index === -1 ? undefined : this._steps[index];
    if (existing === undefined) {
      this._logger.warn('DefaultTree.applyStepEnd(); step not found', { stepId: options.stepId });
      return;
    }
    if (existing.status === 'abandoned') {
      // Abandonment is a tree-derived classification proved by a later
      // step-start in the same run; a wire step-end from the abandoned
      // worker doesn't undo it. The wire status is logged and ignored
      // — the tree's view is authoritative because it has observed the
      // retiring step-start. Spec: AIT-CN3.
      this._logger.debug('DefaultTree.applyStepEnd(); ignoring step-end on abandoned step', {
        stepId: options.stepId,
        wireStatus: options.status,
      });
      return;
    }
    // Preserve the existing canonical flag — applyStepStart is the only
    // mutation point that retires a step. Transitioning `'active'` →
    // terminal does not change canonical-ness on its own (multi-step
    // success keeps every `'complete'` step canonical; an isolated
    // `'failed'` is canonical until a retry lands). Spec: AIT-CN2.
    const updated: StepRecord = { ...existing, status: options.status };
    this._steps[index] = updated;
    // The step-end terminates the streaming wave for the run — no further
    // codec parts under in-flight messages can coherently arrive after it.
    this._clearStreamingForRun(existing.runId);
    this._notify();

    // Granular emit happens after _notify so consumers reading the tree
    // from the granular handler see the post-update state.
    const run = this._runs.find((r) => r.id === existing.runId);
    if (run !== undefined) {
      this._emitter.emit('step-ended', { step: updated, run });
    }
  }

  on<K extends keyof TreeEvents<TMessage>>(event: K, handler: (event: TreeEvents<TMessage>[K]) => void): void {
    this._emitter.on(event, handler);
  }

  off<K extends keyof TreeEvents<TMessage>>(event: K, handler: (event: TreeEvents<TMessage>[K]) => void): void {
    this._emitter.off(event, handler);
  }

  subscribe(callback: () => void): () => void {
    this._logger.trace('DefaultTree.subscribe();');
    this._subscribers.add(callback);
    return () => {
      this._subscribers.delete(callback);
    };
  }

  private _notify(): void {
    // Set iteration tolerates a handler removing itself: the current element is
    // already yielded, and subsequent live subscribers continue to be visited.
    for (const callback of this._subscribers) {
      try {
        callback();
      } catch (error) {
        this._logger.error('DefaultTree._notify(); subscriber threw', { error });
      }
    }
  }
}
