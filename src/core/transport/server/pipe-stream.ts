/**
 * Pure stream piping function.
 *
 * Reads events from a ReadableStream, writes them to a streaming encoder,
 * and handles abort/error. No dependencies on turn state or transport internals.
 */

import type { Logger } from '../../../logger.js';
import type { StreamEncoder } from '../../codec/types.js';
import type { StreamResult } from './types.js';

/**
 * Pipe an event stream through an encoder to the channel.
 *
 * Returns when the stream completes, is cancelled (via signal), or errors.
 * The `reason` field of the result indicates which case occurred.
 * @param stream - The event stream to read from.
 * @param encoder - The streaming encoder to write events through.
 * @param signal - Abort signal to monitor for cancellation.
 * @param onAbort - Optional callback invoked when the stream is cancelled, before the stream ends.
 * @param logger - Optional logger for diagnostic output.
 * @returns The reason the pipe ended.
 */
export const pipeStream = async <TEvent, TMessage>(
  stream: ReadableStream<TEvent>,
  encoder: StreamEncoder<TEvent, TMessage>,
  signal: AbortSignal | undefined,
  onAbort?: (write: (event: TEvent) => Promise<void>) => void | Promise<void>,
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

  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentional infinite loop broken by return/break
    while (true) {
      // .then() is intentional: transforms the abort signal into a discriminant
      // for Promise.race — no async/await equivalent for this pattern.
      const result = await Promise.race([reader.read(), abortPromise.then(() => 'aborted' as const)]);

      if (result === 'aborted') {
        reason = 'cancelled';
        logger?.debug('pipeStream(); stream cancelled by abort signal');
        if (onAbort) {
          await onAbort(async (event: TEvent) => encoder.appendEvent(event));
        }
        await encoder.abort('cancelled');
        break;
      }

      const { done, value } = result;
      if (done) {
        await encoder.close();
        logger?.debug('pipeStream(); stream completed');
        break;
      }

      await encoder.appendEvent(value);
    }
  } catch (error) {
    reason = 'error';
    const errorText = error instanceof Error ? error.message : String(error);
    logger?.error('pipeStream(); stream error', { error: errorText });
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

  return { reason };
};
