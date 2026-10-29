import { createDecoder, type Decoder, type DecoderOptions } from '../core/decoder/index.js';
import type { OpenAIEvent } from './codec/events.js';
import { openai } from './codec/index.js';

/**
 * Create a decoder for what an agent published through the OpenAI Responses
 * codec.
 * @param options - See {@link DecoderOptions}.
 * @returns The decoder.
 */
export const openaiDecoder = (options?: DecoderOptions): Decoder<OpenAIEvent> => createDecoder(openai, options);
