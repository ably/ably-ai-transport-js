/**
 * The OpenAI Responses codec's event union.
 *
 * The union is the Responses API's own stream events, as the SDK declares
 * them. One event of the codec's own joins them: `input`, the Responses input
 * items a client publishes to start a turn or answer a function call, so both
 * directions of a conversation share one codec.
 */

import type { Responses } from 'openai/resources/responses/responses';

/**
 * A Responses stream event as the codec carries it: the SDK's own event, with
 * every field it declares.
 */
export type OpenAIStreamEvent = Responses.ResponseStreamEvent;

/**
 * The input items a client publishes: a user message to start a turn, or a
 * `function_call_output` answering a function call, in the Responses API's own
 * input item type so the agent passes them to the model as they are.
 */
export interface OpenAIInput {
  /** Discriminator, distinct from every Responses stream event type. */
  type: 'input';
  /** The items, carried as the Ably message's `data`. */
  items: Responses.ResponseInputItem[];
}

/** Every event the OpenAI codec encodes and decodes. */
export type OpenAIEvent = OpenAIStreamEvent | OpenAIInput;
