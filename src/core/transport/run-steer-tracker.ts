/**
 * Per-run steer state for the agent's iteration loop. Tracks which steers have
 * been observed for the run but not yet drained by
 * `AgentRunTransport.hasInput()`, which have been drained since the previous
 * step attempt opened (the per-attempt delta the agent stamps as
 * `steer-transport-message-ids`), and which a step attempt has taken for
 * stamping (the steer half of the `input-transport-message-ids` bracket
 * receipt on the run's terminal).
 *
 * Identity-based: works on transport-message-ids, not channel serials, so
 * cross-publisher delivery order does not affect outcome resolution.
 */
export class RunSteerTracker {
  /**
   * The run's own triggering input, which is never a steer: the run's initial
   * pass answers it, so it is skipped on the way in and prepended on the way
   * out. `undefined` for a run with no located trigger.
   */
  private readonly _triggerId: string | undefined;

  /**
   * Transport-message-ids of steers observed for the run that have NOT yet been
   * drained by `hasInput()`. Populated as steering messages arrive on the
   * channel; drained into {@link _recentlyProcessed} on each `hasInput()`
   * call.
   */
  private readonly _pending = new Set<string>();

  /**
   * Transport-message-ids drained from {@link _pending} by `hasInput()` since
   * the previous step attempt opened. {@link consumeRecentlyProcessed}
   * returns the contents and clears the set — the next step attempt stamps
   * the returned ids on its assistant outputs as `steer-transport-message-ids`.
   */
  private readonly _recentlyProcessed = new Set<string>();

  /**
   * Every transport-message-id ever offered to {@link addPending} and accepted.
   * Never cleared, so a steer the channel redelivers after it was drained does
   * not re-enter {@link _pending} and drive a second pass over the same input.
   */
  private readonly _known = new Set<string>();

  /**
   * Transport-message-ids step attempts have taken for stamping, in the order
   * they were taken. Cumulative for the run's lifetime — this is the receipt
   * {@link consideredIds} reports, not a per-attempt delta.
   */
  private readonly _considered: string[] = [];

  /**
   * @param triggerId - The run's triggering input's transport-message-id, when
   *   one was located.
   */
  constructor(triggerId?: string) {
    this._triggerId = triggerId;
  }

  /**
   * Record a steering message observed for this run as pending. Skips the
   * run's own triggering input, and any id already accepted — including one
   * already drained, so a redelivery does not drive a second pass.
   * @param transportMessageId - The observed steering message's transport-message-id.
   * @returns True iff the id became pending, so the caller fires its `onSteer`
   *   hint for a genuinely new steer and stays quiet otherwise.
   */
  addPending(transportMessageId: string): boolean {
    if (transportMessageId === this._triggerId) return false;
    if (this._known.has(transportMessageId)) return false;
    this._known.add(transportMessageId);
    this._pending.add(transportMessageId);
    return true;
  }

  /**
   * Whether any pending steer is waiting to be drained.
   * @returns True iff at least one transport-message-id has been added since
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
   * Return the transport-message-ids drained since the previous step attempt,
   * then clear the internal set. The caller stamps these on the next
   * attempt's output headers; each id appears on exactly one attempt.
   *
   * Taking them for stamping is also the moment they count as considered, so
   * they land in {@link consideredIds} here rather than at a second transfer
   * point that could disagree with the stamps.
   * @returns The transport-message-ids to stamp (empty when nothing new).
   */
  consumeRecentlyProcessed(): string[] {
    const ids = [...this._recentlyProcessed];
    this._recentlyProcessed.clear();
    this._considered.push(...ids);
    return ids;
  }

  /**
   * The `input-transport-message-ids` bracket receipt for the run's terminal
   * events: the trigger, then every steer a step attempt took for stamping.
   * @returns The considered input ids, oldest first.
   */
  consideredIds(): string[] {
    return this._triggerId === undefined ? [...this._considered] : [this._triggerId, ...this._considered];
  }
}
