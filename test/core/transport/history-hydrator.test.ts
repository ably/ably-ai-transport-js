/**
 * HistoryHydrator unit tests.
 *
 * The hydrator pages one shared backward cursor over the channel and folds each
 * page into the Tree (chronological, oldest-first within a page) via the Tree's
 * applier. These tests cover the `foldUntil` stop predicate, truthful `hasNext`
 * exhaustion, the single-flight shared cursor (concurrent callers page the
 * channel once and resume one another), prompt cancel-mid-drain, and fetch-error
 * wrapping. The low-level `loadHistoryPages` cursor is mocked so the engine's
 * paging logic is exercised in isolation.
 */

import type * as Ably from 'ably';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AblyMessageEmitter, WireApplier } from '../../../src/core/transport/decode-fold.js';
import { createHistoryHydrator } from '../../../src/core/transport/history-hydrator.js';
import type { HistoryPagesCursor } from '../../../src/core/transport/load-history-pages.js';
import { loadHistoryPages } from '../../../src/core/transport/load-history-pages.js';
import { ErrorCode } from '../../../src/errors.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';
import { makeHistoryCursor as makeCursor } from '../../helper/history-cursor.js';

vi.mock('../../../src/core/transport/load-history-pages.js', () => ({
  loadHistoryPages: vi.fn(),
}));

const silentLogger = makeLogger({ logLevel: LogLevel.Silent });

// ---------------------------------------------------------------------------
// Wire builders + fakes
// ---------------------------------------------------------------------------

let serialCounter = 0;

// A bare inbound wire carrying just a serial.
const wire = (): Ably.InboundMessage => {
  serialCounter += 1;
  return { serial: `01H${String(serialCounter).padStart(10, '0')}` } as unknown as Ably.InboundMessage;
};

// A spy applier whose `apply` records the wires it folded, in order.
const makeApplier = (): WireApplier & { folded: Ably.InboundMessage[] } => {
  const folded: Ably.InboundMessage[] = [];
  return {
    apply: (msg: Ably.InboundMessage) => {
      folded.push(msg);
      return;
    },
    folded,
  };
};

const serialsOf = (msgs: readonly Ably.InboundMessage[]): (string | undefined)[] => msgs.map((m) => m.serial);

// Wire a hydrator over a fake cursor + applier, returning the `emitAblyMessage`
// spy so a test can assert per-fold tree notifications.
const newHydrator = (
  cursor: HistoryPagesCursor,
  applier: WireApplier,
): { hydrator: ReturnType<typeof createHistoryHydrator>; emitAblyMessage: ReturnType<typeof vi.fn> } => {
  vi.mocked(loadHistoryPages).mockResolvedValue(cursor);
  const emitAblyMessage = vi.fn();
  const tree: AblyMessageEmitter = { emitAblyMessage };
  const hydrator = createHistoryHydrator({
    channel: {} as unknown as Ably.RealtimeChannel,
    tree,
    applier,
    logger: silentLogger,
  });
  return { hydrator, emitAblyMessage };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HistoryHydrator', () => {
  beforeEach(() => {
    serialCounter = 0;
  });

  afterEach(() => {
    vi.mocked(loadHistoryPages).mockReset();
  });

  describe('foldUntil', () => {
    it('folds each page into the tree in chronological (oldest-first) order', async () => {
      // One page delivered newest-first; folding reverses to chronological.
      const w3 = wire();
      const w2 = wire();
      const w1 = wire();
      const applier = makeApplier();
      const { hydrator, emitAblyMessage } = newHydrator(makeCursor([[w3, w2, w1]]), applier);

      const { exhausted } = await hydrator.foldUntil(() => false);

      expect(serialsOf(applier.folded)).toEqual(serialsOf([w1, w2, w3]));
      // foldAndEmit notifies the tree after each apply.
      expect(emitAblyMessage).toHaveBeenCalledTimes(3);
      expect(exhausted).toBe(true);
    });

    it('opens the cursor only once and only on the first fold', async () => {
      const applier = makeApplier();
      const { hydrator } = newHydrator(makeCursor([[wire()]]), applier);

      expect(loadHistoryPages).not.toHaveBeenCalled();
      await hydrator.foldUntil(() => false);
      expect(loadHistoryPages).toHaveBeenCalledTimes(1);
    });

    it('stops before fetching the next page once shouldStop returns true', async () => {
      const applier = makeApplier();
      const cursor = makeCursor([[wire()], [wire()]]);
      const { hydrator } = newHydrator(cursor, applier);

      // Predicate (polled before each page) trips once the first page is folded.
      const { exhausted } = await hydrator.foldUntil(() => applier.folded.length > 0);

      expect(applier.folded).toHaveLength(1);
      expect(cursor.nextCalls()).toBe(1); // the second page was never fetched
      expect(exhausted).toBe(false);
      expect(hydrator.hasNext()).toBe(true); // paused, not exhausted
    });
  });

  describe('hasNext', () => {
    it('is true before the cursor is opened', () => {
      const { hydrator } = newHydrator(makeCursor([[wire()]]), makeApplier());
      expect(hydrator.hasNext()).toBe(true);
    });

    it('is false once the channel is drained to exhaustion', async () => {
      const { hydrator } = newHydrator(makeCursor([[wire()], [wire()]]), makeApplier());
      await hydrator.foldUntil(() => false);
      expect(hydrator.hasNext()).toBe(false);
    });
  });

  describe('single-flight shared cursor', () => {
    it('resumes the shared cursor across sequential calls (one open, no re-page)', async () => {
      const wA = wire();
      const wB = wire();
      const applier = makeApplier();
      const cursor = makeCursor([[wA], [wB]]);
      const { hydrator } = newHydrator(cursor, applier);

      // First call stops after the first page; the cursor pauses, not exhausted.
      const first = await hydrator.foldUntil(() => applier.folded.length > 0);
      expect(first.exhausted).toBe(false);
      expect(serialsOf(applier.folded)).toEqual(serialsOf([wA]));

      // Second call resumes from the paused position and drains the rest.
      const second = await hydrator.foldUntil(() => false);
      expect(second.exhausted).toBe(true);
      expect(serialsOf(applier.folded)).toEqual(serialsOf([wA, wB]));

      // The channel was opened once and each page fetched exactly once.
      expect(loadHistoryPages).toHaveBeenCalledTimes(1);
      expect(cursor.nextCalls()).toBe(2);
    });

    it('serialises concurrent calls so each wire folds exactly once', async () => {
      const wA = wire();
      const wB = wire();
      const applier = makeApplier();
      const cursor = makeCursor([[wA], [wB]]);
      const { hydrator } = newHydrator(cursor, applier);

      // Both fire before either awaits; the single-flight chain serialises them.
      await Promise.all([hydrator.foldUntil(() => false), hydrator.foldUntil(() => false)]);

      expect(serialsOf(applier.folded)).toEqual(serialsOf([wA, wB]));
      expect(loadHistoryPages).toHaveBeenCalledTimes(1);
    });

    it('isolates a follower from a prior link failure', async () => {
      // A link records its own error rather than rejecting the chain, so a
      // follower queued behind a failed walk still runs its own. The shared
      // cursor fails its first page fetch then recovers on the next.
      let calls = 0;
      const cursor: HistoryPagesCursor = {
        hasNext: () => calls < 2,
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock rejects then resolves
        next: () => {
          calls += 1;
          return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve([wire()]);
        },
      };
      const applier = makeApplier();
      const { hydrator } = newHydrator(cursor, applier);

      const first = hydrator.foldUntil(() => false);
      const second = hydrator.foldUntil(() => false);

      // The first walk fails; the second is unaffected and folds the recovered page.
      await expect(first).rejects.toBeErrorInfoWithCode(ErrorCode.HistoryFetchFailed);
      await expect(second).resolves.toEqual({ exhausted: true });
      expect(applier.folded).toHaveLength(1);
      expect(loadHistoryPages).toHaveBeenCalledTimes(1); // one shared cursor
    });
  });

  describe('cancellation', () => {
    it('does not open the cursor when the signal is already aborted', async () => {
      const { hydrator } = newHydrator(makeCursor([[wire()]]), makeApplier());
      const controller = new AbortController();
      controller.abort();

      const { exhausted } = await hydrator.foldUntil(() => false, controller.signal);

      expect(exhausted).toBe(false);
      expect(loadHistoryPages).not.toHaveBeenCalled();
    });

    it('stops folding promptly when the signal aborts mid-drain', async () => {
      const wA = wire();
      const wB = wire();
      const controller = new AbortController();
      // Abort as soon as the first page is folded; the loop's between-page check
      // then halts before fetching the second page.
      const folded: Ably.InboundMessage[] = [];
      const applier: WireApplier = {
        apply: (msg) => {
          folded.push(msg);
          controller.abort();
          return;
        },
      };
      const cursor = makeCursor([[wA], [wB]]);
      const { hydrator } = newHydrator(cursor, applier);

      const { exhausted } = await hydrator.foldUntil(() => false, controller.signal);

      expect(serialsOf(folded)).toEqual(serialsOf([wA]));
      expect(cursor.nextCalls()).toBe(1); // second page never fetched
      expect(exhausted).toBe(false);
      expect(hydrator.hasNext()).toBe(true); // resumable, not exhausted
    });
  });

  describe('fetch errors', () => {
    it('wraps a page-fetch failure as HistoryFetchFailed', async () => {
      const cursor: HistoryPagesCursor = {
        hasNext: () => true,
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock rejects
        next: () => Promise.reject(new Error('boom')),
      };
      const { hydrator } = newHydrator(cursor, makeApplier());

      await expect(hydrator.foldUntil(() => false)).rejects.toBeErrorInfoWithCode(ErrorCode.HistoryFetchFailed);
    });
  });
});
