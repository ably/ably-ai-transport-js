/**
 * Vercel AI SDK codec — `UIMessageCodec`.
 *
 * Assembled by `defineCodec` from the codec's parts: the reducer
 * (`init`/`fold`/`getMessages`), the declarative output and input descriptor
 * tables (`outputs` / `inputs`, each a builder function `defineCodec` injects
 * the direction-scoped builder into), and the decode lifecycle policy.
 * `defineCodec` builds the generic encoder/decoder and merges the well-known
 * input factories internally.
 *
 * ```ts
 * import { UIMessageCodec } from '@ably/ai-transport/vercel';
 *
 * const encoder = UIMessageCodec.createEncoder(writer, options);
 * const decoder = UIMessageCodec.createDecoder();
 * const projection = UIMessageCodec.init();
 * ```
 */

import { defineCodec } from '../../core/codec/index.js';
import { createVercelDecodeLifecycle } from './decode-lifecycle.js';
import type { VercelInput, VercelOutput } from './events.js';
import { inputs } from './inputs.js';
import { outputs } from './outputs.js';
import { fold, getMessages, init, isPromptSafe } from './reducer.js';

/**
 * Vercel AI SDK codec implementing
 * `Codec<VercelInput, VercelOutput, VercelProjection, UIMessage>`. `VercelProjection`
 * and `UIMessage` are inferred from the reducer.
 */
export const UIMessageCodec = defineCodec<VercelInput, VercelOutput>()({
  // Spec: AIT-CT1a3, AIT-ST1a3 — registers this codec as an Ably agent.
  adapterTag: 'vercel-ai-sdk-ui-message',
  reducer: { init, fold, getMessages, isPromptSafe },
  output: outputs,
  input: inputs,
  decodeLifecycle: createVercelDecodeLifecycle,
});

export type { VercelInput, VercelOutput } from './events.js';
export { type VercelProjection } from './reducer.js';
