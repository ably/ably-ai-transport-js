/**
 * A faithful test stand-in for `DefaultView.loadUntil`, for tests that mock a
 * {@link View} rather than build a real one. The production primitive is
 * unit-tested directly in `test/core/transport/view.test.ts` and exercised
 * end-to-end in the agent-session integration test; this mirror lets a mocked
 * View satisfy the same contract so hook tests can drive it.
 *
 * It pages via the mock's own `loadOlder(1)` (matching production, so a
 * `loadOlder` spy still observes the calls) until a visible message matches the
 * predicate — the seam — then resolves to the messages strictly newer than it;
 * the whole window when nothing matches. Like production it treats the seam as an
 * **exclusive floor**: on a match it trims the mock's window past the seam (via
 * the optional `hideOldest`) so the mock's `getMessages()` then reports exactly
 * the returned tail. Pass `hideOldest` for any mock whose window can hold the seam
 * or older history; omit it only when no seam can match (no seed supplied).
 */

import type { CodecMessage } from '../../src/core/transport/session-codec.js';

/**
 * Build a `loadUntil` implementation over a mock view's own read accessors.
 * @param accessors - The mock's window accessors.
 * @param accessors.getMessages - Returns the current visible window, oldest-first.
 * @param accessors.hasOlder - Whether older history remains to page.
 * @param accessors.loadOlder - Reveals older messages and returns the page, oldest-first.
 * @param accessors.hideOldest - Hide the oldest `count` messages of the window (models the exclusive-floor trim) and emit `update`. Optional.
 * @returns A `loadUntil(predicate, signal?)` matching the {@link View.loadUntil} contract.
 */
export const makeFakeLoadUntil =
  <TMessage>(accessors: {
    getMessages: () => CodecMessage<TMessage>[];
    hasOlder: () => boolean;
    loadOlder: (limit?: number) => Promise<CodecMessage<TMessage>[]>;
    hideOldest?: (count: number) => void;
  }) =>
  async (
    predicate: (message: CodecMessage<TMessage>) => boolean,
    signal?: AbortSignal,
  ): Promise<CodecMessage<TMessage>[]> => {
    const { getMessages, hasOlder, loadOlder, hideOldest } = accessors;
    if (signal?.aborted) return [];
    const tailAtSeam = (page: CodecMessage<TMessage>[]): CodecMessage<TMessage>[] | undefined => {
      const idx = page.findIndex((m) => predicate(m));
      if (idx === -1) return undefined;
      // `page` is the window's oldest-end prefix, so the match's index within it
      // is its window index; the tail is everything strictly newer.
      const tail = getMessages().slice(idx + 1);
      // Exclusive floor: hide the seam and everything older so the mock's window
      // now equals the tail, mirroring DefaultView.loadUntil.
      hideOldest?.(idx + 1);
      return tail;
    };
    const initial = tailAtSeam(getMessages());
    if (initial !== undefined) return initial;
    while (hasOlder()) {
      if (signal?.aborted) return [];
      const tail = tailAtSeam(await loadOlder(1));
      if (tail !== undefined) return tail;
    }
    return [...getMessages()];
  };
