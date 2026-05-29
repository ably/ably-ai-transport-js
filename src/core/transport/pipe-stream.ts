/**
 * Pure stream piping function.
 *
 * Reads outputs from a ReadableStream, writes them to an encoder via
 * `publishOutput`, and handles cancel/error. No dependencies on run
 * state or session internals.
 */

import type { Logger } from '../../logger.js';
import type { CodecInputEvent, CodecOutputEvent, Encoder, WriteOptions } from '../codec/types.js';
import type { StreamResult } from './types.js';

/**
 * Pipe an output stream through an encoder to the channel.
 *
 * Returns when the stream completes, is cancelled (via signal), or errors.
 * The `reason` field of the result indicates which case occurred.
 * @param stream - The output stream to read from.
 * @param encoder - The encoder to publish outputs through.
 * @param signal - AbortSignal to monitor for cancellation.
 * @param onCancelled - Optional callback invoked when the stream is cancelled, before the stream ends.
 * @param resolveWriteOptions - Optional per-output hook returning {@link WriteOptions} overrides to pass to `encoder.publishOutput`.
 * @param logger - Optional logger for diagnostic output.
 * @returns The reason the pipe ended.
 */
export const pipeStream = async <TInput extends CodecInputEvent, TOutput extends CodecOutputEvent>(
  stream: ReadableStream<TOutput>,
  encoder: Encoder<TInput, TOutput>,
  signal: AbortSignal | undefined,
  onCancelled?: (write: (output: TOutput) => Promise<void>) => void | Promise<void>,
  resolveWriteOptions?: (output: TOutput) => WriteOptions | undefined,
  logger?: Logger,
): Promise<StreamResult> => {
  logger?.trace('pipeStream();');

  const reader = stream.getReader();

  let abortListener: (() => void) | undefined;
  const abortPromise = signal
    ? new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        abortListener = () => {
          resolve();
        };
        signal.addEventListener('abort', abortListener, { once: true });
      })
    : // eslint-disable-next-line @typescript-eslint/no-empty-function -- never-resolving promise: no signal means no cancellation path
      new Promise<void>(() => {});

  let reason: StreamResult['reason'] = 'complete';
  let caughtError: Error | undefined;

  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentional infinite loop broken by return/break
    while (true) {
      // .then() is intentional: transforms the AbortSignal into a discriminant
      // for Promise.race — no async/await equivalent for this pattern.
      const result = await Promise.race([reader.read(), abortPromise.then(() => 'cancelled' as const)]);

      if (result === 'cancelled') {
        reason = 'cancelled';
        logger?.debug('pipeStream(); stream cancelled by AbortSignal');
        if (onCancelled) {
          await onCancelled(async (output: TOutput) => encoder.publishOutput(output));
        }
        await encoder.cancel('cancelled');
        break;
      }

      const { done, value } = result;
      if (done) {
        await encoder.close();
        logger?.debug('pipeStream(); stream completed');
        break;
      }

      await encoder.publishOutput(value, resolveWriteOptions?.(value));
    }
  } catch (error) {
    reason = 'error';
    caughtError = error instanceof Error ? error : new Error(String(error));
    logger?.error('pipeStream(); stream error', { error: caughtError.message });
    try {
      await encoder.close();
    } catch {
      // Best-effort: encoder close in the error path may also fail
      // (e.g. channel disconnected). The original error is preserved in
      // the StreamResult reason ("error").
    }
  } finally {
    if (abortListener) signal?.removeEventListener('abort', abortListener);
    reader.releaseLock();
  }

  return { reason, error: caughtError };
};
