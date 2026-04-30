/**
 * Generic lifecycle tracker for codec decoders.
 *
 * Manages per-scope (typically per-turn) tracking of lifecycle phases that
 * must be emitted before content events. When a phase has not been emitted
 * (e.g. mid-stream join), the tracker synthesizes the missing events using
 * codec-provided build functions.
 *
 * Codecs configure the tracker with an ordered list of phases, then compose
 * it into their decoder hooks. The tracker is independent of any specific
 * codec or event type.
 */

// ---------------------------------------------------------------------------
// Phase configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for a single lifecycle phase that may need to be
 * synthesized when missing from the wire stream.
 */
export interface PhaseConfig<TEvent> {
  /** Unique key identifying this phase (e.g. "start", "start-step"). */
  key: string;
  /**
   * Build the synthetic event(s) for this phase. Called with a context
   * record that codecs populate at the call site — the tracker passes
   * it through without interpreting it.
   * @param context - Key-value pairs from the call site (e.g. headers).
   * @returns One or more synthetic events to emit for this phase.
   */
  build(context: Record<string, string | undefined>): TEvent[];
}

// ---------------------------------------------------------------------------
// Tracker interface
// ---------------------------------------------------------------------------

/**
 * Per-scope lifecycle tracker that ensures required phases are emitted
 * before content events, synthesizing missing ones for mid-stream joins.
 *
 * Scoped by an arbitrary string key (typically a turn ID). Each scope
 * tracks independently which phases have been emitted.
 */
export interface LifecycleTracker<TEvent> {
  /**
   * Ensure all configured phases have been emitted for the given scope.
   * Returns synthetic events for any phases not yet marked as emitted,
   * then marks them. Returns an empty array if all phases are current.
   * @param scopeId - The scope to check (e.g. turn ID).
   * @param context - Key-value pairs passed through to phase build functions.
   * @returns Synthetic events for missing phases, in configuration order.
   */
  ensurePhases(scopeId: string, context: Record<string, string | undefined>): TEvent[];

  /**
   * Mark a phase as emitted from the wire (not synthetic). Call this
   * when the real event arrives so the tracker does not re-synthesize it.
   * @param scopeId - The scope (e.g. turn ID).
   * @param phaseKey - The phase key to mark.
   */
  markEmitted(scopeId: string, phaseKey: string): void;

  /**
   * Reset a phase so it will be re-synthesized on the next
   * {@link ensurePhases} call. Used for repeating phases (e.g. "start-step"
   * resets after "finish-step").
   * @param scopeId - The scope (e.g. turn ID).
   * @param phaseKey - The phase key to reset.
   */
  resetPhase(scopeId: string, phaseKey: string): void;

  /**
   * Remove all tracking state for a scope. Call on turn completion
   * (finish, abort) to free memory.
   * @param scopeId - The scope to clear.
   */
  clearScope(scopeId: string): void;
}

// ---------------------------------------------------------------------------
// Default implementation
// ---------------------------------------------------------------------------

// Spec: AIT-CD13
class DefaultLifecycleTracker<TEvent> implements LifecycleTracker<TEvent> {
  private readonly _phases: PhaseConfig<TEvent>[];
  private readonly _emitted = new Map<string, Set<string>>();

  constructor(phases: PhaseConfig<TEvent>[]) {
    this._phases = phases;
  }

  ensurePhases(scopeId: string, context: Record<string, string | undefined>): TEvent[] {
    const emitted = this._getOrCreate(scopeId);
    const events: TEvent[] = [];
    for (const phase of this._phases) {
      if (!emitted.has(phase.key)) {
        emitted.add(phase.key);
        events.push(...phase.build(context));
      }
    }
    return events;
  }

  markEmitted(scopeId: string, phaseKey: string): void {
    this._getOrCreate(scopeId).add(phaseKey);
  }

  resetPhase(scopeId: string, phaseKey: string): void {
    this._emitted.get(scopeId)?.delete(phaseKey);
  }

  clearScope(scopeId: string): void {
    this._emitted.delete(scopeId);
  }

  private _getOrCreate(scopeId: string): Set<string> {
    let set = this._emitted.get(scopeId);
    if (!set) {
      set = new Set();
      this._emitted.set(scopeId, set);
    }
    return set;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a lifecycle tracker configured with the given phases.
 * Phases are checked and synthesized in array order.
 * @param phases - Ordered phase configurations.
 * @returns A new {@link LifecycleTracker} instance.
 */
export const createLifecycleTracker = <TEvent>(phases: PhaseConfig<TEvent>[]): LifecycleTracker<TEvent> =>
  new DefaultLifecycleTracker(phases);
