/**
 * Per-node event log.
 *
 * Each node retains the decoded events it was folded from, grouped by
 * wire-message serial and ordered ascending by serial. The log captures
 * canonical serial order regardless of delivery order, so a node's event
 * sequence can be re-derived in that order even when wires arrive late
 * (cross-publisher reordering) or out of order (history pages applying older
 * messages after newer ones).
 */

/** One wire message in a node's event log: a serial and its decoded events. */
export interface WireLogEntry<TEvent> {
  /** Ably channel serial of the wire message. */
  serial: string;
  /**
   * The wire's codec-message-id — the reducer routing key the events were
   * folded alongside; undefined when the wire carried none.
   */
  messageId: string | undefined;
  /**
   * The decoded events from this wire message's deliveries, in arrival order.
   * Same-serial deliveries (the create plus each append/update) extend the
   * entry, so the list accumulates across deliveries.
   */
  events: TEvent[];
}

/**
 * Record a wire message's decoded events in a node's event log, mutating `log`
 * in place, and return the index of the entry the events landed in. Events for
 * an already-logged serial are pushed onto that entry's `events` (arrival
 * order); otherwise a new entry is inserted at the position that keeps the log
 * ascending by serial (Ably serials order lexicographically).
 *
 * The returned index lets the caller decide how to fold: when it equals
 * `log.length - 1` the events extend the tail and fold incrementally in
 * canonical order; otherwise an earlier-serial wire arrived late and the node
 * must be refolded from the whole log.
 * @param log - The node's event log, ascending by serial. Mutated in place.
 * @param serial - The Ably channel serial of the wire message.
 * @param messageId - The wire's codec-message-id, or undefined.
 * @param events - The decoded events to record, in arrival order.
 * @returns The index of the entry the events were recorded into.
 */
export const recordWire = <TEvent>(
  log: WireLogEntry<TEvent>[],
  serial: string,
  messageId: string | undefined,
  events: TEvent[],
): number => {
  // Scan from the tail: live delivery appends at (or extends) the end, so the
  // match is almost always within the last entry or two.
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (!entry) break; // unreachable
    if (entry.serial === serial) {
      entry.events.push(...events);
      return i;
    }
    if (entry.serial < serial) {
      log.splice(i + 1, 0, { serial, messageId, events: [...events] });
      return i + 1;
    }
  }
  // Lower than every logged serial (or the log is empty): insert at the head.
  log.unshift({ serial, messageId, events: [...events] });
  return 0;
};
