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
 *
 * {@link WireLog} encapsulates the entry list and all of its mutation: the
 * caller hands it a wire and is told only how to fold (see {@link WireLogFold}).
 */

/** One wire message in a node's event log: a serial and its decoded events. */
interface WireLogEntry<TEvent> {
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

/** How a {@link WireLog.record} call tells the caller to fold the wire's events. */
export type WireLogFold =
  /**
   * The version guard rejected a re-delivery the log already incorporated — a
   * whole-wire replay, or a newer version of a non-streamed wire (an edited
   * discrete). Nothing was recorded; fold nothing.
   */
  | 'dropped'
  /**
   * The events extend the log tail (in-order delivery) or landed on a swept
   * log; fold them onto the node's existing projection.
   */
  | 'incremental'
  /**
   * An earlier-serial wire arrived late, so incremental folding would corrupt
   * serial order; rebuild the projection from the whole log via {@link replay}.
   */
  | 'refold';

/**
 * A node's event log: one entry per wire-message serial, kept ascending by
 * serial, each accumulating that serial's decoded events in arrival order.
 */
export class WireLog<TEvent> {
  private readonly _entries: WireLogEntry<TEvent>[] = [];
  private _swept = false;

  /**
   * Whether the retention sweep has dropped this log's decoded payloads. A
   * swept log keeps each entry's replay key (serial + `decodedThrough`) so it
   * still recognises whole-wire replays, but it can no longer be refolded.
   * @returns True once {@link sweep} has run.
   */
  get swept(): boolean {
    return this._swept;
  }

  /**
   * Record a wire message's decoded events and report how to fold them.
   *
   * Events for an already-logged serial are guarded by the entry's
   * `decodedThrough` version before being recorded; a new serial is inserted
   * at the position that keeps the log ascending by serial (Ably serials order
   * lexicographically). The version guard fires only for deliveries carrying
   * an explicit `version.serial`: in-contract mutations always do, while a
   * version-less delivery records unguarded (and never advances
   * `decodedThrough`), matching the decoder's convention.
   *
   * On a swept log the payload is not retained (only the replay key is), so
   * the fold is never `refold` — a genuinely-new wire there is outside the
   * reorder window and folds incrementally in arrival order.
   * @param serial - The Ably channel serial of the wire message.
   * @param messageId - The wire's codec-message-id, or undefined.
   * @param events - The decoded events to record, in arrival order.
   * @param version - The delivery's `Message.version.serial`, or undefined
   *   when the delivery carried none (guard disabled for this delivery).
   * @param streamed - Whether the delivery is part of a streamed wire; a
   *   guarded newer delivery for a non-streamed wire is an edited discrete and
   *   is dropped.
   * @returns How the caller should fold the events.
   */
  record(
    serial: string,
    messageId: string | undefined,
    events: TEvent[],
    version: string | undefined,
    streamed: boolean,
  ): WireLogFold {
    // A swept log retains replay keys but not payloads: record an empty event
    // list so the key advances while nothing is stored. The caller folds the
    // events it already holds.
    const index = this._recordEntry(serial, messageId, this._swept ? [] : events, version, streamed);
    if (index === undefined) return 'dropped';
    if (this._swept) return 'incremental';
    return index === this._entries.length - 1 ? 'incremental' : 'refold';
  }

  /**
   * Replay every recorded event in canonical order — wire messages ascending
   * by serial, events within a wire in arrival order — each with its wire's
   * routing metadata, for a refold.
   * @param visit - Called once per event, in canonical order.
   */
  replay(visit: (event: TEvent, serial: string, messageId: string | undefined) => void): void {
    for (const entry of this._entries) {
      for (const event of entry.events) visit(event, entry.serial, entry.messageId);
    }
  }

  /**
   * Drop the decoded payloads (the unbounded cost) but keep each entry's
   * replay key, so a post-sweep whole-wire replay is still recognised and
   * dropped rather than re-folded. The log becomes {@link swept}; a refold can
   * no longer rebuild the dropped events, which `swept` reflects.
   */
  sweep(): void {
    this._swept = true;
    for (const entry of this._entries) entry.events.length = 0;
  }

  /**
   * Insert or extend the entry for `serial`, guarding replays by version.
   * @param serial - The Ably channel serial of the wire message.
   * @param messageId - The wire's codec-message-id, or undefined.
   * @param events - The decoded events to store (empty on a swept log).
   * @param version - The delivery's `Message.version.serial`, or undefined.
   * @param streamed - Whether the delivery is part of a streamed wire.
   * @returns The index of the entry the events landed in, or `undefined` when
   *   the version guard dropped the delivery.
   */
  private _recordEntry(
    serial: string,
    messageId: string | undefined,
    events: TEvent[],
    version: string | undefined,
    streamed: boolean,
  ): number | undefined {
    // Scan from the tail: live delivery appends at (or extends) the end, so the
    // match is almost always within the last entry or two.
    for (let i = this._entries.length - 1; i >= 0; i--) {
      const entry = this._entries[i];
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
        this._entries.splice(i + 1, 0, { serial, messageId, events: [...events], decodedThrough: version ?? serial });
        return i + 1;
      }
    }
    // Lower than every logged serial (or the log is empty): insert at the head.
    this._entries.unshift({ serial, messageId, events: [...events], decodedThrough: version ?? serial });
    return 0;
  }
}
