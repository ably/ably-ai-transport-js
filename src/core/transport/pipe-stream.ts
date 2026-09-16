/**
 * The pipe driver: read a source of events, encode each one, and write it
 * through a {@link PipeWriter}.
 *
 * A pipe resolves when its source ends, with the serial of its last publish,
 * and rejects otherwise: `OperationCancelled` when the signal fires, and
 * `PipeFailed` when the source throws, the codec cannot encode an event, a
 * publish or update fails, or a repair fails. A failed append does not end the
 * pipe: the writer repairs it when the stream ends, and a failed repair is what
 * rejects. On every exit, cancel included, the writer is flushed and the source
 * released before the pipe settles, so a provider's generator can clean up.
 * The call's headers, when it has any, are added to every message before it
 * reaches the writer, so the writer's repair snapshot carries them too.
 */

import * as Ably from 'ably';

import { ErrorCode } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { errorCause, errorMessage } from '../../utils.js';
import type { Codec } from '../codec/codec.js';
import { type MessageHeaders, withHeaders } from './headers.js';
import type { PipeWriter } from './pipe-writer.js';

/**
 * What `pipe` reads: a `ReadableStream` or any `AsyncIterable` of events. A
 * provider SDK stream that is async-iterable pipes in directly. The pipe pulls
 * one event at a time and releases the source when it ends, is cancelled or
 * errors: it releases a stream reader's lock, or calls an iterator's
 * `return()`. A `return()` that throws or rejects is logged at warn and is
 * never the pipe's outcome.
 * @template E - The codec's event union.
 */
export type PipeSource<E> = ReadableStream<E> | AsyncIterable<E>;

/** What a pipe resolves with once its source has ended and everything it wrote is on the channel. */
export interface PipeResult {
  /**
   * The ack serial of the last publish the pipe made, including the publish
   * that opens an append key, or `undefined` when it published nothing.
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
      // Bound method, not an arrow: preserves `reader.read`'s exact scheduling
      // (no extra microtask tick) so the pull-vs-abort race resolves without a delay.
      read: reader.read.bind(reader),
      release: () => {
        reader.releaseLock();
      },
    };
  }
  const iterator = source[Symbol.asyncIterator]();
  const warnReturnFailed = (error: unknown): void => {
    logger?.warn('pipeStream(); source return() failed', { error: errorMessage(error) });
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

/**
 * Adapt an AbortSignal into a promise that resolves once the signal aborts,
 * paired with a cleanup that detaches the listener. With no signal the promise
 * never resolves; an already-aborted signal resolves immediately.
 * @param signal - The AbortSignal to watch, or undefined for no cancellation.
 * @returns The abort promise and a cleanup to call when racing is done.
 */
const abortSignalToPromise = (signal: AbortSignal | undefined): { promise: Promise<void>; cleanup: () => void } => {
  let listener: (() => void) | undefined;
  const promise =
    signal === undefined
      ? // eslint-disable-next-line @typescript-eslint/no-empty-function -- never-resolving promise: no signal means no cancellation path
        new Promise<void>(() => {})
      : signal.aborted
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            listener = () => {
              resolve();
            };
            signal.addEventListener('abort', listener, { once: true });
          });
  const cleanup = (): void => {
    if (listener && signal) signal.removeEventListener('abort', listener);
  };
  return { promise, cleanup };
};

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

/** What `pipeStream` takes beside its source, codec and writer. */
export interface PipeStreamOptions {
  /** Fires to cancel the pipe. */
  signal?: AbortSignal;
  /** The call's headers, added to every message before it reaches the writer. Already checked by the transport. */
  headers?: MessageHeaders;
  /** Logger for diagnostics. */
  logger?: Logger;
}

/**
 * Pipe a source of events through a codec to a writer.
 * @param source - The events to pipe.
 * @param codec - The codec that turns each event into an Ably message.
 * @param writer - This pipe's writer, holding its key table.
 * @param options - The signal, the call's headers and the logger.
 * @returns The serial of the last publish, once the source has ended.
 * @throws {Ably.ErrorInfo} `OperationCancelled` when the signal fired; `PipeFailed` when the source, an encode, a write or a repair failed, with the failure as `cause`.
 */
export const pipeStream = async <E>(
  source: PipeSource<E>,
  codec: Codec<E>,
  writer: PipeWriter,
  options: PipeStreamOptions = {},
): Promise<PipeResult> => {
  const { signal, headers, logger } = options;
  logger?.trace('pipeStream();');
  const puller = toPuller(source, logger);
  const abort = abortSignalToPromise(signal);
  let serial: string | undefined;
  let failure: Ably.ErrorInfo | undefined;
  let cancelled = false;

  const fail = (what: string, error: unknown, event?: E): void => {
    failure = pipeFailed(what, error, event);
    logger?.debug('pipeStream(); pipe failed', { what, error: errorMessage(error) });
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentional infinite loop broken by break
    while (true) {
      // A signal that has already fired wins before the next read, so a
      // cancelled pipe writes nothing more even when the source has an event
      // ready. The race below covers a signal that fires mid-read.
      // .then() is intentional: it turns the AbortSignal into a discriminant
      // for Promise.race, which has no async/await equivalent.
      const pulled =
        signal?.aborted === true
          ? 'cancelled'
          : await Promise.race([puller.read(), abort.promise.then(() => 'cancelled' as const)]);

      if (pulled === 'cancelled') {
        cancelled = true;
        logger?.debug('pipeStream(); cancelled by signal');
        break;
      }
      if (pulled.done) {
        logger?.debug('pipeStream(); source ended');
        break;
      }

      const event = pulled.value;
      let encoded;
      try {
        encoded = codec.encode(event);
      } catch (error) {
        fail('encode failed', error, event);
        break;
      }

      try {
        // An event's messages are written as a unit; the signal is read again
        // before the next event, not between them.
        for (const message of encoded) {
          const stamped =
            headers === undefined ? message : { ...message, message: withHeaders(message.message, headers) };
          const acked = await writer.write(stamped);
          if (acked !== undefined) serial = acked;
        }
      } catch (error) {
        fail('write failed', error, event);
        break;
      }
    }
  } catch (error) {
    // The source threw on read.
    fail('source failed', error);
  } finally {
    abort.cleanup();
    puller.release();
  }

  try {
    await writer.flush();
  } catch (error) {
    // A repair failed: appends that were never acknowledged could not be
    // replaced, so the wire is missing content. An earlier failure stays the
    // pipe's error and this one is logged. Otherwise the repair failure is the
    // rejection, cancelled or not: the caller that cancelled knows it did, and
    // what it does not know is that the channel is missing text.
    if (failure === undefined) {
      fail('repair failed', error);
    } else {
      logger?.error('pipeStream(); repair after failure also failed', { error: errorMessage(error) });
    }
  }

  if (failure !== undefined) throw failure;
  if (cancelled) throw cancelledError();
  logger?.debug('pipeStream(); finished', { serial });
  return { serial };
};
