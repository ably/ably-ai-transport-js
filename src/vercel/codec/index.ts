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

import type { Codec } from '../../core/codec/types.js';
import { createDecoder } from './decoder.js';
import { createEncoder } from './encoder.js';
import type {
  VercelInput,
  VercelOutput,
  VercelToolApprovalResponsePayload,
  VercelToolResultErrorPayload,
  VercelToolResultPayload,
} from './events.js';
import { fold, getMessages, init, type VercelProjection } from './reducer.js';

/**
 * Vercel AI SDK codec implementing
 * `Codec<VercelInput, VercelOutput, VercelProjection, UIMessage>`.
 *
 * Folds `VercelInput`s and `VercelOutput`s into a `VercelProjection`
 * carrying `UIMessage[]`. Encoder and decoder factories handle the wire
 * mapping for both directions.
 */
const uiMessageCodecImpl = {
  // Internal field - picked up by registerAgent via AdapterTagHolder cast. Spec: AIT-CT1a3, AIT-ST1a3.
  adapterTag: 'vercel-ai-sdk-ui-message' as const,
  init,
  fold,
  createEncoder,
  createDecoder,
  getMessages,
  createUserMessage: (message: AI.UIMessage): VercelInput => ({ kind: 'user-message', message }),
  createRegenerate: (target: string, parent: string): VercelInput => ({
    kind: 'regenerate',
    target,
    parent,
  }),
  createToolResult: (transportMessageId: string, payload: VercelToolResultPayload): VercelInput => ({
    kind: 'tool-result',
    transportMessageId,
    payload,
  }),
  createToolResultError: (transportMessageId: string, payload: VercelToolResultErrorPayload): VercelInput => ({
    kind: 'tool-result-error',
    transportMessageId,
    payload,
  }),
  createToolApprovalResponse: (
    transportMessageId: string,
    payload: VercelToolApprovalResponsePayload,
  ): VercelInput => ({
    kind: 'tool-approval-response',
    transportMessageId,
    payload,
  }),
};

// Validate Codec conformance via `satisfies` on the variable (no excess-property
// check, so the internal `adapterTag` is permitted) while keeping the concrete
// type so the codec-specific factories (createToolResult, etc.) stay callable.
export const UIMessageCodec = uiMessageCodecImpl satisfies Codec<
  VercelInput,
  VercelOutput,
  VercelProjection,
  AI.UIMessage
>;

export type { VercelInput, VercelOutput } from './events.js';
export { type VercelProjection } from './reducer.js';
