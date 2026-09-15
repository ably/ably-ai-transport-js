/**
 * The OpenAI Responses codec's event union.
 *
 * The codec carries the Responses API's own stream events unchanged, apart
 * from `sequence_number`: that field orders events within one SSE connection,
 * which the Ably serial does here, so the wire does not carry it and a decoded
 * event does not have it. One event of the codec's own joins the union:
 * `input`, the Responses input items a client publishes to start a turn or
 * answer a function call, so both directions of a conversation share one codec.
 */

import type { Responses } from 'openai/resources/responses/responses';

/** Distributes over the union, making `sequence_number` optional on every member that has it. */
type WithOptionalSequenceNumber<T> = T extends { sequence_number: number }
  ? Omit<T, 'sequence_number'> & { sequence_number?: number }
  : T;

/**
 * A Responses stream event as the codec carries it: the SDK's own event with
 * `sequence_number` optional. An event straight from the SDK has it; a decoded
 * event does not.
 */
export type OpenAIStreamEvent = WithOptionalSequenceNumber<Responses.ResponseStreamEvent>;

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
