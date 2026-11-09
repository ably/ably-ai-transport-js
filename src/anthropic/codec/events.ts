/**
 * The Anthropic Messages codec's event union.
 *
 * The union is the Messages API's own stream events, as the SDK declares them.
 * One event of the codec's own joins them: `input`, the messages a client
 * publishes to start a turn or answer a tool call, so both directions of a
 * conversation share one codec.
 */

import type * as Anthropic from '@anthropic-ai/sdk/resources/messages';

/**
 * A Messages stream event as the codec carries it: the SDK's own event, with
 * every field it declares.
 */
export type AnthropicStreamEvent = Anthropic.RawMessageStreamEvent;

/**
 * The messages a client publishes: a user message to start a turn, or one
 * whose `tool_result` blocks answer the tool calls of the turn before it, in
 * the Messages API's own param type so the agent passes them to the model as
 * they are.
 */
export interface AnthropicInput {
  /** Discriminator, distinct from every Messages stream event type. */
  type: 'input';
  /** The messages, carried as the Ably message's `data`. */
  messages: Anthropic.MessageParam[];
}

/** Every event the Anthropic codec encodes and decodes. */
export type AnthropicEvent = AnthropicStreamEvent | AnthropicInput;
