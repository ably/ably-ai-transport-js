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
 * and what was thrown, so each caller reports it in its own terms. A pipe
 * reports it as `PipeFailed`. A caller's own `write` follows the Pub/Sub
 * message stream: it returns nothing, an event that cannot be written throws
 * at the call and the writer carries on, and a failure to get what was
 * written onto the channel stops the writer, which the next `write`, `flush`
 * and `close` report, so `flush` and `close` resolve only when nothing was
 * lost.
 *
 * `write` prepares the event and checks it at the call, then queues its
 * writes, which are made one event at a time in the order they were handed
 * over, so a caller that is called back with events faster than the channel
 * takes them needs no queue of its own. `flush` and `close` wait for the
 * writes already handed over, then for the channel to take what was written,
 * repairing what they must, and write nothing to end a stream that is
 * part-way through. A caller that carries a stream on in another process
 * closes the writer and gives the later events to a new one, which carries it
 * on; with the codec sink, in a new message, and a subscriber decodes the
 * same events either way.
 *
 * A stream stays open in the writer until the event that ends it is written,
 * so a later event under the same key appends to the same message. A caller
 * that abandons a stream, such as a turn cut off before its end event, closes
 * the writer before it writes a stream that reuses the key.
 */

import * as Ably from '@ably/pubsub-core';

import { ErrorCode, errorInfoIs } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { errorCause, errorMessage } from '../../utils.js';

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
   * Check the event against what the writes queued before it leave open, and
   * record what it leaves open in turn, so an event that cannot be written
   * after them is refused before it is queued. A pipe, which makes each
   * event's writes before it prepares the next, does not call it.
   * @throws {Ably.ErrorInfo} `InvalidArgument` when the event does not fit what the queued writes leave open.
   */
  reserve(): void;
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
  prepare(event: E, operation: 'pipe' | 'write event'): PreparedEvent;
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

/** What {@link EventWriter.flush} and {@link EventWriter.close} resolve with. */
export interface EventWriterResult {
  /**
   * The serial of the message the last event written landed on, as a
   * `pipeEach` loop would have handed it back: for a delta, the message the
   * stream's first delta opened. An event the codec kept off the channel
   * leaves it as it was, and it is `undefined` until an event has landed.
   */
  serial: string | undefined;
}

/**
 * Writes one caller's events on a channel, through the adaptor's codec, with
 * one key table for its life. Disposable, so `await using` closes it as
 * {@link EventWriter.close} does.
 * @template E - The codec's event union.
 */
export interface EventWriter<E> extends AsyncDisposable {
  /**
   * Hand over one event to be written. Returns without waiting for the
   * channel: the event is encoded and checked at the call, and its messages
   * are queued and written after the events handed over before it, in order.
   * Call {@link EventWriter.flush} to wait until it is on the channel and
   * learn the serial of the message it landed on. A failed append is repaired
   * before the event that ends its stream, or at the next `flush` or `close`.
   * A stream whose end event has not been written stays open for the writer's
   * life, so a later event under the same stream key appends to its message:
   * close the writer before reusing the key of a stream that was never ended.
   *
   * An event that cannot be written throws at the call, publishes nothing,
   * and leaves the writer running. A failure to get a write onto the channel
   * stops the writer: the events queued behind it are not written, nothing
   * more is published, and the next `write`, `flush` and `close` throw or
   * reject with it.
   * @param event - The event.
   * @throws {Ably.ErrorInfo} `InvalidArgument` when the event cannot be written as the codec encoded it: the codec could not encode it (an `InvalidArgument` the codec throws, as a `defineCodec` codec does, is passed on, and anything else is wrapped with it as `cause`), encoded a message without its `name` and `id`, encoded an update to a stream this writer has not opened, or a publish under a stream that is still open. Writing it again fails the same way. Once the writer has stopped, the error that stopped it: the channel's own error, as it threw it, when the channel refused a publish or update; `StreamedMessageFinalizeFailed` when a repair failed; `InternalError` when a publish's ack carried no serial. After `close` has been called, `StreamClosed`.
   */
  write(event: E): void;
  /**
   * Wait until everything written so far is on the channel, and keep the
   * writer open. The events handed over before the call are written first;
   * the writer then waits for the channel to acknowledge what it wrote and
   * repairs a stream whose append failed. Events handed over after the call
   * are written once it settles. Streams stay open, so a later delta carries
   * on the same stream. Once `flush` resolves, every event handed over before
   * it is on the channel, so a caller that records how far it has written
   * records it then. After `close` has been called, settles as `close` does.
   * @returns The serial of the message the last event written landed on.
   * @throws {Ably.ErrorInfo} The error that stopped the writer, whether a write stopped it before or this flush's repair fails (`StreamedMessageFinalizeFailed`, with the first repair failure as `cause`).
   */
  flush(): Promise<EventWriterResult>;
  /**
   * Stop the writer. It does what {@link EventWriter.flush} does, and then
   * refuses every later `write`. It ends no stream: subscribers see a stream
   * that was part-way through stay open, and a new writer given the stream's
   * later events carries it on, so a subscriber decodes the same events as
   * from one writer. Await `close` before writing through the new writer, or
   * its writes can reach the channel ahead of this one's. A decoder keeps its
   * record of a stream no writer ended, as it does for a cancelled pipe, for
   * as long as the decoder lives. A second call settles as the first did, its
   * failure included.
   * @returns As {@link EventWriter.flush}.
   * @throws {Ably.ErrorInfo} As {@link EventWriter.flush}.
   */
  close(): Promise<EventWriterResult>;
  /**
   * Close the writer as {@link EventWriter.close} does, for `await using`, so
   * the writer is closed however the block is left, and the error that
   * stopped it is thrown from the block's exit.
   * @throws {Ably.ErrorInfo} As {@link EventWriter.close}.
   */
  [Symbol.asyncDispose](): Promise<void>;
}

/** What an event writer takes beside its sink. */
export interface EventWriterOptions {
  /** Logger for the failures `write`, `flush` and `close` report. */
  logger?: Logger;
}

/**
 * The error a caller's own `write` throws for an event that could not be
 * prepared: the sink's own `InvalidArgument`, or anything else it threw
 * wrapped in one.
 * @param error - What preparing the event threw.
 * @returns The error.
 */
const encodeFailure = (error: unknown): Ably.ErrorInfo => {
  if (error instanceof Ably.ErrorInfo && errorInfoIs(error, ErrorCode.InvalidArgument)) return error;
  return new Ably.ErrorInfo(
    `unable to write event; the codec could not encode it: ${errorMessage(error)}`,
    ErrorCode.InvalidArgument,
    400,
    errorCause(error),
  );
};

/**
 * The error that stops a caller's own writer when one of an event's writes
 * failed: what was thrown, as it was thrown, so a channel's refusal reaches
 * the caller as the channel reported it, as the Pub/Sub message stream
 * reports it, and nothing has to tell the channel's errors from the sink's
 * own. Anything that is not an `Ably.ErrorInfo` is wrapped, so the writer
 * always reports one.
 * @param error - What the write threw.
 * @returns The error.
 */
const writeFailure = (error: unknown): Ably.ErrorInfo =>
  error instanceof Ably.ErrorInfo
    ? error
    : new Ably.ErrorInfo(`unable to write event; ${errorMessage(error)}`, ErrorCode.InternalError, 500);

/**
 * A repair failure as the error it is: a sink only throws `Ably.ErrorInfo`,
 * and anything else is wrapped so the writer always reports one.
 * @param error - What the repair threw.
 * @returns The error.
 */
const asErrorInfo = (error: unknown): Ably.ErrorInfo =>
  error instanceof Ably.ErrorInfo
    ? error
    : new Ably.ErrorInfo(
        `unable to repair stream; ${errorMessage(error)}`,
        ErrorCode.StreamedMessageFinalizeFailed,
        500,
      );

/**
 * The event writer. A pipe driver holds the class, for {@link DefaultEventWriter.attempt}
 * and {@link DefaultEventWriter.lastPublishSerial}; a caller of `newWriter`
 * holds it as an {@link EventWriter}.
 * @template E - The codec's event union.
 */
export class DefaultEventWriter<E> implements EventWriter<E> {
  private readonly _sink: EventSink<E>;
  private readonly _logger: Logger | undefined;
  private _lastPublishSerial: string | undefined;
  /** Settles when the last write handed over has settled, and never rejects. */
  private _lastWrite: Promise<void> = Promise.resolve();
  private _closing: Promise<EventWriterResult> | undefined;
  /** The failure that stopped the writer, which every later call reports. */
  private _stopped: Ably.ErrorInfo | undefined;
  /** The serial of the message the last event written landed on. */
  private _lastSerial: string | undefined;

  constructor(sink: EventSink<E>, options: EventWriterOptions = {}) {
    this._sink = sink;
    this._logger = options.logger?.withContext({ component: 'EventWriter' });
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
  async attempt(event: E, operation: 'pipe' | 'write event'): Promise<Attempt<E>> {
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

  write(event: E): void {
    this._logger?.trace('DefaultEventWriter.write();');
    if (this._stopped !== undefined) throw this._stopped;
    if (this._closing !== undefined) {
      this._logger?.error('DefaultEventWriter.write(); the writer is closed');
      throw new Ably.ErrorInfo('unable to write event; the writer is closed', ErrorCode.StreamClosed, 400);
    }
    let prepared;
    try {
      prepared = this._sink.prepare(event, 'write event');
      prepared.reserve();
    } catch (error) {
      const failure = encodeFailure(error);
      // The error names no event content, so it is logged as it is.
      this._logger?.error('DefaultEventWriter.write(); the event cannot be written', { error: failure.message });
      throw failure;
    }
    this._lastWrite = this._writeAfter(this._lastWrite, prepared);
  }

  async flush(): Promise<EventWriterResult> {
    this._logger?.trace('DefaultEventWriter.flush();');
    if (this._closing !== undefined) return this._closing;
    // Chained like a write, so writes handed over after it wait for it.
    const flushed = this._drainAfter(this._lastWrite, 'flush');
    this._lastWrite = this._quietly(flushed);
    return flushed;
  }

  async close(): Promise<EventWriterResult> {
    this._logger?.trace('DefaultEventWriter.close();');
    this._closing ??= this._drainAfter(this._lastWrite, 'close');
    return this._closing;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /**
   * Wait for the writes made so far to be acknowledged, and repair what did
   * not land.
   * @throws {Ably.ErrorInfo} `StreamedMessageFinalizeFailed` when a repair fails, with the first repair failure as `cause`.
   */
  async drain(): Promise<void> {
    await this._sink.flush();
  }

  private async _writeAfter(previous: Promise<void>, prepared: PreparedEvent): Promise<void> {
    await previous;
    // An event queued behind the one that stopped the writer is not written.
    if (this._stopped !== undefined) return;
    const outcome = await prepared.write();
    if (outcome.ok) {
      if (outcome.serial !== undefined) this._lastSerial = outcome.serial;
      if (outcome.publishedSerial !== undefined) this._lastPublishSerial = outcome.publishedSerial;
      return;
    }
    this._stopped = writeFailure(outcome.error);
    // The error names no event content, so it is logged as it is.
    this._logger?.error('DefaultEventWriter.write(); write failed, the writer has stopped', {
      error: this._stopped.message,
    });
  }

  /**
   * Wait for a flush to settle, whichever way. Its own promise carries its
   * failure to its caller.
   * @param settling - The flush.
   */
  private async _quietly(settling: Promise<unknown>): Promise<void> {
    try {
      await settling;
    } catch {
      // Reported by the promise's own caller.
    }
  }

  private async _drainAfter(previous: Promise<void>, method: 'flush' | 'close'): Promise<EventWriterResult> {
    await previous;
    if (this._stopped !== undefined) throw this._stopped;
    try {
      await this.drain();
    } catch (error) {
      const failure = asErrorInfo(error);
      this._stopped = failure;
      this._logger?.error(`DefaultEventWriter.${method}(); repair failed, the writer has stopped`, {
        error: failure.message,
      });
      throw failure;
    }
    const result = { serial: this._lastSerial };
    this._logger?.debug(`DefaultEventWriter.${method}(); done`, result);
    return result;
  }
}

/**
 * Create an event writer over a sink.
 * @param sink - Where the writer writes.
 * @param options - The logger.
 * @returns The writer.
 */
export const createEventWriter = <E>(sink: EventSink<E>, options?: EventWriterOptions): DefaultEventWriter<E> =>
  new DefaultEventWriter(sink, options);
