/**
 * Event writer — the one thing that writes a stream of events to a channel.
 *
 * It is handed events one `write` at a time and says when each is written by
 * resolving. For each it runs the step every stream write shares: encode the
 * event, check what the codec wrote, add the headers, and write each message
 * through a pipe writer, whose key table it keeps for its life, so a stream
 * opened by one `write` is appended to by the next. Both pipe drivers are
 * loops over an event writer (`pipe-stream.ts`), so a piped event and a
 * written one take the same path.
 *
 * Writes are made one at a time, in the order they were handed over: a
 * `write` called while another is in progress waits behind it. A caller that
 * is called back with events faster than it can wait therefore needs no queue
 * of its own. A write that fails rejects and nothing else: the writer keeps
 * no failure, and the writes behind it are still made, so the caller decides
 * whether to stop. A pipe driver stops at the first.
 *
 * A stream stays open in the key table until the event that ends it is
 * written, so a later event under the same key appends to the same message.
 * A caller that abandons a stream, such as a turn cut off before its end
 * event, closes the writer before it writes a stream that reuses the key.
 *
 * `close` drains the writes already handed over, then flushes and repairs
 * what was written, and writes nothing to end a stream that is part-way
 * through. A caller that records its own progress, such as a relay that
 * checkpoints an offset, closes the writer and gives the events after that
 * point to a new one. The new writer has no key table to carry on from, so a
 * delta for a stream the closed writer began publishes a new message, and the
 * stream's text is then held in more than one message. A subscriber decodes
 * the same events either way.
 */

import * as Ably from '@ably/pubsub-core';

import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { errorCause, errorMessage } from '../../utils.js';
import type { Codec } from '../codec/codec.js';
import { assertCodecWrote } from './codec-fields.js';
import { type MessageHeaders, withHeaders } from './headers.js';
import type { PipeWriter } from './pipe-writer.js';

/**
 * One event, once it is written: what a `pipeEach` loop is handed and what an
 * event writer's `write` resolves with.
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

/** How much of a failing event the error message quotes. */
const EVENT_EXCERPT_LENGTH = 200;

/**
 * A short JSON rendering of an event for an error message.
 * @param event - The event.
 * @returns The excerpt.
 */
const excerpt = (event: unknown): string => {
  let text: string;
  try {
    text = JSON.stringify(event);
  } catch {
    text = String(event);
  }
  return text.length > EVENT_EXCERPT_LENGTH ? `${text.slice(0, EVENT_EXCERPT_LENGTH)}…` : text;
};

/**
 * The error for a pipe or an event writer that could not finish what it was
 * asked: `PipeFailed`, with the failure as `cause`.
 * @param operation - What could not be done, for the error message.
 * @param what - The step that failed.
 * @param error - The failure.
 * @param event - The event being written, quoted in the message.
 * @returns The error.
 */
export const pipeFailedError = (
  operation: 'pipe' | 'write event' | 'close writer',
  what: string,
  error: unknown,
  event?: unknown,
): Ably.ErrorInfo =>
  new Ably.ErrorInfo(
    event === undefined
      ? `unable to ${operation}; ${what}: ${errorMessage(error)}`
      : `unable to ${operation}; ${what} for event ${excerpt(event)}: ${errorMessage(error)}`,
    ErrorCode.PipeFailed,
    500,
    errorCause(error),
  );

/**
 * Writes one caller's events on a channel, through the adaptor's codec, with
 * one key table for its life.
 * @template E - The codec's event union.
 */
export interface EventWriter<E> {
  /**
   * Encode one event and write its messages in order. Resolves as a
   * `pipeEach` loop hands the event back: a publish once acked, an append to
   * an open stream at once, before its ack. A `write` called before an
   * earlier one has settled is held and made after it, so events are written
   * in the order they were handed over. A failed append is repaired before
   * the event that ends its stream, and a failed repair rejects that event's
   * `write`, which is then not published; writing that event again, or
   * closing, repairs the stream again. A rejected `write` leaves the writer
   * open: later writes, and writes already held, are still made. A stream
   * whose end event has not been written stays open for the writer's life, so
   * a later event under the same stream key appends to its message: close the
   * writer before reusing the key of a stream that was never ended.
   * @param event - The event.
   * @returns The event, with the serial of the message it landed on: for an append, the message this writer's first delta of the stream opened; `undefined` when the codec published nothing.
   * @throws {Ably.ErrorInfo} `StreamClosed` when `close` has been called, publishing nothing; `PipeFailed` when the codec cannot encode the event or encodes a message without its `name` and `id`, a publish or update fails, the event updates a stream this writer did not open, or a repair fails, with the failure as `cause`.
   */
  write(event: E): Promise<Published<E>>;
  /**
   * Stop the writer. Writes handed over before the call are made first, in
   * order; a `write` after it is refused. The writer then flushes and repairs
   * what it wrote, so once `close` resolves every write that resolved is
   * acknowledged on the channel. A caller that records how far it has written
   * records it after `close` resolves, not after a `write` does, since a
   * delta's `write` resolves before its acknowledgement. It ends no stream:
   * subscribers see a stream that was part-way through stay open, and a new
   * writer given the stream's later events carries it on in a new message.
   * Await `close` before writing through the new writer, or its messages can
   * reach the channel ahead of this one's. A decoder keeps its record of a
   * message no writer ended, as it does for a cancelled pipe, for as long as
   * the decoder lives. A call made while a close is in progress resolves when
   * that close settles, and a call after it resolves at once; neither repeats
   * its failure.
   * @throws {Ably.ErrorInfo} `PipeFailed` when a repair fails, with the failure as `cause`: the channel is missing text of a stream the writer did not end.
   */
  close(): Promise<void>;
}

/** What an event writer takes beside its codec and pipe writer. */
export interface EventWriterOptions {
  /** The headers added to every message before it reaches the pipe writer, so a repair carries them too. Already checked by the caller. */
  headers: MessageHeaders | undefined;
  /** Logger for diagnostics. */
  logger: Logger | undefined;
}

/**
 * The event writer. A pipe driver holds the class, since it reads
 * {@link DefaultEventWriter.lastPublishSerial}; every other holder has it as
 * an {@link EventWriter}.
 * @template E - The codec's event union.
 */
export class DefaultEventWriter<E> implements EventWriter<E> {
  private readonly _codec: Codec<E>;
  private readonly _writer: PipeWriter;
  private readonly _headers: MessageHeaders | undefined;
  private readonly _logger: Logger | undefined;
  /** Settles when the last write handed over has settled, and never rejects. */
  private _lastWrite: Promise<void> = Promise.resolve();
  private _closing: Promise<void> | undefined;
  private _lastPublishSerial: string | undefined;

  constructor(codec: Codec<E>, writer: PipeWriter, options: EventWriterOptions) {
    this._codec = codec;
    this._writer = writer;
    this._headers = options.headers;
    this._logger = options.logger?.withContext({ component: 'EventWriter' });
  }

  /**
   * The ack serial of the last publish the writer made, the publish that
   * opens an append key included, or `undefined` when it has published
   * nothing. It is what `pipe` resolves with, and differs from the serial the
   * last `write` reported when that event appended to an earlier message.
   * @returns The serial.
   */
  get lastPublishSerial(): string | undefined {
    return this._lastPublishSerial;
  }

  async write(event: E): Promise<Published<E>> {
    this._logger?.trace('DefaultEventWriter.write();');
    if (this._closing !== undefined) {
      this._logger?.error('DefaultEventWriter.write(); the writer is closed');
      throw new Ably.ErrorInfo('unable to write event; the writer is closed', ErrorCode.StreamClosed, 400);
    }
    // The write is chained onto `_lastWrite` with no await before it, so
    // writes queue in the order they were called.
    const written = this._writeAfter(this._lastWrite, event);
    this._lastWrite = this._settled(written);
    return written;
  }

  async close(): Promise<void> {
    this._logger?.trace('DefaultEventWriter.close();');
    if (this._closing !== undefined) {
      try {
        await this._closing;
      } catch {
        // The first close reported this failure to its own caller.
      }
      return;
    }
    this._closing = this._flushAfter(this._lastWrite);
    await this._closing;
    this._logger?.debug('DefaultEventWriter.close(); closed');
  }

  private async _writeAfter(previous: Promise<void>, event: E): Promise<Published<E>> {
    await previous;
    return this._write(event);
  }

  /**
   * Encode one event and write its messages in order, each with the writer's
   * headers.
   * @param event - The event.
   * @returns The event, with the serial its last message landed on.
   * @throws {Ably.ErrorInfo} `PipeFailed` when the encode or a write failed, with the failure as `cause`.
   */
  private async _write(event: E): Promise<Published<E>> {
    let encoded;
    try {
      encoded = this._codec.encode(event);
      for (const { message } of encoded) assertCodecWrote(message, this._codec, 'write event');
    } catch (error) {
      // The thrown error quotes the event; the log carries only the cause.
      this._logger?.error('DefaultEventWriter.write(); encode failed', { error: errorMessage(error) });
      throw pipeFailedError('write event', 'encode failed', error, event);
    }
    let serial: string | undefined;
    try {
      for (const encodedMessage of encoded) {
        const { message: encodedBody } = encodedMessage;
        const message = this._headers === undefined ? encodedBody : withHeaders(encodedBody, this._headers);
        const result = await this._writer.write({ ...encodedMessage, message });
        serial = result.serial;
        if (result.published) this._lastPublishSerial = result.serial;
      }
    } catch (error) {
      this._logger?.error('DefaultEventWriter.write(); write failed', { error: errorMessage(error) });
      throw pipeFailedError('write event', 'write failed', error, event);
    }
    return { event, serial };
  }

  /**
   * Wait for a write to settle, whichever way. The write's own promise carries
   * its failure to the caller of `write`.
   * @param written - The write.
   */
  private async _settled(written: Promise<Published<E>>): Promise<void> {
    try {
      await written;
    } catch {
      // Reported by the write's own promise.
    }
  }

  private async _flushAfter(lastWrite: Promise<void>): Promise<void> {
    await lastWrite;
    try {
      await this._writer.flush();
    } catch (error) {
      const failure = pipeFailedError('close writer', 'repair failed', error);
      this._logger?.error('DefaultEventWriter.close(); repair failed', { error: failure.message });
      throw failure;
    }
  }
}

/**
 * Create an event writer over a codec and a pipe writer.
 * @param codec - The codec.
 * @param writer - The pipe writer, holding the key table.
 * @param options - The writer's headers and the logger.
 * @returns The writer.
 */
export const createEventWriter = <E>(
  codec: Codec<E>,
  writer: PipeWriter,
  options: EventWriterOptions,
): DefaultEventWriter<E> => new DefaultEventWriter(codec, writer, options);
