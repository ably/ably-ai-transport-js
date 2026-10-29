import type * as AI from 'ai';

import {
  type AgentAdaptor,
  type AgentAdaptorOptions,
  type ChannelWriter,
  createAgentAdaptor,
} from '../core/adaptor/index.js';
import type { VercelEvent } from './codec/events.js';
import { createVercelCodec } from './codec/index.js';

/**
 * Create an agent adaptor that publishes Vercel AI SDK `UIMessageChunk`s and
 * user messages on a channel, typed for the application's `UIMessage` generic
 * parameters.
 * @template TMetadata - Per-message metadata type.
 * @template TDataParts - Custom data-part types.
 * @template TTools - Tool set typing the user message's tool parts.
 * @param channel - The channel to publish on. An `Ably.RealtimeChannel` satisfies it.
 * @param options - See {@link AgentAdaptorOptions}.
 * @returns The adaptor.
 * @throws {Ably.ErrorInfo} `InvalidArgument` when a default header value is not a string, number, boolean or null.
 */
export const vercelAdaptor = <
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
  TTools extends AI.UITools = AI.UITools,
>(
  channel: ChannelWriter,
  options?: AgentAdaptorOptions,
): AgentAdaptor<VercelEvent<TMetadata, TDataParts, TTools>> =>
  createAgentAdaptor(channel, createVercelCodec<TMetadata, TDataParts, TTools>(), options);
