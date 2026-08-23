/**
 * The session layer's Vercel codec — the full reducer + factory codec the
 * sessions and the Tree consume, assembled from the session input taxonomy
 * (`session-events.ts` / `session-inputs.ts`) and the shared output table.
 * The public wire codec lives in `index.ts`; this factory exists for the
 * session layer alone.
 */

import type * as AI from 'ai';

import type { DefinedCodec } from '../../core/transport/session-codec.js';
import { defineSessionCodec } from '../../core/transport/session-codec.js';
import { createVercelDecodeLifecycle } from './decode-lifecycle.js';
import type { VercelOutput } from './events.js';
import { outputs } from './outputs.js';
import type { VercelProjection } from './reducer.js';
import { fold, getMessages, init } from './reducer.js';
import type { VercelSessionInput } from './session-events.js';
import { sessionInputs } from './session-inputs.js';

/**
 * Create the session layer's Vercel codec, implementing the full
 * `Codec<VercelSessionInput, VercelOutput, VercelProjection, AI.UIMessage>`
 * contract, optionally specialised to a consumer's `AI.UIMessage` generic
 * parameters.
 * @template TMetadata - Per-message metadata type (defaults to the SDK default).
 * @template TDataParts - Custom data-part types (defaults to the SDK default).
 * @template TTools - Tool set typing tool parts (defaults to the SDK default).
 * @returns A session codec specialised to the given `AI.UIMessage` parameters.
 */
export const createUIMessageSessionCodec = <
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
  TTools extends AI.UITools = AI.UITools,
>(): DefinedCodec<
  VercelSessionInput<TMetadata, TDataParts, TTools>,
  VercelOutput<TMetadata, TDataParts>,
  VercelProjection<TMetadata, TDataParts, TTools>,
  AI.UIMessage<TMetadata, TDataParts, TTools>
> => {
  // The reducer and descriptor tables reconstruct messages identically for
  // every instantiation of the UIMessage generic params — they refine
  // `metadata` / `parts` at the type level only — so assemble the codec once
  // at the SDK-default instantiation.
  const codec = defineSessionCodec<VercelSessionInput, VercelOutput>()({
    // Spec: AIT-CT1a3, AIT-ST1a3 — registers this codec as an Ably agent.
    adapterTag: 'vercel-ai-sdk-ui-message',
    reducer: { init, fold, getMessages },
    output: outputs,
    input: sessionInputs,
    // Full codec: its TInput carries every well-known variant, so it exposes the
    // complete factory set unchanged.
    factories: (base) => base,
    decoderSynthesiseLifecycle: createVercelDecodeLifecycle,
  });
  // CAST: the runtime codec is the same object for every instantiation; TS
  // can't relate the default-typed value to the specialised shape (the
  // reducer's `getMessages` return type is invariant across the params), so
  // assert it here — the single boundary that reconstructs the generic surface.
  return codec as unknown as DefinedCodec<
    VercelSessionInput<TMetadata, TDataParts, TTools>,
    VercelOutput<TMetadata, TDataParts>,
    VercelProjection<TMetadata, TDataParts, TTools>,
    AI.UIMessage<TMetadata, TDataParts, TTools>
  >;
};
