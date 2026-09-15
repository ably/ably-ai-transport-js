/**
 * The Vercel codec's event union.
 *
 * The codec carries the AI SDK's own `UIMessageChunk` unchanged, so an agent
 * pipes the stream `toUIMessageStream` gives it and a client folds what it
 * decodes with the SDK's own reducer. One event of the codec's own joins the
 * union: `user-message`, a whole `UIMessage` a client publishes to start a
 * turn, so both directions of a conversation share one codec.
 */

import type * as AI from 'ai';

/**
 * Chunk types some supported AI SDK releases lack, declared structurally so
 * the codec's row table is the same on every one of them: the three v7 adds,
 * and `reset-step`, added within v7. On a release that has them they coincide
 * with the SDK's own members; on one that does not, they are members nothing
 * produces.
 */
export type VercelCrossMajorChunk =
  | { type: 'custom'; kind: `${string}.${string}`; providerMetadata?: AI.ProviderMetadata }
  | { type: 'reasoning-file'; url: string; mediaType: string; providerMetadata?: AI.ProviderMetadata }
  | { type: 'reset-step' }
  | {
      type: 'tool-approval-response';
      approvalId: string;
      approved: boolean;
      reason?: string;
      providerExecuted?: boolean;
      providerMetadata?: AI.ProviderMetadata;
    };

/**
 * A whole message a client publishes to start a turn, in the AI SDK's own
 * `UIMessage` type so the application folds it with the same machinery as the
 * agent's chunks.
 * @template TMetadata - Per-message metadata type.
 * @template TDataParts - Custom data-part types.
 * @template TTools - Tool set typing the message's tool parts.
 */
export interface VercelUserMessage<
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
  TTools extends AI.UITools = AI.UITools,
> {
  /** Discriminator. */
  type: 'user-message';
  /** The message, carried as the Ably message's `data`. */
  message: AI.UIMessage<TMetadata, TDataParts, TTools>;
}

/**
 * Every event the Vercel codec encodes and decodes: the AI SDK's
 * `UIMessageChunk` for the consumer's `UIMessage` type, the chunk types one
 * supported major lacks, and {@link VercelUserMessage}.
 * @template TMetadata - Per-message metadata type on lifecycle chunks and the user message.
 * @template TDataParts - Custom data-part types on `data-*` chunks and the user message.
 * @template TTools - Tool set typing the user message's tool parts.
 */
export type VercelEvent<
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
  TTools extends AI.UITools = AI.UITools,
> =
  | AI.InferUIMessageChunk<AI.UIMessage<TMetadata, TDataParts>>
  | VercelCrossMajorChunk
  | VercelUserMessage<TMetadata, TDataParts, TTools>;
