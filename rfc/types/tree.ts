import type { ControlSignal } from './control-signal.js';
import type { MessageNode } from './message-node.js';
import type { Run } from './run.js';
import type { StepState } from './step.js';

/**
 * The unfiltered conversation tree: every node from every branch, plus
 * every run and step the session has observed. The tree is the canonical
 * source of conversation structure within a session; views project it.
 *
 * Tree events are granular and typed (message-added, run-started, etc.)
 * so advanced consumers — debug panels, telemetry, framework integrations —
 * can observe exactly what changed. For UI rendering, use a view's
 * state-oriented subscribe() instead.
 */
export interface Tree<TMessage, TRun extends Run<TMessage> = Run<TMessage>> {
  /** All message nodes across all branches, ordered by serial. */
  readonly messages: readonly MessageNode<TMessage, TRun>[];

  /** All runs across all branches. */
  readonly runs: readonly TRun[];

  /** Look up a message node by ID. */
  getMessage(id: string): MessageNode<TMessage, TRun> | undefined;

  /** Look up a run by ID. */
  getRun(id: string): TRun | undefined;

  // --- Granular events ---

  /**
   * Register a handler for a message-node event. `message-added` fires when
   * a new node first appears in the tree; `message-updated` fires when an
   * existing node changes (stream append, completion, external update).
   */
  on(event: 'message-added' | 'message-updated', handler: (node: MessageNode<TMessage, TRun>) => void): void;
  /**
   * Register a handler for a run lifecycle event. `run-started` fires on
   * open; `run-updated` fires when the run's observable state changes
   * (suspend reason, steps); `run-ended` fires when the run reaches a
   * terminal status.
   */
  on(event: 'run-started' | 'run-updated' | 'run-ended', handler: (run: TRun) => void): void;
  /**
   * Register a handler for a step lifecycle event. `step-started` fires on
   * open; `step-updated` fires on observable state change; `step-ended`
   * fires when the step reaches a terminal status.
   */
  on(event: 'step-started' | 'step-updated' | 'step-ended', handler: (step: StepState, run: TRun) => void): void;
  /**
   * Register a handler for control signals observed on the channel (live
   * and during hydration). Control signals are SDK-owned and codec-
   * independent; the handler receives the {@link ControlSignal} together
   * with the run it targets.
   *
   * For the common step-scoped pause case, prefer {@link Step.on}
   * `'pause'` — it fires for the same underlying signal but is scoped to
   * a live step and has a simpler handler signature.
   */
  on(event: 'control-signal', handler: (signal: ControlSignal, run: TRun) => void): void;

  /** Remove a previously registered message-node event handler. */
  off(event: 'message-added' | 'message-updated', handler: (node: MessageNode<TMessage, TRun>) => void): void;
  /** Remove a previously registered run lifecycle handler. */
  off(event: 'run-started' | 'run-updated' | 'run-ended', handler: (run: TRun) => void): void;
  /** Remove a previously registered step lifecycle handler. */
  off(event: 'step-started' | 'step-updated' | 'step-ended', handler: (step: StepState, run: TRun) => void): void;
  /** Remove a previously registered control-signal handler. */
  off(event: 'control-signal', handler: (signal: ControlSignal, run: TRun) => void): void;
}
