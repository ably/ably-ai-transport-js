/**
 * Pure stream piping function.
 *
 * Reads outputs from a ReadableStream, writes them to an encoder via
 * `publishOutput`, and handles cancel/error. No dependencies on run
 * state or transport internals.
 */

import type { Logger } from '../../logger.js';
import type { Encoder } from '../codec/types.js';
import type { PipeSource, StreamResult } from './types.js';

/** One pull from a normalized source: an output, or the terminal marker. */
type PullResult<T> = { done: false; value: T } | { done: true; value?: T };

/**
 * A minimal pull-reader over either source shape {@link PipeSource} accepts.
 * `read` yields one output or the terminal marker; `release` tears down the
 * underlying source when the pipe ends, is cancelled, or errors.
 */
interface OutputPuller<T> {
  /** Pull the next output, or the terminal marker once the source is exhausted. */
  read(): Promise<PullResult<T>>;
  /** Best-effort teardown: release a reader's lock or return the iterator. */
  release(): void;
}

/**
 * Normalize a {@link PipeSource} to a pull-reader. A `ReadableStream` is read
 * through its reader (preferred where present, since the reader API is the
 * portable one); any other source is driven through its async iterator, whose
 * `return()` is called on release for best-effort upstream teardown.
 * @param source - The stream or async-iterable to consume.
 * @returns A pull-reader that yields outputs and tears the source down on release.
 */
const toPuller = <T>(source: PipeSource<T>): OutputPuller<T> => {
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
  return {
    read: async () => {
      const result = await iterator.next();
      return result.done ? { done: true } : { done: false, value: result.value };
    },
    release: () => {
      void iterator.return?.();
    },
  };
};

/**
 * Adapt an AbortSignal into a promise that resolves once the signal aborts,
 * paired with a cleanup that detaches the listener. With no signal the promise
 * never resolves (there is no cancellation path); an already-aborted signal
 * resolves immediately. `cleanup` is a no-op unless a listener was attached.
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

/**
 * Pipe an output stream through an encoder to the channel.
 *
 * Returns when the stream completes, is cancelled (via signal), or errors.
 * The `reason` field of the result indicates which case occurred.
 * @param source - The output source to read from: a `ReadableStream` or any `AsyncIterable` of outputs.
 * @param encoder - The encoder to publish outputs through.
 * @param signal - AbortSignal to monitor for cancellation.
 * @param onCancelled - Optional callback invoked when the stream is cancelled, before the stream ends.
 * @param logger - Optional logger for diagnostic output.
 * @param beforeFirstWrite - Optional hook awaited exactly once, immediately before the FIRST output event is handed to the encoder. Never fires for a stream that completes empty, errors, or is cancelled before producing any event. Note the event that triggers the hook may itself publish nothing (a codec `drop` type), so the resource the hook opens (e.g. `run.pipe`'s implicit step) can bracket zero wire writes.
 * @returns A {@link StreamResult}: `reason` is why the pipe ended, and `error` holds the caught error when `reason` is `'error'`.
 */
export const pipeStream = async <TInput, TOutput>(
  source: PipeSource<TOutput>,
  encoder: Encoder<TInput, TOutput>,
  signal: AbortSignal | undefined,
  onCancelled?: (write: (output: TOutput) => Promise<void>) => void | Promise<void>,
  logger?: Logger,
  beforeFirstWrite?: () => Promise<void>,
): Promise<StreamResult> => {
  logger?.trace('pipeStream();');

  const puller = toPuller(source);
  const abort = abortSignalToPromise(signal);

  let reason: StreamResult['reason'] = 'complete';
  let caughtError: Error | undefined;
  // Tracks whether the first-output hook has fired so it runs at most once.
  let firstWriteDone = false;

  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentional infinite loop broken by return/break
    while (true) {
      // .then() is intentional: transforms the AbortSignal into a discriminant
      // for Promise.race — no async/await equivalent for this pattern.
      const result = await Promise.race([puller.read(), abort.promise.then(() => 'cancelled' as const)]);

      if (result === 'cancelled') {
        reason = 'cancelled';
        logger?.debug('pipeStream(); stream cancelled by AbortSignal');
        if (onCancelled) {
          await onCancelled(async (output: TOutput) => encoder.publishOutput(output));
        }
        // Transport mechanics only — close in-flight streamed messages as
        // cancelled. Run termination is the transport ai-run-end event,
        // guaranteed by AgentRunTransport.pipe on a cancelled result.
        await encoder.cancelStreams();
        break;
      }

      const { done, value } = result;
      if (done) {
        // An agent-side self-abort (e.g. the AI SDK's abort signal firing)
        // completes the stream without end chunks for in-flight streamed
        // messages. Terminate any still-open wire streams with a cancelled
        // status so decoders and history see a terminal; streams that closed
        // normally are skipped (no-op on a clean completion).
        await encoder.cancelStreams();
        await encoder.close();
        logger?.debug('pipeStream(); stream completed');
        break;
      }

      // Fire the lazy first-output hook before the first event reaches the
      // encoder so a caller can open a resource (e.g. the implicit step) that
      // must bracket the output. An empty / errored / pre-output-cancelled
      // stream never reaches here, so the hook (and any resource it opens)
      // never fires. The triggering event may itself be a codec `drop` type
      // that publishes nothing — the opened resource may bracket zero writes.
      if (!firstWriteDone) {
        firstWriteDone = true;
        if (beforeFirstWrite) await beforeFirstWrite();
      }

      await encoder.publishOutput(value);
    }
  } catch (error) {
    reason = 'error';
    caughtError = error instanceof Error ? error : new Error(String(error));
    // The step writer logs this failure at error with the run it belongs to.
    // Kept at debug so one stream failure does not produce two error lines.
    logger?.debug('pipeStream(); stream error', { error: caughtError.message });
    try {
      await encoder.close();
    } catch {
      // Best-effort: encoder close in the error path may also fail
      // (e.g. channel disconnected). The original error is preserved in
      // the StreamResult reason ("error").
    }
  } finally {
    abort.cleanup();
    puller.release();
  }

  return { reason, error: caughtError };
};
