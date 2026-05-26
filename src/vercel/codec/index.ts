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

import type { Codec, EventClassification } from '../../core/codec/types.js';
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
  createRegenerateEvent: (forkOfCodecMessageId: string, parentCodecMessageId: string): VercelEvent => ({
    type: 'ait-regenerate',
    forkOfCodecMessageId,
    parentCodecMessageId,
  }),
  classifyEvent: (event: VercelEvent): EventClassification => {
    // Fresh user prompts and continuation tool-resolution events (tool
    // output / approval response) all classify as `user-message` — they
    // share the wire path (own codecMessageId, own eventId, role=user). The
    // reducer inline-detects tool resolutions and folds them onto the
    // prior assistant via `consumedCodecMessageIds`; the session is uniform.
    if (
      event.type === 'ait-user-message' ||
      event.type === 'tool-output-available' ||
      event.type === 'tool-output-error' ||
      event.type === 'tool-approval-response'
    ) {
      return { kind: 'user-message' };
    }
    if (event.type === 'ait-regenerate') {
      return { kind: 'regenerate', parent: event.parentCodecMessageId, forkOf: event.forkOfCodecMessageId };
    }
    return { kind: 'other' };
  },
  resolveToolTarget: (event: VercelEvent, projection: VercelProjection): string | undefined => {
    // Only tool-output-style chunks are candidates for redirection — the
    // streamText second-pass case after an approved tool runs. Other
    // events default to whatever messageId the caller (or pipe default)
    // assigns.
    if (event.type !== 'tool-output-available' && event.type !== 'tool-output-error') return undefined;
    const toolCallId = event.toolCallId;
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
  isTerminal: (event: VercelEvent): boolean =>
    event.type === 'finish' || event.type === 'error' || event.type === 'abort',
};

export type { RegenerateEvent, ToolApprovalResponseEvent, UserMessageEvent, VercelEvent } from './events.js';
export { type VercelProjection } from './reducer.js';
