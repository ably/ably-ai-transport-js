/**
 * Event writer — the step every stream write shares, and the state it keeps.
 *
 * It writes events into a sink, which turns each event into channel writes:
 * today the codec sink (`codec-sink.ts`), which encodes through the codec and
 * writes through a pipe writer's key table. The writer itself knows nothing
 * of a codec, its stream keys or the markers a decoder reads, so the same
 * writer serves a sink of another kind. Both pipe drivers are loops over an
 * event writer (`pipe-stream.ts`), so there is one copy of that step.
 *
 * A failure comes back from the step as a value, with the step it happened at
 * and what was thrown, rather than as an error, so each caller reports it in
 * its own terms: a pipe reports it as `PipeFailed`, as it always has.
 */

/**
 * One event, once it is written: what a `pipeEach` loop is handed.
 * @template E - The codec's event union.
 */
export interface Published<E> {
  /** The event, as the caller or the source produced it. */
  event: E;
  /**
   * The serial of the message the event landed on: a publish's ack serial,
   * and for an append or an update, the serial of the stream's message. When
   * the codec encoded the event to several messages, the last one's; when it
   * encoded the event to none, `undefined`.
   */
  serial: string | undefined;
}

/** What writing one prepared event came to. */
export type SinkOutcome =
  | {
      /** Every write the event needed was made. */
      ok: true;
      /** The serial of the message the event's last write landed on, or `undefined` when it needed none. */
      serial: string | undefined;
      /** The ack serial of the event's last publish, or `undefined` when it published nothing. */
      publishedSerial: string | undefined;
    }
  | {
      /** A write failed; the writes before it stay on the channel. */
      ok: false;
      /** The write that failed: one that publishes, or one that updates. */
      failed: 'publish' | 'update';
      /** What it threw, unwrapped. */
      error: unknown;
    };

/** One event a sink has turned into writes, not yet made. */
export interface PreparedEvent {
  /**
   * Make the event's writes, in order.
   * @returns What they came to. Never rejects.
   */
  write(): Promise<SinkOutcome>;
}

/** Where an event writer writes: what turns each event into channel writes. */
export interface EventSink<E> {
  /**
   * Turn an event into the writes it needs, without making them.
   * @param event - The event.
   * @param operation - The call the write serves, named in its errors.
   * @returns The prepared event.
   * @throws When the event cannot be written as the sink would write it.
   */
  prepare(event: E, operation: 'pipe'): PreparedEvent;
  /**
   * Wait for the writes made so far to be acknowledged, and repair what did
   * not land.
   * @throws {Ably.ErrorInfo} `StreamedMessageFinalizeFailed` when a repair fails, with the first repair failure as `cause`.
   */
  flush(): Promise<void>;
}

/**
 * What writing one event came to.
 * @template E - The codec's event union.
 */
export type Attempt<E> =
  | {
      /** The event was written. */
      ok: true;
      /** The event, with the serial its last write landed on. */
      written: Published<E>;
    }
  | {
      /** The event was not written, or not all of its writes were made. */
      ok: false;
      /** The step that failed: preparing the event, or a write that publishes or updates. */
      failed: 'encode' | 'publish' | 'update';
      /** What the step threw, unwrapped. */
      error: unknown;
    };

/**
 * Writes events into a sink. Only a pipe driver holds one.
 * @template E - The codec's event union.
 */
export class DefaultEventWriter<E> {
  private readonly _sink: EventSink<E>;
  private _lastPublishSerial: string | undefined;

  constructor(sink: EventSink<E>) {
    this._sink = sink;
  }

  /**
   * The ack serial of the last publish the writer made, the publish that
   * opens a stream included, or `undefined` when it has published nothing.
   * It is what `pipe` resolves with, and differs from the serial the last
   * event landed on when that event appended to an earlier message.
   * @returns The serial.
   */
  get lastPublishSerial(): string | undefined {
    return this._lastPublishSerial;
  }

  /**
   * Prepare one event and make its writes. Never rejects: a failure is
   * returned with the step it happened at.
   * @param event - The event.
   * @param operation - The call the write serves, named in the errors of a sink.
   * @returns The event with the serial its last write landed on, or the failure.
   */
  async attempt(event: E, operation: 'pipe'): Promise<Attempt<E>> {
    let prepared;
    try {
      prepared = this._sink.prepare(event, operation);
    } catch (error) {
      return { ok: false, failed: 'encode', error };
    }
    const outcome = await prepared.write();
    if (!outcome.ok) return outcome;
    if (outcome.publishedSerial !== undefined) this._lastPublishSerial = outcome.publishedSerial;
    return { ok: true, written: { event, serial: outcome.serial } };
  }

  /**
   * Wait for the writes made so far to be acknowledged, and repair what did
   * not land.
   * @throws {Ably.ErrorInfo} `StreamedMessageFinalizeFailed` when a repair fails, with the first repair failure as `cause`.
   */
  async drain(): Promise<void> {
    await this._sink.flush();
  }
}

/**
 * Create an event writer over a sink.
 * @param sink - Where the writer writes.
 * @returns The writer.
 */
export const createEventWriter = <E>(sink: EventSink<E>): DefaultEventWriter<E> => new DefaultEventWriter(sink);
