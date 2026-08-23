/**
 * The session layer's OpenAI codec — the full reducer + factory codec the
 * sessions and the Tree consume, assembled from the session input taxonomy
 * (`session-events.ts` / `session-descriptors.ts`) and the shared output
 * table. The public wire codec lives in `index.ts`; this codec exists for the
 * session layer alone.
 */

import { defineSessionCodec } from '../../core/transport/session-codec.js';
import { createResponsesDecodeLifecycle } from './decode-lifecycle.js';
import { outputs } from './descriptors.js';
import type { OpenAIOutput } from './events.js';
import { fold, getMessages, init } from './reducer.js';
import { sessionInputs } from './session-descriptors.js';
import type { OpenAISessionInput } from './session-events.js';

/**
 * The session layer's OpenAI Responses codec, implementing the full
 * `Codec<OpenAISessionInput, OpenAIOutput, OpenAIProjection, OpenAIMessage>`
 * contract.
 */
export const ResponsesSessionCodec = defineSessionCodec<OpenAISessionInput, OpenAIOutput>()({
  adapterTag: 'openai-responses',
  reducer: { init, fold, getMessages },
  output: outputs,
  input: sessionInputs,
  // OpenAISessionInput carries all three client-driven tool variants, so the
  // codec exposes the full well-known factory set unchanged.
  factories: (base) => base,
  decoderSynthesiseLifecycle: createResponsesDecodeLifecycle,
});
