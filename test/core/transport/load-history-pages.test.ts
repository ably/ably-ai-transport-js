/**
 * Unit tests for the shared `loadHistoryPages` primitive.
 *
 * `loadHistoryPages` is the cursor-based pagination engine consumed by
 * `load-history.ts` (client side, wrapped with the completion counter)
 * and by the agent's `AgentView` (input-event lookup / conversation walk).
 * These tests verify the contract independently of either consumer:
 *
 *  - cursor `hasNext()` reflects the underlying paginated result
 *  - `next()` returns wires newest-first within each page
 *  - per-page failures are retried with bounded backoff
 *  - signal aborts surface as `OperationCancelled`
 */

import type * as Ably from 'ably';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loadHistoryPages } from '../../../src/core/transport/load-history-pages.js';
import { ErrorCode } from '../../../src/errors.js';

let serialCounter = 0;
const nextSerial = (): string => {
  serialCounter += 1;
  return `01H${String(serialCounter).padStart(10, '0')}`;
};

const ablyMsg = (): Ably.InboundMessage =>
  ({
    name: 'msg',
    action: 'message.create',
    serial: nextSerial(),
    extras: { ai: { transport: {} } },
  }) as unknown as Ably.InboundMessage;

interface MockPage {
  items: Ably.InboundMessage[];
  hasNext: () => boolean;
  next: () => Promise<MockPage | undefined>;
}

const buildPageChain = (pages: Ably.InboundMessage[][]): MockPage => {
  const build = (i: number): MockPage => ({
    items: pages[i] ?? [],
    hasNext: () => i < pages.length - 1,
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    next: () => Promise.resolve(i < pages.length - 1 ? build(i + 1) : undefined),
  });
  return build(0);
};

const createMockChannel = (
  pages: Ably.InboundMessage[][] = [],
): { channel: Ably.RealtimeChannel; historyMock: ReturnType<typeof vi.fn> } => {
  const historyMock = vi.fn(
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    () => Promise.resolve(buildPageChain(pages)),
  );
  const channel = {
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    attach: vi.fn(() => Promise.resolve()),
    history: historyMock,
  };
  return { channel: channel as unknown as Ably.RealtimeChannel, historyMock };
};

describe('loadHistoryPages', () => {
  beforeEach(() => {
    serialCounter = 0;
  });

  it('returns a cursor that yields each page in turn', async () => {
    const m4 = ablyMsg();
    const m3 = ablyMsg();
    const m2 = ablyMsg();
    const m1 = ablyMsg();
    const { channel } = createMockChannel([
      [m4, m3],
      [m2, m1],
    ]);

    const cursor = await loadHistoryPages(channel, { pageLimit: 2 });
    expect(cursor.hasNext()).toBe(true);

    const first = await cursor.next();
    expect(first).toEqual([m4, m3]);
    expect(cursor.hasNext()).toBe(true);

    const second = await cursor.next();
    expect(second).toEqual([m2, m1]);
    expect(cursor.hasNext()).toBe(false);

    const third = await cursor.next();
    expect(third).toBeUndefined();
  });

  it('passes `untilAttach: true` by default', async () => {
    const { channel, historyMock } = createMockChannel([[ablyMsg()]]);
    await loadHistoryPages(channel, { pageLimit: 10 });
    expect(historyMock).toHaveBeenCalledWith({ limit: 10, untilAttach: true });
  });

  it('retries the initial history call with backoff before rejecting `HistoryFetchFailed`', async () => {
    const channel = {
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
      attach: vi.fn(() => Promise.resolve()),
      history: vi
        .fn()
        .mockRejectedValueOnce(new Error('transient'))
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValueOnce(buildPageChain([[ablyMsg()]])),
    };

    const cursor = await loadHistoryPages(channel as unknown as Ably.RealtimeChannel, {
      pageLimit: 1,
      maxRetries: 3,
      retryBackoffMs: 1,
    });
    expect(channel.history).toHaveBeenCalledTimes(3);
    const first = await cursor.next();
    expect(first?.length).toBe(1);
  });

  it('unrefs the retry backoff timer so a parked retry cannot hold a Node process open', async () => {
    const unrefSpy = vi.fn();
    const realSetTimeout = globalThis.setTimeout.bind(globalThis);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, ms?: number) => {
      const timer = realSetTimeout(handler, ms);
      const realUnref = timer.unref.bind(timer);
      timer.unref = () => {
        unrefSpy();
        return realUnref();
      };
      return timer;
    }) as typeof setTimeout);

    try {
      const channel = {
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
        attach: vi.fn(() => Promise.resolve()),
        history: vi
          .fn()
          .mockRejectedValueOnce(new Error('transient'))
          .mockResolvedValueOnce(buildPageChain([[ablyMsg()]])),
      };

      await loadHistoryPages(channel as unknown as Ably.RealtimeChannel, {
        pageLimit: 1,
        maxRetries: 1,
        retryBackoffMs: 1,
      });
      // The single backoff sleep between the failed and successful attempts
      // must have unref'd its timer.
      expect(unrefSpy).toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('retries a mid-walk page.next() failure with backoff before succeeding', async () => {
    const m1 = ablyMsg();
    const m2 = ablyMsg();
    let nextCalls = 0;
    // `hasNext()` is false, so the cursor never calls `page2.next()`.
    const page2: MockPage = {
      items: [m2],
      hasNext: () => false,
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
      next: () => Promise.resolve(page2),
    };
    const page1: MockPage = {
      items: [m1],
      hasNext: () => true,
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
      next: () => {
        nextCalls += 1;
        return nextCalls === 1 ? Promise.reject(new Error('transient')) : Promise.resolve(page2);
      },
    };
    const channel = {
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
      attach: vi.fn(() => Promise.resolve()),
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
      history: vi.fn(() => Promise.resolve(page1)),
    };

    const cursor = await loadHistoryPages(channel as unknown as Ably.RealtimeChannel, {
      pageLimit: 1,
      maxRetries: 2,
      retryBackoffMs: 1,
    });
    expect(await cursor.next()).toEqual([m1]);
    // The failing page.next() is retried transparently — the second cursor
    // call still yields the second page's messages.
    expect(await cursor.next()).toEqual([m2]);
    expect(nextCalls).toBe(2);
  });

  it('rejects `HistoryFetchFailed` when a mid-walk page.next() exhausts retries', async () => {
    const m1 = ablyMsg();
    const page1: MockPage = {
      items: [m1],
      hasNext: () => true,
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
      next: () => Promise.reject(new Error('permanent')),
    };
    const channel = {
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
      attach: vi.fn(() => Promise.resolve()),
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
      history: vi.fn(() => Promise.resolve(page1)),
    };

    const cursor = await loadHistoryPages(channel as unknown as Ably.RealtimeChannel, {
      pageLimit: 1,
      maxRetries: 1,
      retryBackoffMs: 1,
    });
    expect(await cursor.next()).toEqual([m1]);
    await expect(cursor.next()).rejects.toBeErrorInfoWithCode(ErrorCode.HistoryFetchFailed);
  });

  it('hasNext() returns false once the signal aborts', async () => {
    const ctrl = new AbortController();
    const { channel } = createMockChannel([[ablyMsg()], [ablyMsg()]]);

    const cursor = await loadHistoryPages(channel, { pageLimit: 1, signal: ctrl.signal });
    expect(cursor.hasNext()).toBe(true);
    ctrl.abort();
    expect(cursor.hasNext()).toBe(false);
  });

  it('rejects `HistoryFetchFailed` after retries are exhausted', async () => {
    const channel = {
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
      attach: vi.fn(() => Promise.resolve()),
      history: vi.fn().mockRejectedValue(new Error('permanent')),
    };

    await expect(
      loadHistoryPages(channel as unknown as Ably.RealtimeChannel, {
        pageLimit: 1,
        maxRetries: 1,
        retryBackoffMs: 1,
      }),
    ).rejects.toBeErrorInfoWithCode(ErrorCode.HistoryFetchFailed);
  });

  it('throws `OperationCancelled` when the signal aborts during retry backoff', async () => {
    const ctrl = new AbortController();
    const channel = {
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
      attach: vi.fn(() => Promise.resolve()),
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
      history: vi.fn(() => {
        // Abort as the fetch fails, so the retry loop's backoff wait sees an
        // already-aborted signal — deterministic, no timer races.
        ctrl.abort();
        return Promise.reject(new Error('transient'));
      }),
    };

    await expect(
      loadHistoryPages(channel as unknown as Ably.RealtimeChannel, {
        pageLimit: 1,
        maxRetries: 2,
        retryBackoffMs: 1,
        signal: ctrl.signal,
      }),
    ).rejects.toBeErrorInfoWithCode(ErrorCode.OperationCancelled);
    expect(channel.history).toHaveBeenCalledTimes(1);
  });

  it('throws `OperationCancelled` when the signal is aborted on entry', async () => {
    const { channel } = createMockChannel([[ablyMsg()]]);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(loadHistoryPages(channel, { pageLimit: 1, signal: ctrl.signal })).rejects.toBeErrorInfoWithCode(
      ErrorCode.OperationCancelled,
    );
  });

  it('aborts between pages when the signal fires mid-walk', async () => {
    const ctrl = new AbortController();
    const m1 = ablyMsg();
    const m2 = ablyMsg();
    const { channel } = createMockChannel([[m1], [m2]]);

    const cursor = await loadHistoryPages(channel, { pageLimit: 1, signal: ctrl.signal });
    const first = await cursor.next();
    expect(first).toEqual([m1]);
    ctrl.abort();
    await expect(cursor.next()).rejects.toBeErrorInfoWithCode(ErrorCode.OperationCancelled);
  });
});
