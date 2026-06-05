/**
 * loadHistory unit tests.
 *
 * loadHistory does not decode: it pages back through Ably history using a
 * cheap, header-based completion counter and returns the raw wire messages
 * (oldest-first) for the caller to fold. These tests cover the completion
 * counter (what marks a codec-message-id complete, including across page
 * boundaries) and the raw-message pagination contract (chronological order,
 * hasNext/next, buffered pages).
 */

import type * as Ably from 'ably';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HEADER_CODEC_MESSAGE_ID,
  HEADER_DISCRETE,
  HEADER_RUN_ID,
  HEADER_STATUS,
  HEADER_STREAM,
} from '../../../src/constants.js';
import { loadHistory } from '../../../src/core/transport/load-history.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';

const silentLogger = makeLogger({ logLevel: LogLevel.Silent });

// ---------------------------------------------------------------------------
// Ably message builders
// ---------------------------------------------------------------------------

let serialCounter = 0;

const nextSerial = (): string => {
  serialCounter += 1;
  return `01H${String(serialCounter).padStart(10, '0')}`;
};

interface MsgOpts {
  headers?: Record<string, string>;
  action?: string;
  serial?: string;
}

const ablyMsg = (opts: MsgOpts = {}): Ably.InboundMessage =>
  ({
    name: 'msg',
    action: opts.action ?? 'message.create',
    extras: { ai: { transport: opts.headers ?? {} } },
    serial: opts.serial ?? nextSerial(),
  }) as unknown as Ably.InboundMessage;

// A discrete message: created and terminated by a single wire (start + terminal).
const discreteMsg = (codecMessageId: string, extraHeaders: Record<string, string> = {}): Ably.InboundMessage =>
  ablyMsg({
    headers: {
      [HEADER_CODEC_MESSAGE_ID]: codecMessageId,
      [HEADER_STREAM]: 'false',
      [HEADER_DISCRETE]: 'true',
      ...extraHeaders,
    },
  });

// A streamed run: a create followed by `deltaCount` appends and a closing
// append carrying `status: complete`. All wires share one serial. Returned
// newest-first, as Ably history delivers them.
const streamingRun = (runId: string, codecMessageId: string, deltaCount: number): Ably.InboundMessage[] => {
  const serial = nextSerial();
  const baseHeaders = {
    [HEADER_RUN_ID]: runId,
    [HEADER_CODEC_MESSAGE_ID]: codecMessageId,
    [HEADER_STREAM]: 'true',
  };

  const create = ablyMsg({ action: 'message.create', headers: baseHeaders, serial });
  const deltas = Array.from({ length: deltaCount }, () =>
    ablyMsg({ action: 'message.append', headers: baseHeaders, serial }),
  );
  const finish = ablyMsg({
    action: 'message.append',
    headers: { ...baseHeaders, [HEADER_STATUS]: 'complete' },
    serial,
  });

  // Newest-first: finish, deltas reversed, create.
  return [finish, ...deltas.toReversed(), create];
};

// ---------------------------------------------------------------------------
// Mock history pages
// ---------------------------------------------------------------------------

interface MockHistoryPage {
  items: Ably.InboundMessage[];
  hasNext: () => boolean;
  next: () => Promise<MockHistoryPage | undefined>;
}

const buildHistoryChain = (pages: Ably.InboundMessage[][]): MockHistoryPage => {
  const build = (i: number): MockHistoryPage => ({
    items: pages[i] ?? [],
    hasNext: () => i < pages.length - 1,
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    next: () => Promise.resolve(i < pages.length - 1 ? build(i + 1) : undefined),
  });
  return build(0);
};

const createMockChannel = (pages: Ably.InboundMessage[][] = []): Ably.RealtimeChannel => {
  const channel = {
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    attach: vi.fn(() => Promise.resolve()),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    history: vi.fn(() => Promise.resolve(buildHistoryChain(pages))),
  };
  return channel as unknown as Ably.RealtimeChannel;
};

const serialsOf = (msgs: readonly Ably.InboundMessage[]): (string | undefined)[] => msgs.map((m) => m.serial);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadHistory', () => {
  beforeEach(() => {
    serialCounter = 0;
  });

  // -------------------------------------------------------------------------
  // Raw-message pagination
  // -------------------------------------------------------------------------

  describe('pagination', () => {
    it('returns all collected wires chronologically when a single page satisfies the limit', async () => {
      const m3 = discreteMsg('u3');
      const m2 = discreteMsg('u2');
      const m1 = discreteMsg('u1');
      // Ably delivers newest-first.
      const channel = createMockChannel([[m3, m2, m1]]);

      const page = await loadHistory(channel, { limit: 3 }, silentLogger);

      // rawMessages are reversed to chronological (oldest first).
      expect(serialsOf(page.rawMessages)).toEqual(serialsOf([m1, m2, m3]));
      expect(page.hasNext()).toBe(false);
    });

    it('returns every wire when history has fewer completed messages than the limit', async () => {
      const m2 = discreteMsg('u2');
      const m1 = discreteMsg('u1');
      const channel = createMockChannel([[m2, m1]]);

      const page = await loadHistory(channel, { limit: 10 }, silentLogger);

      expect(serialsOf(page.rawMessages)).toEqual(serialsOf([m1, m2]));
      expect(page.hasNext()).toBe(false);
    });

    it('fetches additional pages until the completion limit is satisfied', async () => {
      const pageNewest = [discreteMsg('u3')];
      const pageOlder = [discreteMsg('u2'), discreteMsg('u1')];
      const channel = createMockChannel([pageNewest, pageOlder]);

      const page = await loadHistory(channel, { limit: 3 }, silentLogger);

      // Both pages were fetched; all three wires appear chronologically.
      expect(page.rawMessages).toHaveLength(3);
      expect(page.hasNext()).toBe(false);
    });

    it('stops fetching once enough completions are collected, leaving older pages for next()', async () => {
      const m2 = discreteMsg('u2');
      const m1 = discreteMsg('u1');
      const channel = createMockChannel([[m2], [m1]]);

      // limit 1 is satisfied by the newest page alone — the older page is not fetched yet.
      const first = await loadHistory(channel, { limit: 1 }, silentLogger);
      expect(serialsOf(first.rawMessages)).toEqual(serialsOf([m2]));
      expect(first.hasNext()).toBe(true);

      // next() fetches the older page and serves its wire.
      const second = await first.next();
      expect(second).toBeDefined();
      expect(serialsOf(second?.rawMessages ?? [])).toEqual(serialsOf([m1]));
      expect(second?.hasNext()).toBe(false);
    });

    it('serves buffered completions on next() without new wires when one fetch over-collects', async () => {
      const m4 = discreteMsg('u4');
      const m3 = discreteMsg('u3');
      const m2 = discreteMsg('u2');
      const m1 = discreteMsg('u1');
      const channel = createMockChannel([[m4, m3, m2, m1]]);

      // A single Ably page already holds 4 completions; limit 2 buffers the rest.
      const first = await loadHistory(channel, { limit: 2 }, silentLogger);
      // All fetched wires are handed over on the first page.
      expect(serialsOf(first.rawMessages)).toEqual(serialsOf([m1, m2, m3, m4]));
      expect(first.hasNext()).toBe(true);

      // The buffered page carries no new wires but drains the remaining completions.
      const second = await first.next();
      expect(second?.rawMessages).toEqual([]);
      expect(second?.hasNext()).toBe(false);
    });

    it('returns an empty page when history has no messages', async () => {
      const channel = createMockChannel([[]]);
      const page = await loadHistory(channel, { limit: 10 }, silentLogger);
      expect(page.rawMessages).toEqual([]);
      expect(page.hasNext()).toBe(false);
    });

    it('uses the default limit when options is omitted', async () => {
      const channel = createMockChannel([[discreteMsg('u3'), discreteMsg('u2'), discreteMsg('u1')]]);
      const page = await loadHistory(channel, undefined, silentLogger);
      expect(page.rawMessages).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // Completion counting (header scan, no decode)
  // -------------------------------------------------------------------------

  describe('completion counting', () => {
    it('counts a streamed run (create + appends + finish) as one completion', async () => {
      const wires = streamingRun('T1', 'asst-1', 2);
      const channel = createMockChannel([wires]);

      // limit 1 is satisfied by the single completed run; all its wires come back.
      const page = await loadHistory(channel, { limit: 1 }, silentLogger);
      expect(page.rawMessages).toHaveLength(wires.length);
      expect(page.hasNext()).toBe(false);
    });

    it('requires both a start and a terminal signal across a page boundary', async () => {
      // The counter treats first-contact appends as starts, so a genuine
      // start-only/terminal-only split is forced with two discrete messages in
      // separate pages and limit 2 — both pages must be fetched to satisfy it.
      const m2 = discreteMsg('u2');
      const m1 = discreteMsg('u1');
      const channel = createMockChannel([[m2], [m1]]);

      const page = await loadHistory(channel, { limit: 2 }, silentLogger);

      expect(serialsOf(page.rawMessages)).toEqual(serialsOf([m1, m2]));
      expect(page.hasNext()).toBe(false);
    });

    it('treats status:cancelled as terminal for counting', async () => {
      // append + stream=true + status=cancelled is a start AND a terminal.
      const cancelled = ablyMsg({
        action: 'message.append',
        headers: {
          [HEADER_RUN_ID]: 'T1',
          [HEADER_CODEC_MESSAGE_ID]: 'asst-cancel',
          [HEADER_STREAM]: 'true',
          [HEADER_STATUS]: 'cancelled',
        },
      });
      const channel = createMockChannel([[cancelled]]);

      const page = await loadHistory(channel, { limit: 1 }, silentLogger);
      // Counted complete and returned without needing to page further.
      expect(serialsOf(page.rawMessages)).toEqual(serialsOf([cancelled]));
      expect(page.hasNext()).toBe(false);
    });

    it('does not count wires without a codec-message-id (lifecycle events)', async () => {
      // Two lifecycle-only wires (no codec-message-id) + one real completion.
      const lifecycle1 = ablyMsg({ headers: { [HEADER_RUN_ID]: 'T1' } });
      const lifecycle2 = ablyMsg({ headers: { [HEADER_RUN_ID]: 'T1' } });
      const real = discreteMsg('u1');
      const channel = createMockChannel([[lifecycle1, lifecycle2, real]]);

      // limit 1 is met by the single real completion; lifecycle wires never count.
      const page = await loadHistory(channel, { limit: 1 }, silentLogger);
      expect(page.rawMessages).toHaveLength(3);
      expect(page.hasNext()).toBe(false);
    });
  });
});
