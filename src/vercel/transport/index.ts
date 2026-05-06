/**
 * Vercel AI SDK transport wrappers that pre-bind the UIMessageCodec.
 *
 * These are convenience factories so consumers don't need to pass the codec
 * explicitly when using the Vercel AI SDK integration.
 *
 * ```ts
 * import { createClientSession } from '@ably/ai-transport/vercel';
 *
 * const session = createClientSession({ client, channelName: 'ai:demo' });
 * await session.connect();
 * ```
 */

// Chat transport adapter
export type { ChatTransport, ChatTransportOptions, SendMessagesRequestContext } from './chat-transport.js';
export { createChatTransport } from './chat-transport.js';

import type * as AI from 'ai';

import { createAgentSession as createCoreAgentSession } from '../../core/transport/agent-session.js';
import { createClientSession as createCoreClientSession } from '../../core/transport/client-session.js';
import type {
  AgentSession,
  AgentSessionOptions,
  ClientSession,
  ClientSessionOptions,
} from '../../core/transport/types.js';
import { UIMessageCodec } from '../codec/index.js';

/** Core client session options with Vercel AI SDK types pre-applied. */
type CoreClientOpts = ClientSessionOptions<AI.UIMessageChunk, AI.UIMessage>;

/** Options for creating a Vercel client session. Same as core options but without the codec field, and with `api` optional (defaults to `"/api/chat"`). */
export type VercelClientSessionOptions = Omit<CoreClientOpts, 'codec' | 'api'> & Partial<Pick<CoreClientOpts, 'api'>>;

/** Options for creating a Vercel agent session. Same as core options but without the codec field. */
export type VercelAgentSessionOptions = Omit<AgentSessionOptions<AI.UIMessageChunk, AI.UIMessage>, 'codec'>;

export const DEFAULT_VERCEL_API = '/api/chat';

/**
 * Create a client-side session pre-configured with the Vercel AI SDK codec.
 *
 * Equivalent to calling the core `createClientSession` with `codec: UIMessageCodec`.
 * @param options - Configuration for the client session (codec is provided automatically).
 * @returns A new {@link ClientSession} for Vercel AI SDK UIMessage/UIMessageChunk types.
 */
export const createClientSession = (
  options: VercelClientSessionOptions,
): ClientSession<AI.UIMessageChunk, AI.UIMessage> =>
  createCoreClientSession({
    ...options,
    codec: UIMessageCodec,
    // Mirrors the Vercel AI SDK's DefaultChatTransport default.
    api: options.api ?? DEFAULT_VERCEL_API,
  });

/**
 * Create an agent (server-side) session pre-configured with the Vercel AI SDK codec.
 *
 * Equivalent to calling the core `createAgentSession` with `codec: UIMessageCodec`.
 * @param options - Configuration for the agent session (codec is provided automatically).
 * @returns A new {@link AgentSession} for Vercel AI SDK UIMessage/UIMessageChunk types.
 */
export const createAgentSession = (options: VercelAgentSessionOptions): AgentSession<AI.UIMessageChunk, AI.UIMessage> =>
  createCoreAgentSession({ ...options, codec: UIMessageCodec });
