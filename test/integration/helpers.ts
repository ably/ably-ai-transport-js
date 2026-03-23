/**
 * Integration test helpers for decoder output extraction.
 */

import type * as AI from 'ai';

import type { DecoderOutput } from '../../src/core/codec/types.js';

type EventOutput = Extract<DecoderOutput<AI.UIMessageChunk, AI.UIMessage>, { kind: 'event' }>;

const isEventOutput = (o: DecoderOutput<AI.UIMessageChunk, AI.UIMessage>): o is EventOutput => o.kind === 'event';

/**
 * Extract event types from decoder outputs.
 * @param outputs - Decoder outputs to extract from.
 * @returns Array of event type strings.
 */
export const eventTypesOf = (outputs: DecoderOutput<AI.UIMessageChunk, AI.UIMessage>[]): string[] =>
  outputs.filter((o) => isEventOutput(o)).map((o) => o.event.type);

/**
 * Extract events from decoder outputs.
 * @param outputs - Decoder outputs to extract from.
 * @returns Array of UIMessageChunk events.
 */
export const eventsOf = (outputs: DecoderOutput<AI.UIMessageChunk, AI.UIMessage>[]): AI.UIMessageChunk[] =>
  outputs.filter((o) => isEventOutput(o)).map((o) => o.event);
