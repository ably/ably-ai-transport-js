/**
 * Vercel AI SDK codec — implements `Codec<VercelEvent, VercelProjection, UIMessage>`.
 *
 * The codec is the reducer (extends `Reducer<VercelEvent, VercelProjection>`)
 * plus encoder/decoder factories and `getMessages` for Tree population.
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

import type { Codec } from '../../core/codec/types.js';
import { createDecoder } from './decoder.js';
import { createEncoder } from './encoder.js';
import type { VercelEvent } from './events.js';
import { fold, getMessages, init, type VercelProjection } from './reducer.js';

/**
 * Vercel AI SDK codec implementing `Codec<VercelEvent, VercelProjection, UIMessage>`.
 *
 * Folds VercelEvents into a `VercelProjection` carrying `UIMessage[]`.
 * Encoder and decoder factories handle the wire mapping.
 */
export const UIMessageCodec: Codec<VercelEvent, VercelProjection, AI.UIMessage> = {
  init,
  fold,
  createEncoder,
  createDecoder,
  getMessages,
  userMessageEvent: (message: AI.UIMessage): VercelEvent => ({ type: 'ait-user-message', message }),
  isTerminal: (event: VercelEvent): boolean =>
    event.type === 'finish' || event.type === 'error' || event.type === 'abort',
};

export type { ToolApprovalEvent, UserMessageEvent, VercelEvent } from './events.js';
export { type VercelProjection } from './reducer.js';
