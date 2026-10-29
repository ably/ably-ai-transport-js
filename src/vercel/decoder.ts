import type * as AI from 'ai';

import { createDecoder, type Decoder, type DecoderOptions } from '../core/decoder/index.js';
import type { VercelEvent } from './codec/events.js';
import { createVercelCodec } from './codec/index.js';

/**
 * Create a decoder for what an agent published through the Vercel codec,
 * typed for the application's `UIMessage` generic parameters. Fold the events
 * it delivers with the AI SDK's own reducer.
 * @template TMetadata - Per-message metadata type.
 * @template TDataParts - Custom data-part types.
 * @template TTools - Tool set typing the user message's tool parts.
 * @param options - See {@link DecoderOptions}.
 * @returns The decoder.
 */
export const vercelDecoder = <
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
  TTools extends AI.UITools = AI.UITools,
>(
  options?: DecoderOptions,
): Decoder<VercelEvent<TMetadata, TDataParts, TTools>> =>
  createDecoder(createVercelCodec<TMetadata, TDataParts, TTools>(), options);
