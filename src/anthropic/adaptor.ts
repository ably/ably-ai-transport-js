import {
  type AgentAdaptor,
  type AgentAdaptorOptions,
  type ChannelWriter,
  createAgentAdaptor,
} from '../core/adaptor/index.js';
import type { AnthropicEvent } from './codec/events.js';
import { anthropic } from './codec/index.js';

/**
 * Create an agent adaptor that publishes Anthropic Messages stream events and
 * input messages on a channel.
 * @param channel - The channel to publish on. An `Ably.RealtimeChannel` satisfies it.
 * @param options - See {@link AgentAdaptorOptions}.
 * @returns The adaptor.
 * @throws {Ably.ErrorInfo} `InvalidArgument` when a default header value is not a string, number, boolean or null.
 */
export const anthropicAdaptor = (channel: ChannelWriter, options?: AgentAdaptorOptions): AgentAdaptor<AnthropicEvent> =>
  createAgentAdaptor(channel, anthropic, options);
