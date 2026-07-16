/**
 * Vercel AI SDK transport wrappers that pre-bind the Vercel AI SDK codec.
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
import { createUIMessageCodec, type VercelInput, type VercelOutput, type VercelProjection } from '../codec/index.js';

/**
 * Core client session options with Vercel AI SDK types pre-applied.
 * @template TMetadata - Per-message metadata type.
 * @template TDataParts - Custom data-part types.
 * @template TTools - Tool set typing tool parts.
 */
type CoreClientOpts<TMetadata, TDataParts extends AI.UIDataTypes, TTools extends AI.UITools> = ClientSessionOptions<
  VercelInput<TMetadata, TDataParts, TTools>,
  VercelOutput<TMetadata, TDataParts>,
  VercelProjection<TMetadata, TDataParts, TTools>,
  AI.UIMessage<TMetadata, TDataParts, TTools>
>;

/**
 * Options for creating a Vercel client session. Same as core options but without the codec field.
 * @template TMetadata - Per-message metadata type (defaults to the SDK default).
 * @template TDataParts - Custom data-part types (defaults to the SDK default).
 * @template TTools - Tool set typing tool parts (defaults to the SDK default).
 */
export type VercelClientSessionOptions<
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
  TTools extends AI.UITools = AI.UITools,
> = Omit<CoreClientOpts<TMetadata, TDataParts, TTools>, 'codec'>;

/**
 * Options for creating a Vercel agent session. Same as core options but without the codec field.
 * @template TMetadata - Per-message metadata type (defaults to the SDK default).
 * @template TDataParts - Custom data-part types (defaults to the SDK default).
 * @template TTools - Tool set typing tool parts (defaults to the SDK default).
 */
export type VercelAgentSessionOptions<
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
  TTools extends AI.UITools = AI.UITools,
> = Omit<
  AgentSessionOptions<
    VercelInput<TMetadata, TDataParts, TTools>,
    VercelOutput<TMetadata, TDataParts>,
    VercelProjection<TMetadata, TDataParts, TTools>,
    AI.UIMessage<TMetadata, TDataParts, TTools>
  >,
  'codec'
>;

/**
 * Create a client-side session pre-configured with the Vercel AI SDK codec.
 *
 * Equivalent to calling the core `createClientSession` with the codec from
 * `createUIMessageCodec()`. The core session is a pure Ably-channel transport —
 * it never sends HTTP. To wake a serverless agent over HTTP, POST
 * `run.toInvocation().toJSON()` yourself, or use `createChatTransport` (which
 * does it for useChat parity).
 *
 * Supply `TMetadata` / `TDataParts` / `TTools` to strongly type the session's
 * messages (`session.view.getMessages()`); omit them for the SDK defaults.
 * @template TMetadata - Per-message metadata type (defaults to the SDK default).
 * @template TDataParts - Custom data-part types (defaults to the SDK default).
 * @template TTools - Tool set typing tool parts (defaults to the SDK default).
 * @param options - Configuration for the client session (codec is provided automatically).
 * @returns A new {@link ClientSession} for Vercel AI SDK UIMessage/UIMessageChunk types.
 */
export const createClientSession = <
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
  TTools extends AI.UITools = AI.UITools,
>(
  options: VercelClientSessionOptions<TMetadata, TDataParts, TTools>,
): ClientSession<
  VercelInput<TMetadata, TDataParts, TTools>,
  VercelOutput<TMetadata, TDataParts>,
  VercelProjection<TMetadata, TDataParts, TTools>,
  AI.UIMessage<TMetadata, TDataParts, TTools>
> => createCoreClientSession({ ...options, codec: createUIMessageCodec<TMetadata, TDataParts, TTools>() });

/**
 * Create an agent (server-side) session pre-configured with the Vercel AI SDK codec.
 *
 * Equivalent to calling the core `createAgentSession` with the codec from
 * `createUIMessageCodec()`.
 * @template TMetadata - Per-message metadata type (defaults to the SDK default).
 * @template TDataParts - Custom data-part types (defaults to the SDK default).
 * @template TTools - Tool set typing tool parts (defaults to the SDK default).
 * @param options - Configuration for the agent session (codec is provided automatically).
 * @returns A new {@link AgentSession} for Vercel AI SDK UIMessage/UIMessageChunk types.
 */
export const createAgentSession = <
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
  TTools extends AI.UITools = AI.UITools,
>(
  options: VercelAgentSessionOptions<TMetadata, TDataParts, TTools>,
): AgentSession<
  VercelOutput<TMetadata, TDataParts>,
  VercelProjection<TMetadata, TDataParts, TTools>,
  AI.UIMessage<TMetadata, TDataParts, TTools>
> => createCoreAgentSession({ ...options, codec: createUIMessageCodec<TMetadata, TDataParts, TTools>() });
