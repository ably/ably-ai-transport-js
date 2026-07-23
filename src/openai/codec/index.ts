/**
 * OpenAI Responses codec — `ResponsesCodec`.
 *
 * Assembled by `defineCodec` from the codec's parts: the reducer
 * (`init`/`fold`/`getMessages`), the declarative output/input descriptor
 * tables, and the well-known input factories it exposes (`factories`).
 * `defineCodec` builds the generic encoder/decoder from these.
 *
 * It streams assistant text, refusals, reasoning (summary and raw text) and
 * function-call arguments, handles a plain user message and both server-side
 * and client-side function calls (results, failures, and human approvals), and
 * repairs mid-stream joins via `decoderSynthesiseLifecycle`. Hosted tools (web /
 * file search, code interpreter, image gen, MCP, custom tools) are not yet
 * supported (AIT-1121).
 *
 * ```ts
 * import { ResponsesCodec } from '@ably/ai-transport/openai';
 *
 * const decoder = ResponsesCodec.createDecoder();
 * const projection = ResponsesCodec.init();
 * ```
 */

import { defineCodec } from '../../core/codec/index.js';
import { createResponsesDecodeLifecycle } from './decode-lifecycle.js';
import { inputs, outputs } from './descriptors.js';
import type { OpenAIInput, OpenAIOutput } from './events.js';
import { fold, getMessages, init } from './reducer.js';

/**
 * OpenAI Responses codec implementing
 * `Codec<OpenAIInput, OpenAIOutput, OpenAIProjection, OpenAIMessage>`.
 * `OpenAIProjection` and `OpenAIMessage` are inferred from the reducer.
 */
export const ResponsesCodec = defineCodec<OpenAIInput, OpenAIOutput>()({
  adapterTag: 'openai-responses',
  reducer: { init, fold, getMessages },
  output: outputs,
  input: inputs,
  // OpenAIInput carries all three client-driven tool variants, so the codec
  // exposes the full well-known factory set unchanged.
  factories: (base) => base,
  decoderSynthesiseLifecycle: createResponsesDecodeLifecycle,
});

export type {
  OpenAIInput,
  OpenAIItem,
  OpenAIMessage,
  OpenAIOutput,
  OpenAIToolApprovalResponsePayload,
  OpenAIToolCallState,
  OpenAIToolResultErrorPayload,
  OpenAIToolResultPayload,
  ToolApprovalRequestEvent,
} from './events.js';
export type { OpenAIProjection } from './reducer.js';
