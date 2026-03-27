/**
 * Vercel AI SDK codec — maps UIMessageChunk events and UIMessage objects
 * to/from native Ably message primitives (publish, append, update, delete).
 *
 * ```ts
 * import { UIMessageCodec } from '@ably/ai-transport/vercel';
 *
 * const encoder = UIMessageCodec.createEncoder(writer, options);
 * const decoder = UIMessageCodec.createDecoder();
 * const accumulator = UIMessageCodec.createAccumulator();
 * ```
 */

import type * as AI from 'ai';

import type { Codec } from '../../core/codec/types.js';
import { createAccumulator } from './accumulator.js';
import { createDecoder } from './decoder.js';
import { createEncoder } from './encoder.js';

/**
 * Vercel AI SDK codec implementing `Codec<UIMessageChunk, UIMessage>`.
 *
 * Provides factory methods for creating encoders, decoders, and accumulators
 * that map between Vercel's UIMessageChunk/UIMessage types and Ably's native
 * message primitives.
 */
export const UIMessageCodec: Codec<AI.UIMessageChunk, AI.UIMessage> = {
  createEncoder,
  createDecoder,
  createAccumulator,

  isTerminal: (event: AI.UIMessageChunk): boolean =>
    event.type === 'finish' || event.type === 'error' || event.type === 'abort',
};
