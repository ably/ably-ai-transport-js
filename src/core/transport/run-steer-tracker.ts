/**
 * Per-run steer state for the agent's iteration loop. Tracks which steers
 * have been observed for the run but not yet drained by
 * `AgentRunTransport.hasInput()`, and which have been drained since the
 * previous step attempt opened (the per-attempt delta the agent stamps as
 * `steer-codec-message-ids`).
 *
 * Identity-based: works on codec-message-ids, not channel serials, so
 * cross-publisher delivery order does not affect outcome resolution.
 */
export class RunSteerTracker {
  /**
   * Codec-message-ids of steers observed for the run that have NOT yet been
   * drained by `hasInput()`. Populated as steering messages arrive on the
   * channel; drained into {@link _recentlyProcessed} on each `hasInput()`
   * call.
   */
  private readonly _pending = new Set<string>();

  /**
   * Codec-message-ids drained from {@link _pending} by `hasInput()` since
   * the previous step attempt opened. {@link consumeRecentlyProcessed}
   * returns the contents and clears the set — the next step attempt stamps
   * the returned ids on its assistant outputs as `steer-codec-message-ids`.
   */
  private readonly _recentlyProcessed = new Set<string>();

  /**
   * Record a steer's codec-message-id as observed for the run but not yet
   * drained. Set semantics dedup repeated adds for the same id.
   * @param codecMessageId - The observed steer's codec-message-id.
   */
  addPending(codecMessageId: string): void {
    this._pending.add(codecMessageId);
  }

  /**
   * Whether any pending steer is waiting to be drained.
   * @returns True iff at least one codec-message-id has been added since
   *   the last `drainPending()` call.
   */
  hasPending(): boolean {
    return this._pending.size > 0;
  }

  /**
   * Move every pending id into the "recently processed" set and clear
   * pending. Called by `hasInput()` when it observes pending steers — the
   * agent's loop iterates and the next step attempt stamps the delta.
   */
  drainPending(): void {
    for (const id of this._pending) this._recentlyProcessed.add(id);
    this._pending.clear();
  }

  /**
   * Return the codec-message-ids drained since the previous step attempt,
   * then clear the internal set. The caller stamps these on the next
   * attempt's output headers; each id appears on exactly one attempt.
   * @returns The codec-message-ids to stamp (empty when nothing new).
   */
  consumeRecentlyProcessed(): string[] {
    const ids = [...this._recentlyProcessed];
    this._recentlyProcessed.clear();
    return ids;
  }

  /**
   * Whether a steer has been observed for the run but no output has responded
   * to it yet: it is still pending, or drained but not yet stamped on an
   * attempt's outputs. Once stamped ({@link consumeRecentlyProcessed} clears
   * it), the responding output carries a higher serial than the steer, so
   * serial order already places the steer correctly and it is no longer
   * deferred.
   *
   * Lets a consumer flattening the run's messages move an as-yet-unresponded
   * steer to the tail so the inference prompt ends on a user message.
   * @param codecMessageId - The candidate steer's codec-message-id.
   * @returns True iff the id is a steer awaiting a response.
   */
  isUnrespondedSteer(codecMessageId: string): boolean {
    return this._pending.has(codecMessageId) || this._recentlyProcessed.has(codecMessageId);
  }
}
