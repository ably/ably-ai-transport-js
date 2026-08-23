/** Shared mock codec encoder for transport unit tests. */

import type * as Ably from 'ably';
import { vi } from 'vitest';

import type { Encoder, EncoderOptions } from '../../src/core/codec/types.js';
import type { CodecInputEvent, CodecOutputEvent } from '../../src/core/transport/session-codec.js';

/**
 * Build an encoder whose `publishOutput` mirrors the encoder core: it builds
 * the message's transport tier from the encoder's default headers and runs the
 * composed `onAblyMessage` hook, so a writer's header-stamping path is
 * exercised. All verbs resolve immediately.
 * @param opts - The encoder options the codec factory received.
 * @returns The mock encoder.
 */
export const createMockEncoder = <TInput extends CodecInputEvent, TOutput extends CodecOutputEvent>(
  opts?: EncoderOptions,
): Encoder<TInput, TOutput> => ({
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
  publishInput: vi.fn(() => Promise.resolve()),
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
  publishOutput: vi.fn(() => {
    const msg: Ably.Message = { name: 'ai-output', extras: { ai: { transport: { ...opts?.extras?.headers } } } };
    opts?.onAblyMessage?.(msg);
    return Promise.resolve();
  }),
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
  cancelStreams: vi.fn(() => Promise.resolve()),
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
  close: vi.fn(() => Promise.resolve()),
});
