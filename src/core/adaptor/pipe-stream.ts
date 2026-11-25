/**
 * The pipe drivers: read a source of events and write each one through an
 * event writer, which they are handed and drain when they stop. A pipe is
 * therefore a loop over an event writer: `pipeEach` hands each event back as
 * it is written, and `pipeStream` is `pipeEach` run to its end. What a driver
 * adds to the writer is the source (pulling it, racing each pull against the
 * signal, releasing it) and how a pipe ends.
 *
 * `pipeStream` resolves when its source ends, with the serial of its last
 * publish, and rejects otherwise: `OperationCancelled` when the signal fires, and
 * `PipeFailed` when the source throws, the codec cannot encode an event, a
 * publish or update fails, or a repair fails. A failed append does not end the
 * pipe: the writer repairs it when the stream ends, and a failed repair is what
 * rejects. On every exit, cancel included, the source is released and the
 * writer drained before the pipe settles, so a provider's generator can clean
 * up.
 */

import * as Ably from '@ably/pubsub-core';

import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { errorCause, errorMessage } from '../../utils.js';
import type { DefaultEventWriter, Published } from './event-writer.js';

/**
 * What `pipe` reads: a `ReadableStream` or any `AsyncIterable` of events. A
 * provider SDK stream that is async-iterable pipes in directly. The pipe pulls
 * one event at a time and releases the source when it ends, is cancelled or
 * errors: it releases a stream reader's lock, or calls an iterator's
 * `return()`. A `return()` that throws or rejects is logged at warn and is
 * never the pipe's outcome. Releasing a `ReadableStream` does not cancel it:
 * a pipe that stops early leaves the stream's producer, such as a model call,
 * running, and stopping it is the caller's job, for example by aborting the
 * model call with the same signal.
 * @template E - The codec's event union.
 */
export type PipeSource<E> = ReadableStream<E> | AsyncIterable<E>;

/** What a pipe resolves with once its source has ended and everything it wrote is on the channel. */
export interface PipeResult {
  /**
   * The ack serial of the last publish the pipe made, including the publish
   * that opens an append key, or `undefined` when it published nothing. It is
   * the newest message the pipe created, so the latest point in channel order
   * it wrote: a client that rewinds to it misses nothing the pipe published
   * before it. It is not always the message the last event landed on, which
   * is an earlier one when that event appended to or updated a stream opened
   * before the last publish; `pipeEach` hands that serial back with each
   * event.
   */
  lastPublishSerial: string | undefined;
  /**
   * The same value as {@link PipeResult.lastPublishSerial}.
   * @deprecated Use {@link PipeResult.lastPublishSerial}. Everywhere else in
   * the SDK `serial` is the message an event landed on, which this is not.
   */
  serial: string | undefined;
}

/** One pull from a normalized source: an event, or the terminal marker. */
type PullResult<E> = { done: false; value: E } | { done: true; value?: E };

/** A minimal pull-reader over either source shape. */
interface Puller<E> {
  read(): Promise<PullResult<E>>;
  release(): void;
}

/**
 * Normalize a source to a pull-reader. A `ReadableStream` is read through its
 * reader; any other source is driven through its async iterator, whose
 * `return()` is called on release for best-effort upstream teardown. A
 * `return()` that throws or rejects is logged at warn, never surfaced.
 * @param source - The stream or async-iterable to consume.
 * @param logger - Logger for the teardown warning.
 * @returns A pull-reader that yields events and tears the source down on release.
 */
const toPuller = <E>(source: PipeSource<E>, logger?: Logger): Puller<E> => {
  if ('getReader' in source) {
    const reader = source.getReader();
    return {
      read: reader.read.bind(reader),
      release: () => {
        reader.releaseLock();
      },
    };
  }
  const iterator = source[Symbol.asyncIterator]();
  const warnReturnFailed = (error: unknown): void => {
    logger?.warn('pipeEach(); source return() failed', { error: errorMessage(error) });
  };
  return {
    read: async () => {
      const result = await iterator.next();
      return result.done ? { done: true } : { done: false, value: result.value };
    },
    release: () => {
      // Best-effort teardown. The pipe has settled its outcome before this
      // runs, so a source whose return() fails is logged here and never
      // becomes the pipe's rejection; the .catch is where that failure surfaces.
      try {
        iterator.return?.().catch(warnReturnFailed);
      } catch (error) {
        warnReturnFailed(error);
      }
    },
  };
};

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
 * The error for a pipe that could not finish: `PipeFailed`, with the failure
 * as `cause`.
 * @param what - The step that failed.
 * @param error - The failure.
 * @param event - The event being written, quoted in the message.
 * @returns The error.
 */
const pipeFailed = (what: string, error: unknown, event?: unknown): Ably.ErrorInfo =>
  new Ably.ErrorInfo(
    event === undefined
      ? `unable to pipe; ${what}: ${errorMessage(error)}`
      : `unable to pipe; ${what} for event ${excerpt(event)}: ${errorMessage(error)}`,
    ErrorCode.PipeFailed,
    500,
    errorCause(error),
  );

const cancelledError = (): Ably.ErrorInfo =>
  new Ably.ErrorInfo('unable to pipe; cancelled by signal', ErrorCode.OperationCancelled, 400);

/** What a pipe driver takes beside its source and event writer. */
export interface PipeStreamOptions {
  /** Fires to cancel the pipe. */
  signal?: AbortSignal;
  /** Logger for diagnostics. */
  logger?: Logger;
}

/**
 * Pull the next event, or report that the signal fired first. A signal that
 * has already fired wins before the read, so a cancelled pipe writes nothing
 * more even when the source has an event ready. With no signal there is
 * nothing to race. With one, each pull races a promise of its own and removes
 * its listener once the race settles, so nothing outlives the pull: a promise
 * shared across pulls would gain a reaction per pull and, while the signal
 * never fires, hold every pulled event until the pipe ends.
 * @param puller - The source.
 * @param signal - The pipe's signal.
 * @returns The pull, or `'cancelled'`.
 */
const pullNext = async <E>(
  puller: Puller<E>,
  signal: AbortSignal | undefined,
): Promise<PullResult<E> | 'cancelled'> => {
  if (signal === undefined) return puller.read();
  if (signal.aborted) return 'cancelled';
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<'cancelled'>((resolve) => {
    onAbort = () => {
      resolve('cancelled');
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([puller.read(), cancelled]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
};

/**
 * Pipe a source of events through an event writer, handing each event back
 * once it is written. The source is read only when the consumer asks for the
 * next event, so the loop body sets the pace. An event's messages are written
 * as a unit; the signal is read again before the next event, not between
 * them.
 *
 * A publish is yielded once acked; an append to an open stream is yielded at
 * once, before its ack. A failed append is not reported where it was
 * yielded: the writer repairs the stream before the event that ends it, and
 * a failed repair throws from that event, which is never yielded.
 *
 * Every exit releases the source and then drains the writer, which repairs
 * what the pipe wrote: the source ending, the pipe failing (the
 * source throws, an event cannot be encoded, a write fails), the signal, and
 * a `break`, a `return` or a throw in the loop body. A stop writes nothing
 * more and ends no open stream, so a subscriber sees those streams stay open.
 * A failure stays the pipe's error, and a repair that also fails after it is
 * logged. Otherwise a failed repair is thrown, cancelled or not: the caller
 * that cancelled knows it did, and what it does not know is that the channel
 * is missing text. The signal throws `OperationCancelled` once the repair is
 * done. After a `break` or a `return` a failed repair is thrown from the
 * loop's exit; after a throw in the loop body JavaScript keeps the body's
 * error, so the repair failure is only logged. A `ReadableStream` is
 * released, not cancelled: its producer keeps running until the caller stops
 * it.
 * @param source - The events to pipe.
 * @param writer - This pipe's event writer, which the pipe drains.
 * @param options - The signal and the logger.
 * @yields {Published<E>} Each event with the serial of the message it landed on.
 * @throws {Ably.ErrorInfo} `OperationCancelled` when the signal fired; `PipeFailed` when the source, an encode, a write or a repair failed, with the failure as `cause`.
 */
export async function* pipeEach<E>(
  source: PipeSource<E>,
  writer: DefaultEventWriter<E>,
  options: PipeStreamOptions = {},
): AsyncGenerator<Published<E>, void, undefined> {
  const { signal, logger } = options;
  logger?.trace('pipeEach();');
  const puller = toPuller(source, logger);
  let failure: Ably.ErrorInfo | undefined;
  let cancelled = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentional infinite loop broken by break
    while (true) {
      let pulled;
      try {
        pulled = await pullNext(puller, signal);
      } catch (error) {
        failure = pipeFailed('source failed', error);
        break;
      }
      if (pulled === 'cancelled') {
        logger?.debug('pipeEach(); cancelled by signal');
        cancelled = true;
        break;
      }
      if (pulled.done) {
        logger?.debug('pipeEach(); source ended');
        break;
      }
      const attempt = await writer.attempt(pulled.value, 'pipe');
      if (!attempt.ok) {
        failure = pipeFailed(
          attempt.failed === 'encode' ? 'encode failed' : 'write failed',
          attempt.error,
          pulled.value,
        );
        break;
      }
      yield attempt.written;
    }
  } finally {
    puller.release();
    try {
      await writer.drain();
    } catch (error) {
      // A repair failed: appends that were never acknowledged could not be
      // replaced, so the wire is missing content. An earlier failure stays the
      // pipe's error and this one is logged. Otherwise the repair failure is
      // thrown, cancelled or not: the caller that cancelled knows it did, and
      // what it does not know is that the channel is missing text.
      if (failure === undefined) {
        logger?.error('pipeEach(); repair failed', { error: errorMessage(error) });
        // eslint-disable-next-line no-unsafe-finally -- the repair failure is the pipe's error on every exit that has no earlier one
        throw pipeFailed('repair failed', error);
      }
      logger?.error('pipeEach(); repair after failure also failed', { error: errorMessage(error) });
    }
  }
  if (failure !== undefined) {
    logger?.debug('pipeEach(); pipe failed', { error: failure.message });
    throw failure;
  }
  if (cancelled) throw cancelledError();
  logger?.debug('pipeEach(); finished');
}

/**
 * Pipe a source of events through an event writer, unattended:
 * {@link pipeEach} run to its end.
 * @param source - The events to pipe.
 * @param writer - This pipe's event writer, which the pipe drains.
 * @param options - The signal and the logger.
 * @returns The serial of the last publish, once the source has ended.
 * @throws {Ably.ErrorInfo} As {@link pipeEach}.
 */
export const pipeStream = async <E>(
  source: PipeSource<E>,
  writer: DefaultEventWriter<E>,
  options: PipeStreamOptions = {},
): Promise<PipeResult> => {
  const piped = pipeEach(source, writer, options);
  // Stepped by hand since the events are not needed. The first step runs
  // before this function first awaits, so a stream source is locked at once.
  let step = await piped.next();
  while (!step.done) step = await piped.next();
  const lastPublishSerial = writer.lastPublishSerial;
  options.logger?.debug('pipeStream(); finished', { lastPublishSerial });
  return { lastPublishSerial, serial: lastPublishSerial };
};
