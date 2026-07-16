/**
 * Vercel AI SDK codec factory — `createUIMessageCodec`.
 *
 * Assembled by `defineCodec` from the codec's parts: the reducer
 * (`init`/`fold`/`getMessages`), the declarative output and input descriptor
 * tables (`outputs` / `inputs`, each a builder function `defineCodec` injects
 * the direction-scoped builder into), and the decode lifecycle policy.
 * `defineCodec` builds the generic encoder/decoder and merges the well-known
 * input factories internally.
 *
 * ```ts
 * import { createUIMessageCodec } from '@ably/ai-transport/vercel';
 *
 * const codec = createUIMessageCodec();
 * const encoder = codec.createEncoder(writer, options);
 * const decoder = codec.createDecoder();
 * const projection = codec.init();
 * ```
 */

import type * as AI from 'ai';

import { defineCodec, type DefinedCodec } from '../../core/codec/index.js';
import { createVercelDecodeLifecycle } from './decode-lifecycle.js';
import type { VercelInput, VercelOutput } from './events.js';
import { inputs } from './inputs.js';
import { outputs } from './outputs.js';
import type { VercelProjection } from './reducer.js';
import { fold, getMessages, init } from './reducer.js';

/**
 * Create a Vercel AI SDK codec implementing
 * `Codec<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>`, optionally
 * specialised to a consumer's `AI.UIMessage` generic parameters.
 *
 * Supply concrete `TMetadata` / `TDataParts` / `TTools` type arguments to have the
 * codec's `createUserMessage`, `getMessages`, and projection carry those types
 * (so `view.getMessages()` returns strongly-typed messages); call it with no
 * type arguments for the SDK defaults. Each call assembles a fresh codec value;
 * the codec is stateless, so a module-level `const codec = createUIMessageCodec()`
 * is the usual way to reuse one.
 * @template TMetadata - Per-message metadata type (defaults to the SDK default).
 * @template TDataParts - Custom data-part types (defaults to the SDK default).
 * @template TTools - Tool set typing tool parts (defaults to the SDK default).
 * @returns A codec specialised to the given `AI.UIMessage` parameters.
 */
export const createUIMessageCodec = <
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
  TTools extends AI.UITools = AI.UITools,
>(): DefinedCodec<
  VercelInput<TMetadata, TDataParts, TTools>,
  VercelOutput<TMetadata, TDataParts>,
  VercelProjection<TMetadata, TDataParts, TTools>,
  AI.UIMessage<TMetadata, TDataParts, TTools>
> => {
  // The reducer and descriptor tables reconstruct messages identically for
  // every instantiation of the UIMessage generic params — they refine
  // `metadata` / `parts` at the type level only — so assemble the codec once at
  // the SDK-default instantiation.
  const codec = defineCodec<VercelInput, VercelOutput>()({
    // Spec: AIT-CT1a3, AIT-ST1a3 — registers this codec as an Ably agent.
    adapterTag: 'vercel-ai-sdk-ui-message',
    reducer: { init, fold, getMessages },
    output: outputs,
    input: inputs,
    decodeLifecycle: createVercelDecodeLifecycle,
  });
  // CAST: the runtime codec is the same object for every instantiation; TS
  // can't relate the default-typed value to the specialised shape (the
  // reducer's `getMessages` return type is invariant across the params), so
  // assert it here — the single boundary that reconstructs the generic surface.
  return codec as unknown as DefinedCodec<
    VercelInput<TMetadata, TDataParts, TTools>,
    VercelOutput<TMetadata, TDataParts>,
    VercelProjection<TMetadata, TDataParts, TTools>,
    AI.UIMessage<TMetadata, TDataParts, TTools>
  >;
};

export type { VercelInput, VercelOutput } from './events.js';
export { type VercelProjection } from './reducer.js';
