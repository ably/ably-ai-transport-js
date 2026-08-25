/**
 * Vercel AI SDK transport wrappers that pre-bind the Vercel AI SDK codec.
 *
 * These are convenience factories so consumers don't need to pass the codec
 * explicitly when using the Vercel AI SDK integration.
 *
 * ```ts
 * import { createClientTransport } from '@ably/ai-transport/vercel';
 *
 * const transport = createClientTransport({ channel });
 * await transport.connect();
 * ```
 */

// Chat transport adapter
export type { ChatTransport, ChatTransportOptions } from './chat-transport.js';
export { createChatTransport } from './chat-transport.js';

import type * as AI from 'ai';

import type { AgentTransportOptions } from '../../core/transport/agent-transport.js';
import { createAgentTransport as createCoreAgentTransport } from '../../core/transport/agent-transport.js';
import type { ClientTransportOptions } from '../../core/transport/client-transport.js';
import { createClientTransport as createCoreClientTransport } from '../../core/transport/client-transport.js';
import type { AgentTransport, ClientTransport } from '../../core/transport/types.js';
import type { VercelInput, VercelOutput } from '../codec/index.js';
import { createUIMessageCodec } from '../codec/index.js';

/**
 * Options for creating a Vercel client transport: the core options without
 * the codec field, which is provided automatically.
 * @template TMetadata - Per-message metadata type (defaults to the SDK default).
 * @template TDataParts - Custom data-part types (defaults to the SDK default).
 * @template TTools - Tool set typing tool parts (defaults to the SDK default).
 */
export type VercelClientTransportOptions<
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
  TTools extends AI.UITools = AI.UITools,
> = Omit<
  ClientTransportOptions<VercelInput<TMetadata, TDataParts, TTools>, VercelOutput<TMetadata, TDataParts>>,
  'codec'
>;

/**
 * Options for creating a Vercel agent transport: the core options without
 * the codec field, which is provided automatically.
 * @template TMetadata - Per-message metadata type (defaults to the SDK default).
 * @template TDataParts - Custom data-part types (defaults to the SDK default).
 * @template TTools - Tool set typing tool parts (defaults to the SDK default).
 */
export type VercelAgentTransportOptions<
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
  TTools extends AI.UITools = AI.UITools,
> = Omit<
  AgentTransportOptions<VercelInput<TMetadata, TDataParts, TTools>, VercelOutput<TMetadata, TDataParts>>,
  'codec'
>;

/**
 * Create a client transport pre-configured with the Vercel AI SDK codec —
 * equivalent to the core `createClientTransport` with the codec from
 * `createUIMessageCodec()`.
 * @template TMetadata - Per-message metadata type (defaults to the SDK default).
 * @template TDataParts - Custom data-part types (defaults to the SDK default).
 * @template TTools - Tool set typing tool parts (defaults to the SDK default).
 * @param options - The core client transport options, codec omitted.
 * @returns A client transport for Vercel AI SDK UIMessage/UIMessageChunk types.
 */
export const createClientTransport = <
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
  TTools extends AI.UITools = AI.UITools,
>(
  options: VercelClientTransportOptions<TMetadata, TDataParts, TTools>,
): ClientTransport<VercelInput<TMetadata, TDataParts, TTools>, VercelOutput<TMetadata, TDataParts>> =>
  createCoreClientTransport({ ...options, codec: createUIMessageCodec<TMetadata, TDataParts, TTools>() });

/**
 * Create an agent transport pre-configured with the Vercel AI SDK codec —
 * equivalent to the core `createAgentTransport` with the codec from
 * `createUIMessageCodec()`.
 * @template TMetadata - Per-message metadata type (defaults to the SDK default).
 * @template TDataParts - Custom data-part types (defaults to the SDK default).
 * @template TTools - Tool set typing tool parts (defaults to the SDK default).
 * @param options - The core agent transport options, codec omitted.
 * @returns An agent transport for Vercel AI SDK UIMessage/UIMessageChunk types.
 */
export const createAgentTransport = <
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
  TTools extends AI.UITools = AI.UITools,
>(
  options: VercelAgentTransportOptions<TMetadata, TDataParts, TTools>,
): AgentTransport<VercelInput<TMetadata, TDataParts, TTools>, VercelOutput<TMetadata, TDataParts>> =>
  createCoreAgentTransport({ ...options, codec: createUIMessageCodec<TMetadata, TDataParts, TTools>() });
