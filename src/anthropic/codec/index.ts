/**
 * Anthropic Agent SDK codec — maps Agent SDK message types to/from
 * native Ably message primitives (publish, append, update, delete).
 *
 * ```ts
 * import { AgentCodec } from '@ably/ai-transport/anthropic';
 *
 * const encoder = AgentCodec.createEncoder(writer, options);
 * const decoder = AgentCodec.createDecoder();
 * const accumulator = AgentCodec.createAccumulator();
 * ```
 */

import type { Codec } from '../../core/codec/types.js';
import { createAccumulator } from './accumulator.js';
import { createDecoder } from './decoder.js';
import { createEncoder } from './encoder.js';
import type { AgentCodecEvent, AgentMessage } from './types.js';

/**
 * Anthropic Agent SDK codec implementing `Codec<AgentCodecEvent, AgentMessage>`.
 *
 * Provides factory methods for creating encoders, decoders, and accumulators
 * that map between Anthropic Agent SDK types and Ably's native message primitives.
 */
export const AgentCodec: Codec<AgentCodecEvent, AgentMessage> = {
  createEncoder,
  createDecoder,
  createAccumulator,

  // SDKAssistantMessage has uuid (required). SDKUserMessage has uuid (optional).
  // Fall back to session_id for user messages without uuid.
  getMessageKey: (message: AgentMessage): string => message.uuid ?? message.session_id,

  isTerminal: (event: AgentCodecEvent): boolean => event.type === 'result',
};
