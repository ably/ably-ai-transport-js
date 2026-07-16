/**
 * useMessagesWithSeed (Vercel) — the {@link useMessagesWithSeedCore} reconciliation
 * pre-typed for the Vercel AI SDK's `UIMessage`, whose domain `id` is the seam
 * key, so callers don't supply `getMessageId`.
 *
 * Seed it from your store and a {@link View} over the live channel (e.g.
 * `session.view`); it returns the composed conversation (`seed ⧺ live tail`).
 * `useMessageSync` builds on this, adding the `useChat` overlay merge and the
 * streaming gate.
 */

import type * as AI from 'ai';

import type { View } from '../../core/transport/types.js';
import { useMessagesWithSeed as useMessagesWithSeedCore } from '../../react/use-messages-with-seed.js';

/**
 * Options for the Vercel {@link useMessagesWithSeed}.
 * @template TMetadata - Per-message metadata type on the view/seed messages.
 * @template TDataParts - Custom data-part types on the view/seed messages.
 * @template TTools - Tool set typing the view/seed messages' tool parts.
 */
export interface UseMessagesWithSeedOptions<
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
  TTools extends AI.UITools = AI.UITools,
> {
  /**
   * The {@link View} over the live channel to reconcile against (e.g.
   * `session.view`), or `undefined` before it resolves.
   */
  view: View<AI.UIMessage<TMetadata, TDataParts, TTools>> | undefined;
  /**
   * The persisted conversation (the seed), oldest-first; an empty array surfaces
   * the live channel window unchanged. While the seed is still loading, set
   * {@link skip} rather than passing `[]`.
   */
  seed: AI.UIMessage<TMetadata, TDataParts, TTools>[];
  /**
   * Hold the reconciliation while the seed is still loading (e.g. an async store
   * fetch). When `true` the hook does not walk the channel and returns `[]`;
   * clear it once the seed has loaded. Distinct from an empty `seed` (a
   * loaded-but-empty conversation). Defaults to `false`.
   */
  skip?: boolean;
}

const uiMessageId = (message: AI.UIMessage): string => message.id;

/**
 * Reconcile a persisted `UIMessage` seed with the live channel; see
 * {@link useMessagesWithSeedCore}.
 * @template TMetadata - Per-message metadata type on the view/seed messages.
 * @template TDataParts - Custom data-part types on the view/seed messages.
 * @template TTools - Tool set typing the view/seed messages' tool parts.
 * @param options - The view and the seed.
 * @param options.view - The {@link View} over the live channel, or `undefined` before it resolves.
 * @param options.seed - The persisted conversation (the seed), oldest-first.
 * @param options.skip - Hold the reconciliation while the seed is still loading.
 * @returns The composed conversation, oldest-first.
 */
export const useMessagesWithSeed = <
  TMetadata = unknown,
  TDataParts extends AI.UIDataTypes = AI.UIDataTypes,
  TTools extends AI.UITools = AI.UITools,
>({
  view,
  seed,
  skip,
}: UseMessagesWithSeedOptions<TMetadata, TDataParts, TTools>): AI.UIMessage<TMetadata, TDataParts, TTools>[] =>
  useMessagesWithSeedCore<AI.UIMessage<TMetadata, TDataParts, TTools>>({ view, seed, getMessageId: uiMessageId, skip });
