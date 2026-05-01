import type { Logger } from '../../logger.js';
import type { Run, RunStatus } from '../run/index.js';
import type { StepRecord } from '../step/index.js';

/**
 * A node in the session's conversation tree. Carries the domain message
 * plus transport metadata (identity, attribution) and the Ably message
 * serial that ordered it on the channel.
 *
 * Phase 7 subset of the RFC's `MessageNode` — `parentId`, `children`,
 * the typed `run`/`step` references, and `streaming` are deferred and
 * land additively in later phases. `runId` is exposed as a string so
 * `AgentRun` and `AgentView` can filter messages by their owning run
 * before the typed `run` reference lands.
 */
export interface MessageNode<TMessage> {
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

  /** The domain message in the codec's representation. */
  readonly message: TMessage;

  /**
   * The Ably message serial that delivered this node. Retained on the
   * node so later phases (step supersession in particular) can reason
   * about total ordering on the channel without having to thread the
   * inbound message through.
   */
  readonly serial: string;
}

/**
 * The unfiltered conversation tree: every node and every run the session has
 * observed. The tree is the canonical source of conversation structure
 * within a session; views project it.
 *
 * Phase 5 subset — `messages`, `runs`, and the coarse `subscribe`
 * notification. Granular events (`message-added`, `run-started`, …), the
 * `steps` collection, and lookup helpers land in later phases.
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
   * Register a coarse change listener. The handler fires after every
   * structural change to the tree — callers re-read {@link messages} or
   * {@link runs} to project the new state. Returns an unsubscribe function;
   * subsequent calls to it are idempotent.
   * @param callback Invoked with no arguments after each change.
   * @returns A function that removes the listener when called.
   */
  subscribe(callback: () => void): () => void;
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
   * Transition a known run to a terminal status in response to
   * `x-ably-run-end`. If `runId` does not match a recorded run the call is
   * logged and ignored — without history hydration (phase 13) a session
   * that subscribed mid-run can legitimately see run-end without prior
   * run-start.
   * @param options Identification and target status for the transition.
   * @param options.runId The id of the run to transition.
   * @param options.status The status to transition the run into.
   */
  applyRunEnd(options: { runId: string; status: RunStatus }): void;

  /**
   * Record a `'active'` step observed via `x-ably-step-start`. A duplicate
   * id (a second `x-ably-step-start` for the same step) is logged and
   * ignored — step-start is one-shot per step on the wire, so a duplicate
   * indicates either history hydration replaying a known step or a faulty
   * publisher.
   * @param step The step record to record. Status must be `'active'`.
   */
  applyStepStart(step: StepRecord): void;
}

/** Options for constructing a {@link DefaultTree}. */
export interface TreeOptions {
  /** Logger inherited from the owning session. */
  logger: Logger;
}

/**
 * Default {@link TreeInternal} implementation. Maintains a single array
 * of nodes ordered by serial and a flat set of coarse subscribers.
 * @internal
 */
export class DefaultTree<TMessage> implements TreeInternal<TMessage> {
  private readonly _logger: Logger;
  private readonly _messages: MessageNode<TMessage>[] = [];
  private readonly _runs: Run<TMessage>[] = [];
  private readonly _steps: StepRecord[] = [];
  private readonly _subscribers = new Set<() => void>();

  constructor(options: TreeOptions) {
    this._logger = options.logger.withContext({ component: 'Tree' });
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

  applyMessage(node: MessageNode<TMessage>): void {
    this._logger.trace('DefaultTree.applyMessage();', { id: node.id, serial: node.serial });

    const insertAt = this._messages.findIndex((existing) => existing.serial > node.serial);
    const targetIndex = insertAt === -1 ? this._messages.length : insertAt;
    this._messages.splice(targetIndex, 0, node);

    this._notify();
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
    this._notify();
  }

  applyStepStart(step: StepRecord): void {
    this._logger.trace('DefaultTree.applyStepStart();', { stepId: step.id, runId: step.runId });

    if (this._steps.some((existing) => existing.id === step.id)) {
      this._logger.warn('DefaultTree.applyStepStart(); duplicate step id', { stepId: step.id });
      return;
    }
    this._steps.push(step);
    this._notify();
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
