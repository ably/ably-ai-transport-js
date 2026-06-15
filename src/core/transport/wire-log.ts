/**
 * Per-node event log.
 *
 * Each node retains the decoded events it was folded from, grouped by
 * wire-message serial and ordered ascending by serial. The log captures
 * canonical serial order regardless of delivery order, so a node's event
 * sequence can be re-derived in that order even when wires arrive late
 * (cross-publisher reordering) or out of order (history pages applying older
 * messages after newer ones).
 *
 * Within one serial, deliveries are sequenced by `Message.version.serial`
 * (lexicographically ordered per mutation — platform guarantee): each entry
 * records the highest version decoded into it, so a delivery the entry has
 * already incorporated — a whole-wire replay from a second hydration, a
 * remount, or an agent re-walk — is recognised and dropped at the transport.
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
  /**
   * The highest `Message.version.serial` decoded into this entry. Versions
   * are lexicographically comparable within one serial, so a delivery at or
   * below this value is already incorporated and must not fold again. In
   * practice every delivery carries a version (a never-mutated message's
   * version serial equals its serial); the message serial is used as the floor
   * only as a defensive fallback for the type-optional absent case.
   */
  decodedThrough: string;
}

/**
 * Record a wire message's decoded events in a node's event log, mutating `log`
 * in place. Events for an already-logged serial are guarded by the entry's
 * `decodedThrough` version before being pushed onto its `events` (arrival
 * order); a new serial is inserted at the position that keeps the log
 * ascending by serial (Ably serials order lexicographically).
 *
 * The version guard fires only for deliveries carrying an explicit
 * `version.serial`: in-contract mutations always do, while a version-less
 * delivery records unguarded (and never advances `decodedThrough`), matching
 * the decoder's convention. A re-delivery the entry has already incorporated
 * — a whole-wire replay (version at or below `decodedThrough`) or a newer
 * version of a non-streamed wire (an edited discrete, whose propagation is
 * out of scope) — is dropped without recording.
 *
 * Returns the index of the entry the events landed in, or `undefined` when
 * the version guard dropped the delivery (do not fold). When the returned
 * index equals `log.length - 1` the events extend the tail and fold
 * incrementally in canonical order; otherwise an earlier-serial wire arrived
 * late and the node must be refolded from the whole log.
 * @param log - The node's event log, ascending by serial. Mutated in place.
 * @param serial - The Ably channel serial of the wire message.
 * @param messageId - The wire's codec-message-id, or undefined.
 * @param events - The decoded events to record, in arrival order.
 * @param version - The delivery's `Message.version.serial`, or undefined when
 *   the delivery carried none (guard disabled for this delivery).
 * @param streamed - Whether the delivery is part of a streamed wire (the
 *   `stream` transport header); a guarded newer delivery for a non-streamed
 *   wire is an edited discrete and is dropped.
 * @returns The index the events were recorded at, or `undefined` if dropped.
 */
export const recordWire = <TEvent>(
  log: WireLogEntry<TEvent>[],
  serial: string,
  messageId: string | undefined,
  events: TEvent[],
  version: string | undefined,
  streamed: boolean,
): number | undefined => {
  // Scan from the tail: live delivery appends at (or extends) the end, so the
  // match is almost always within the last entry or two.
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (!entry) break; // unreachable
    if (entry.serial === serial) {
      // Version guard: drop a re-delivery the entry already incorporated — a
      // replay (version at or below the high-water-mark) or an edit to a
      // discrete (a newer version of a non-streamed wire, not propagated).
      if (version !== undefined && (version <= entry.decodedThrough || !streamed)) {
        return undefined;
      }
      entry.events.push(...events);
      if (version !== undefined) entry.decodedThrough = version;
      return i;
    }
    if (entry.serial < serial) {
      log.splice(i + 1, 0, { serial, messageId, events: [...events], decodedThrough: version ?? serial });
      return i + 1;
    }
  }
  // Lower than every logged serial (or the log is empty): insert at the head.
  log.unshift({ serial, messageId, events: [...events], decodedThrough: version ?? serial });
  return 0;
};
