/**
 * Convert a conversation (the `OpenAIMessage[]` read from a drained `run.view`)
 * into the `input` array for an OpenAI `/v1/responses` call.
 *
 * The body is a plain flatten. The value of this function is its signature.
 * `OpenAIItem` is curated so every stored item is a `ResponseInputItem`, and
 * this return type is where the type system proves it: the flatten of
 * `OpenAIItem[]`s only assigns to `ResponseInputItem[]` while that invariant
 * holds, so adding a non-input member to `OpenAIItem` breaks the build here.
 * That is why there is no cast, and why this stays a named function rather than
 * an inline `flatMap`.
 */

import type { Responses } from 'openai/resources/responses/responses';

import type { OpenAIMessage } from './codec/index.js';

/**
 * Flatten a conversation into OpenAI Responses model input.
 * @param messages - The conversation messages (a drained `run.view`'s messages).
 * @returns The concatenated items as a Responses `input` array.
 */
export const toResponsesInput = (messages: OpenAIMessage[]): Responses.ResponseInputItem[] =>
  messages.flatMap((message) => message.items);
