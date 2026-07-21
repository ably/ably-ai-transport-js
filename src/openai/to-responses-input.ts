/**
 * Convert a conversation (the `OpenAITurn[]` read from a drained `run.view`)
 * into the `input` array for an OpenAI `/v1/responses` call.
 *
 * The body is a plain flatten; the value of this function is its *signature*.
 * `OpenAIItem` is curated so every stored item is a `ResponseInputItem`, and
 * this return type is where the type system proves it: the flatten of
 * `OpenAIItem[]`s only assigns to `ResponseInputItem[]` while that invariant
 * holds, so adding a non-input member to `OpenAIItem` breaks the build here, at
 * the boundary the invariant is about. That is why there is no cast, and why
 * this stays a named boundary rather than an inline `flatMap`.
 */

import type { Responses } from 'openai/resources/responses/responses';

import type { OpenAITurn } from './codec/index.js';

/**
 * Flatten a conversation into OpenAI Responses model input.
 * @param turns - The conversation turns (a drained `run.view`'s messages).
 * @returns The concatenated items as a Responses `input` array.
 */
export const toResponsesInput = (turns: OpenAITurn[]): Responses.ResponseInputItem[] =>
  turns.flatMap((turn) => turn.items);
