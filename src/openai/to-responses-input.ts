/**
 * Convert a conversation (`run.loadConversation()` returns `OpenAITurn[]`) into
 * the `input` array for an OpenAI `/v1/responses` call.
 *
 * This is near-identity: a turn's items are already OpenAI items, and OpenAI's
 * output items are themselves valid model input (§5 of the recommendations), so
 * the conversation is essentially the model input already — just concatenate
 * each turn's items in order.
 */

import type { Responses } from 'openai/resources/responses/responses';

import type { OpenAITurn } from './codec/index.js';

/**
 * Flatten a conversation into OpenAI Responses model input.
 * @param turns - The conversation turns (from `run.loadConversation()`).
 * @returns The concatenated items as a Responses `input` array.
 */
export const toResponsesInput = (turns: OpenAITurn[]): Responses.ResponseInputItem[] =>
  // CAST: a turn's items are typed `ResponseOutputItem | ResponseInputItem`, but
  // OpenAI's output items are valid model input (§5), so every item is a valid
  // `ResponseInputItem` at runtime. The two are distinct OpenAI unions and
  // neither is a subtype of the other, so TypeScript cannot prove this.
  // TODO(AIT-742): understand this bridge properly — either derive that the
  // items we ever store are always valid input, or tighten `OpenAIItem` to a
  // curated subset of `ResponseInputItem` so this cast disappears (see the
  // build log; note it would relocate the cast into the reducer).
  turns.flatMap((turn) => turn.items) as Responses.ResponseInputItem[];
