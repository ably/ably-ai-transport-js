/**
 * AIT-742 Phase 0 spike — codec assembly via `defineCodec`.
 *
 * If this assembles (and `defineCodec`'s `validateTables` does not throw), the
 * descriptor split is structurally valid for the Responses subset — the
 * headline evidence for hypothesis 7. The scratch reducer + descriptor tables
 * are bound to OpenAI's Responses types with NO change to `src/core`.
 */

import { defineCodec } from '../../src/core/codec/index.js';
import { inputs, outputs } from './descriptors.js';
import type { OpenAIInput, OpenAIOutput } from './events.js';
import { fold, getMessages, init } from './reducer.js';

export const OpenAIResponsesCodec = defineCodec<OpenAIInput, OpenAIOutput>()({
  adapterTag: 'openai-responses-spike',
  reducer: { init, fold, getMessages },
  output: outputs,
  input: inputs,
});
