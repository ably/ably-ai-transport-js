/**
 * Vercel AI SDK codec factory — `createUIMessageCodec`.
 *
 * Assembled by `defineCodec` from the codec's parts: the declarative output
 * and input descriptor tables (`outputs` / `inputs`, each a builder function
 * `defineCodec` injects the direction-scoped builder into) and the decode
 * lifecycle policy. `defineCodec` builds the generic encoder/decoder from
 * these.
 *
 * ```ts
 * import { createUIMessageCodec } from '@ably/ai-transport/vercel';
 *
 * const codec = createUIMessageCodec();
 * const encoder = codec.createEncoder(writer, options);
 * const decoder = codec.createDecoder();
 * ```
 */

import type * as AI from 'ai';

import type { WireCodec } from '../../core/codec/index.js';
import { defineCodec } from '../../core/codec/index.js';
import { createVercelDecodeLifecycle } from './decode-lifecycle.js';
import type { VercelInput, VercelOutput } from './events.js';
import { inputs } from './inputs.js';
import { outputs } from './outputs.js';

/**
 * Create a Vercel AI SDK codec implementing
 * `WireCodec<VercelInput, VercelOutput>`, optionally specialised to a
 * consumer's `AI.UIMessage` generic parameters.
 *
 * Supply concrete `TMetadata` / `TDataParts` / `TTools` type arguments to have
 * the codec's input and output unions carry those types; call it with no type
 * arguments for the SDK defaults. Each call assembles a fresh codec value;
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
>(): WireCodec<VercelInput<TMetadata, TDataParts, TTools>, VercelOutput<TMetadata, TDataParts>> => {
  // The descriptor tables encode and decode identically for every
  // instantiation of the UIMessage generic params — they refine `metadata` /
  // `parts` at the type level only — so assemble the codec once at the
  // SDK-default instantiation.
  const codec = defineCodec<VercelInput, VercelOutput>()({
    output: outputs,
    input: inputs,
    decoderSynthesiseLifecycle: createVercelDecodeLifecycle,
  });
  // CAST: the runtime codec is the same object for every instantiation; TS
  // can't relate the default-typed value to the specialised shape, so assert
  // it here — the single boundary that reconstructs the generic surface.
  return codec as WireCodec<VercelInput<TMetadata, TDataParts, TTools>, VercelOutput<TMetadata, TDataParts>>;
};

export type {
  VercelApprovalDecision,
  VercelApprovalInput,
  VercelChunkInput,
  VercelInput,
  VercelMessageInput,
  VercelOutput,
  VercelRegenerateInput,
  VercelToolOutputChunk,
} from './events.js';
