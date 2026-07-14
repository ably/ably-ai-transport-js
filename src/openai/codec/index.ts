/**
 * OpenAI Responses codec — `ResponsesCodec`.
 *
 * Assembled by `defineCodec` from the codec's parts: the reducer
 * (`init`/`fold`/`getMessages`), the declarative output/input descriptor
 * tables, and the well-known input factories it exposes (`factories`).
 * `defineCodec` builds the generic encoder/decoder from these.
 *
 * It streams assistant text, refusals, reasoning (summary and raw text) and
 * function-call arguments, handles a plain user message and server-side
 * function calls, and repairs mid-stream joins via `decodeLifecycle`.
 * Client-side tools and hosted tools are not yet supported.
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
 * `Codec<OpenAIInput, OpenAIOutput, OpenAIProjection, OpenAITurn>`.
 * `OpenAIProjection` and `OpenAITurn` are inferred from the reducer.
 */
export const ResponsesCodec = defineCodec<OpenAIInput, OpenAIOutput>()({
  adapterTag: 'openai-responses',
  reducer: { init, fold, getMessages },
  output: outputs,
  input: inputs,
  // Partial codec: its TInput carries no tool variants yet, so it exposes only
  // the mandatory user-message and regenerate factories.
  factories: (base) => ({
    createUserMessage: base.createUserMessage,
    createRegenerate: base.createRegenerate,
  }),
  decodeLifecycle: createResponsesDecodeLifecycle,
});

export type { OpenAIInput, OpenAIItem, OpenAIOutput, OpenAITurn } from './events.js';
export type { OpenAIProjection } from './reducer.js';
