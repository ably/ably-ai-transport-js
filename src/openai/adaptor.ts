import {
  type AgentAdaptor,
  type AgentAdaptorOptions,
  type ChannelWriter,
  createAgentAdaptor,
} from '../core/adaptor/index.js';
import type { OpenAIEvent } from './codec/events.js';
import { openai } from './codec/index.js';

/**
 * Create an agent adaptor that publishes OpenAI Responses stream events and
 * input items on a channel.
 * @param channel - The channel to publish on. An `Ably.RealtimeChannel` satisfies it.
 * @param options - See {@link AgentAdaptorOptions}.
 * @returns The adaptor.
 * @throws {Ably.ErrorInfo} `InvalidArgument` when a default header value is not a string, number, boolean or null.
 */
export const openaiAdaptor = (channel: ChannelWriter, options?: AgentAdaptorOptions): AgentAdaptor<OpenAIEvent> =>
  createAgentAdaptor(channel, openai, options);
