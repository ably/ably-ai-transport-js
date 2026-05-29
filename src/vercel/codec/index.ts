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
  resolveToolTarget: (output: VercelOutput, projection: VercelProjection): string | undefined => {
    // Only tool-output-style chunks are candidates for redirection — the
    // streamText second-pass case after an approved tool runs. Other
    // events default to whatever messageId the caller (or pipe default)
    // assigns.
    if (output.type !== 'tool-output-available' && output.type !== 'tool-output-error') return undefined;
    const toolCallId = output.toolCallId;
    for (const msg of projection.messages) {
      for (const part of msg.parts) {
        if (part.type !== 'dynamic-tool') continue;
        if (part.toolCallId !== toolCallId) continue;
        if (part.state === 'approval-responded' || part.state === 'approval-requested') {
          return msg.id;
        }
      }
    }
    return undefined;
  },
  isTerminal: (output: VercelOutput): boolean =>
    output.type === 'finish' || output.type === 'error' || output.type === 'abort',
};

export type { VercelInput, VercelOutput } from './events.js';
export { type VercelProjection } from './reducer.js';
