import type * as AGUI from '@ag-ui/core';

import {
  type AgentAdaptor,
  type AgentAdaptorOptions,
  type ChannelWriter,
  createAgentAdaptor,
} from '../core/adaptor/index.js';
import { agui } from './codec/index.js';

/**
 * Create an agent adaptor that publishes AG-UI events on a channel.
 * @param channel - The channel to publish on. An `Ably.RealtimeChannel` satisfies it.
 * @param options - See {@link AgentAdaptorOptions}.
 * @returns The adaptor.
 * @throws {Ably.ErrorInfo} `InvalidArgument` when a default header value is not a string, number, boolean or null.
 */
export const agUiAdaptor = (channel: ChannelWriter, options?: AgentAdaptorOptions): AgentAdaptor<AGUI.Event> =>
  createAgentAdaptor(channel, agui, options);
