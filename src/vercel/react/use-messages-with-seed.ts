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

/** Options for the Vercel {@link useMessagesWithSeed}. */
export interface UseMessagesWithSeedOptions {
  /**
   * The {@link View} over the live channel to reconcile against (e.g.
   * `session.view`), or `undefined` before it resolves.
   */
  view: View<AI.UIMessage> | undefined;
  /**
   * The persisted conversation (the seed), oldest-first; an empty array surfaces
   * the live channel window unchanged.
   */
  seed: AI.UIMessage[];
}

const uiMessageId = (message: AI.UIMessage): string => message.id;

/**
 * Reconcile a persisted `UIMessage` seed with the live channel; see
 * {@link useMessagesWithSeedCore}.
 * @param options - The view and the seed.
 * @param options.view - The {@link View} over the live channel, or `undefined` before it resolves.
 * @param options.seed - The persisted conversation (the seed), oldest-first.
 * @returns The composed conversation, oldest-first.
 */
export const useMessagesWithSeed = ({ view, seed }: UseMessagesWithSeedOptions): AI.UIMessage[] =>
  useMessagesWithSeedCore({ view, seed, getMessageId: uiMessageId });
