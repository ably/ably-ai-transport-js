/**
 * Vercel AI SDK codec — implements
 * `Codec<VercelInput, VercelOutput, VercelProjection, UIMessage>`.
 *
 * The codec is the reducer (extends `Reducer<VercelInput | VercelOutput,
 * VercelProjection>`) plus encoder/decoder factories and `getMessages`
 * for Tree population.
 *
 * ```ts
 * import { UIMessageCodec } from '@ably/ai-transport/vercel';
 *
 * const encoder = UIMessageCodec.createEncoder(writer, options);
 * const decoder = UIMessageCodec.createDecoder();
 * const projection = UIMessageCodec.init();
 * ```
 */

import type * as AI from 'ai';

import type { Codec, Regenerate, UserMessage } from '../../core/codec/types.js';
import { createDecoder } from './decoder.js';
import { createEncoder } from './encoder.js';
import type { VercelInput, VercelOutput } from './events.js';
import { fold, getMessages, init, type VercelProjection } from './reducer.js';

/**
 * Vercel AI SDK codec implementing
 * `Codec<VercelInput, VercelOutput, VercelProjection, UIMessage>`.
 *
 * Folds `VercelInput`s and `VercelOutput`s into a `VercelProjection`
 * carrying `UIMessage[]`. Encoder and decoder factories handle the wire
 * mapping for both directions.
 */
export const UIMessageCodec: Codec<VercelInput, VercelOutput, VercelProjection, AI.UIMessage> = {
  init,
  fold,
  createEncoder,
  createDecoder,
  getMessages,
  createUserMessage: (message: AI.UIMessage): UserMessage<AI.UIMessage> => ({ kind: 'user-message', message }),
  createRegenerate: (target: string, parent: string): Regenerate => ({
    kind: 'regenerate',
    target,
    parent,
  }),
};

export type { VercelInput, VercelOutput } from './events.js';
export { type VercelProjection } from './reducer.js';
