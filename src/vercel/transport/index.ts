/**
 * Vercel AI SDK transport wrappers that pre-bind the UIMessageCodec.
 *
 * These are convenience factories so consumers don't need to pass the codec
 * explicitly when using the Vercel AI SDK integration.
 *
 * ```ts
 * import { createClientTransport } from '@ably/ai-transport/vercel';
 *
 * const transport = createClientTransport({ channel });
 * ```
 */

// Chat transport adapter
export type { ChatTransport, ChatTransportOptions, SendMessagesRequestContext } from './chat-transport.js';
export { createChatTransport } from './chat-transport.js';

import type * as AI from 'ai';

import { createClientTransport as createCoreClientTransport } from '../../core/transport/client/client-transport.js';
import type { ClientTransport, ClientTransportOptions } from '../../core/transport/client/types.js';
import { createServerTransport as createCoreServerTransport } from '../../core/transport/server/server-transport.js';
import type { ServerTransport, ServerTransportOptions } from '../../core/transport/server/types.js';
import { UIMessageCodec } from '../codec/index.js';

/** Options for creating a Vercel client transport. Same as core options but without the codec field. */
export type VercelClientTransportOptions = Omit<ClientTransportOptions<AI.UIMessageChunk, AI.UIMessage>, 'codec'>;

/** Options for creating a Vercel server transport. Same as core options but without the codec field. */
export type VercelServerTransportOptions = Omit<ServerTransportOptions<AI.UIMessageChunk, AI.UIMessage>, 'codec'>;

/**
 * Create a client-side transport pre-configured with the Vercel AI SDK codec.
 *
 * Equivalent to calling the core `createClientTransport` with `codec: UIMessageCodec`.
 * @param options - Configuration for the client transport (codec is provided automatically).
 * @returns A new {@link ClientTransport} for Vercel AI SDK UIMessage/UIMessageChunk types.
 */
export const createClientTransport = (
  options: VercelClientTransportOptions,
): ClientTransport<AI.UIMessageChunk, AI.UIMessage> => createCoreClientTransport({ ...options, codec: UIMessageCodec });

/**
 * Create a server-side transport pre-configured with the Vercel AI SDK codec.
 *
 * Equivalent to calling the core `createServerTransport` with `codec: UIMessageCodec`.
 * @param options - Configuration for the server transport (codec is provided automatically).
 * @returns A new {@link ServerTransport} for Vercel AI SDK UIMessage/UIMessageChunk types.
 */
export const createServerTransport = (
  options: VercelServerTransportOptions,
): ServerTransport<AI.UIMessageChunk, AI.UIMessage> => createCoreServerTransport({ ...options, codec: UIMessageCodec });
