/**
 * Anthropic Agent SDK transport wrappers that pre-bind the AgentCodec.
 *
 * These are convenience factories so consumers don't need to pass the codec
 * explicitly when using the Anthropic Agent SDK integration.
 *
 * ```ts
 * import { createClientTransport } from '@ably/ai-transport/anthropic';
 *
 * const transport = createClientTransport({ channel, clientId });
 * ```
 */

import { createClientTransport as createCoreClientTransport } from '../../core/transport/client-transport.js';
import { createServerTransport as createCoreServerTransport } from '../../core/transport/server-transport.js';
import type {
  ClientTransport,
  ClientTransportOptions,
  ServerTransport,
  ServerTransportOptions,
} from '../../core/transport/types.js';
import { AgentCodec } from '../codec/index.js';
import type { AgentCodecEvent, AgentMessage } from '../codec/types.js';

/** Options for creating an Anthropic client transport. Same as core options but without the codec field. */
export type AnthropicClientTransportOptions = Omit<ClientTransportOptions<AgentCodecEvent, AgentMessage>, 'codec'>;

/** Options for creating an Anthropic server transport. Same as core options but without the codec field. */
export type AnthropicServerTransportOptions = Omit<ServerTransportOptions<AgentCodecEvent, AgentMessage>, 'codec'>;

/**
 * Create a client-side transport pre-configured with the Anthropic Agent SDK codec.
 *
 * Equivalent to calling the core `createClientTransport` with `codec: AgentCodec`.
 * @param options - Configuration for the client transport (codec is provided automatically).
 * @returns A new {@link ClientTransport} for Anthropic Agent SDK types.
 */
export const createClientTransport = (
  options: AnthropicClientTransportOptions,
): ClientTransport<AgentCodecEvent, AgentMessage> => createCoreClientTransport({ ...options, codec: AgentCodec });

/**
 * Create a server-side transport pre-configured with the Anthropic Agent SDK codec.
 *
 * Equivalent to calling the core `createServerTransport` with `codec: AgentCodec`.
 * @param options - Configuration for the server transport (codec is provided automatically).
 * @returns A new {@link ServerTransport} for Anthropic Agent SDK types.
 */
export const createServerTransport = (
  options: AnthropicServerTransportOptions,
): ServerTransport<AgentCodecEvent, AgentMessage> => createCoreServerTransport({ ...options, codec: AgentCodec });
