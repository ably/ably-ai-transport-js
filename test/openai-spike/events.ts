/**
 * AIT-742 Phase 0 spike — codec type bindings for the OpenAI Responses target.
 *
 * Disposable scratch. Binds the four `Codec` generic parameters to OpenAI's
 * Responses types so the rest of the spike can be written against concrete
 * shapes:
 *
 * - `TOutput` = OpenAI's `ResponseStreamEvent` union, pass-through (decision #1).
 * - `TInput`  = the SDK's well-known input variants parameterised with OpenAI
 *               payloads (a user turn, and a client-published tool result).
 * - `TMessage` = one turn's worth of OpenAI items (decision #2).
 * - `TProjection` = the run's accumulated items (see reducer.ts).
 */

import type { ToolResult, UserMessage } from '../../src/core/codec/index.js';
import type {
  ResponseFunctionToolCall,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';

/**
 * `TOutput` — the agent publishes raw Responses stream events. Pass-through,
 * exactly mirroring how the Vercel codec binds `AI.UIMessageChunk`.
 */
export type OpenAIOutput = ResponseStreamEvent;

/**
 * A turn's items. Assistant turns hold `ResponseOutputItem`s; a user turn holds
 * an input message; a client-computed tool result is a `function_call_output`
 * input item appended to the assistant turn. The union of input and output
 * items is the whole §5 point — output items are *also* valid model input, so
 * `TMessage` is simultaneously renderable and (near-)identity model input.
 */
export type OpenAIItem = ResponseOutputItem | ResponseInputItem;

/**
 * `TMessage` — one turn's worth of OpenAI items, tagged with a role. Per-turn =
 * one message (decision #2). System/developer instructions are server-side
 * config and never appear here.
 */
export interface OpenAITurn {
  role: 'user' | 'assistant';
  items: OpenAIItem[];
}

/** The client's tool-result payload, keyed on `call_id` (§5). */
export interface OpenAIToolResultPayload {
  callId: string;
  output: string;
}

/**
 * `TInput` — the SDK's well-known variants, parameterised with OpenAI payloads.
 * No codec-local input variants (like Vercel).
 */
export type OpenAIInput = UserMessage<OpenAITurn> | ToolResult<OpenAIToolResultPayload>;

// Convenience re-exports for fixtures/tests.
export type { ResponseFunctionToolCall, ResponseOutputItem, ResponseOutputMessage, ResponseStreamEvent };
