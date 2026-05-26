/**
 * Pure stream piping function.
 *
 * Reads events from a ReadableStream, writes them to an encoder, and handles
 * cancel/error. No dependencies on run state or session internals.
 */

import type { Logger } from '../../logger.js';
import type { Encoder, WriteOptions } from '../codec/types.js';
import type { StreamResult } from './types.js';

/**
 * Pipe an event stream through an encoder to the channel.
 *
 * Returns when the stream completes, is cancelled (via signal), or errors.
 * The `reason` field of the result indicates which case occurred.
 * @param stream - The event stream to read from.
 * @param encoder - The encoder to publish events through.
 * @param signal - AbortSignal to monitor for cancellation.
 * @param onCancelled - Optional callback invoked when the stream is cancelled, before the stream ends.
 * @param resolveWriteOptions - Optional per-event hook returning {@link WriteOptions} overrides to pass to `encoder.publish`.
 * @param logger - Optional logger for diagnostic output.
 * @returns The reason the pipe ended.
 */
export const pipeStream = async <TEvent>(
  stream: ReadableStream<TEvent>,
  encoder: Encoder<TEvent>,
  signal: AbortSignal | undefined,
  onCancelled?: (write: (event: TEvent) => Promise<void>) => void | Promise<void>,
  resolveWriteOptions?: (event: TEvent) => WriteOptions | undefined,
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
          await onCancelled(async (event: TEvent) => encoder.publish(event));
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

      await encoder.publish(value, resolveWriteOptions?.(value));
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
