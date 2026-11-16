import { createDecoder, type Decoder, type DecoderOptions } from '../core/decoder/index.js';
import type { AnthropicEvent } from './codec/events.js';
import { anthropic } from './codec/index.js';

/**
 * Create a decoder for what an agent published through the Anthropic Messages
 * codec.
 * @param options - See {@link DecoderOptions}.
 * @returns The decoder.
 */
export const anthropicDecoder = (options?: DecoderOptions): Decoder<AnthropicEvent> =>
  createDecoder(anthropic, options);
