/**
 * Per-Run steer state for the agent's iteration loop. Tracks which steers
 * have folded into the Run's projection but not yet been observed by
 * `Run.hasInput()`, and which have been drained since the previous `pipe()`
 * call (the per-response delta the agent stamps as
 * `steer-codec-message-ids`).
 *
 * Identity-based: works on codec-message-ids, not channel serials, so
 * cross-publisher delivery order does not affect outcome resolution.
 */
export class RunSteerTracker {
  /**
   * Codec-message-ids of steers folded into the Run's projection that have
   * NOT yet been drained by `hasInput()`. Populated by the Tree-output
   * listener as steer messages arrive; drained into
   * {@link _recentlyProcessed} on each `hasInput()` call.
   */
  private readonly _pending = new Set<string>();

  /**
   * Codec-message-ids drained from {@link _pending} by `hasInput()` since
   * the previous `pipe()` started. {@link consumeRecentlyProcessed} returns
   * the contents and clears the set — the next `pipe()` stamps the
   * returned ids on its assistant responses as `steer-codec-message-ids`.
   */
  private readonly _recentlyProcessed = new Set<string>();

  /**
   * Record a steer's codec-message-id as folded into the Run's projection
   * but not yet drained. Set semantics dedup repeated adds for the same id.
   * @param codecMessageId - The folded steer's codec-message-id.
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
   * agent's loop iterates and the next `pipe()` stamps the delta.
   */
  drainPending(): void {
    for (const id of this._pending) this._recentlyProcessed.add(id);
    this._pending.clear();
  }

  /**
   * Return the codec-message-ids drained since the previous `pipe()`,
   * then clear the internal set. The caller stamps these on the next
   * pipe's response headers; each id appears on exactly one response.
   * @returns The codec-message-ids to stamp (empty when nothing new).
   */
  consumeRecentlyProcessed(): string[] {
    const ids = [...this._recentlyProcessed];
    this._recentlyProcessed.clear();
    return ids;
  }
}
