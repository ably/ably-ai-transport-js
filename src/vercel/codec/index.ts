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
  createRegenerateEvent: (forkOfMsgId: string, parentMsgId: string): VercelEvent => ({
    type: 'ait-regenerate',
    forkOfMsgId,
    parentMsgId,
  }),
  classifyEvent: (event: VercelEvent): EventClassification<AI.UIMessage> => {
    if (event.type === 'ait-user-message') {
      return { kind: 'user-message', message: event.message };
    }
    if (event.type === 'ait-regenerate') {
      return { kind: 'regenerate', parent: event.parentMsgId, forkOf: event.forkOfMsgId };
    }
    // Client-published continuation tool-resolution events are also
    // `user-message` for publish-path purposes (own msgId, own promptId,
    // role=user header). The reducer (and the session's optimistic-fold
    // path) inline-detect them by event type and redirect onto the
    // prior assistant by toolCallId. The synthetic UIMessage carries a
    // single `dynamic-tool` part whose state matches the wire event so
    // inline detection in the session ("parts are all tool resolutions")
    // matches both fresh tool events and decoded echoes.
    if (event.type === 'tool-output-available') {
      return {
        kind: 'user-message',
        message: {
          id: '',
          role: 'user',
          parts: [
            {
              type: 'dynamic-tool',
              toolCallId: event.toolCallId,
              toolName: '',
              state: 'output-available',
              input: undefined,
              output: event.output,
            },
          ],
        },
      };
    }
    if (event.type === 'tool-output-error') {
      return {
        kind: 'user-message',
        message: {
          id: '',
          role: 'user',
          parts: [
            {
              type: 'dynamic-tool',
              toolCallId: event.toolCallId,
              toolName: '',
              state: 'output-error',
              input: undefined,
              errorText: event.errorText,
            },
          ],
        },
      };
    }
    if (event.type === 'tool-approval-response') {
      const approval: AI.DynamicToolUIPart['approval'] = {
        id: '',
        approved: event.approved,
        ...(event.reason === undefined ? {} : { reason: event.reason }),
      };
      // CAST: AI SDK's `DynamicToolUIPart` is a discriminated union over `state`.
      // The literal shape satisfies the `approval-responded` and `output-denied`
      // arms but TypeScript widens `state` to the union and rejects the assignment
      // without a cast at the object boundary.
      const part = {
        type: 'dynamic-tool',
        toolCallId: event.toolCallId,
        toolName: '',
        state: event.approved ? 'approval-responded' : 'output-denied',
        input: undefined,
        approval,
      } as AI.DynamicToolUIPart;
      return {
        kind: 'user-message',
        message: {
          id: '',
          role: 'user',
          parts: [part],
        },
      };
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
