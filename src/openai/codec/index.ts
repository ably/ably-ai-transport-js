/**
 * OpenAI Responses codec — `ResponsesCodec`.
 *
 * Assembled by `defineCodec` from the codec's parts: the declarative
 * output/input descriptor tables and the decode lifecycle policy.
 * `defineCodec` builds the generic encoder/decoder from these.
 *
 * It streams assistant text, refusals, reasoning (summary and raw text) and
 * function-call arguments, handles a message turn and both server-side
 * and client-side function calls (results, failures, and human approvals), and
 * repairs mid-stream joins via `decoderSynthesiseLifecycle`. Hosted tools (web /
 * file search, code interpreter, image gen, MCP, custom tools) are not yet
 * supported (AIT-1121).
 *
 * ```ts
 * import { ResponsesCodec } from '@ably/ai-transport/openai';
 *
 * const decoder = ResponsesCodec.createDecoder();
 * ```
 */

import { defineCodec } from '../../core/codec/index.js';
import { createResponsesDecodeLifecycle } from './decode-lifecycle.js';
import { inputs, outputs } from './descriptors.js';
import type { OpenAIInput, OpenAIOutput } from './events.js';

/**
 * OpenAI Responses codec implementing `WireCodec<OpenAIInput, OpenAIOutput>`.
 */
export const ResponsesCodec = defineCodec<OpenAIInput, OpenAIOutput>()({
  output: outputs,
  input: inputs,
  decoderSynthesiseLifecycle: createResponsesDecodeLifecycle,
});

export type {
  OpenAIApprovalDecision,
  OpenAIApprovalInput,
  OpenAIInput,
  OpenAIItem,
  OpenAIItemInput,
  OpenAIMessage,
  OpenAIMessageInput,
  OpenAIOutput,
  OpenAIToolCallState,
  ToolApprovalRequestEvent,
} from './events.js';
