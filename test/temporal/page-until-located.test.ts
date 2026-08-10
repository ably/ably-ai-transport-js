/**
 * Tests for the bounded history paging used when a durable activity opens a run
 * in a fresh process and its trigger event sits in channel history.
 */

import '../helper/expectations.js';

import * as Ably from 'ably';
import { describe, expect, it, vi } from 'vitest';

import { ErrorCode } from '../../src/errors.js';
import type { LocatableRun } from '../../src/temporal/page-until-located.js';
import { pageUntilLocated } from '../../src/temporal/page-until-located.js';
import { flushMicrotasks } from '../helper/streams.js';

/**
 * A run whose trigger folds in after `locateAfterPages` pages.
 * @param options - Fixture shape.
 * @param options.historyPages - How many pages of history are available.
 * @param options.locateAfterPages - Page count at which the trigger folds in; omit for never.
 * @returns The fake run, plus a count of the pages it served.
 */
const createRun = (options: {
  historyPages: number;
  locateAfterPages?: number;
}): LocatableRun & { pagesLoaded: number } => {
  const state = { pagesLoaded: 0 };
  let resolveLocated: (() => void) | undefined;
  const located = new Promise<void>((resolve) => {
    resolveLocated = resolve;
  });

  if (options.locateAfterPages === 0) resolveLocated?.();

  const run = {
    located,
    view: {
      hasOlder: (): boolean => state.pagesLoaded < options.historyPages,
      loadOlder: async (): Promise<unknown> => {
        state.pagesLoaded++;
        await Promise.resolve();
        if (options.locateAfterPages !== undefined && state.pagesLoaded >= options.locateAfterPages) {
          resolveLocated?.();
        }
        return undefined;
      },
    },
    get pagesLoaded(): number {
      return state.pagesLoaded;
    },
  };
  return run;
};

describe('pageUntilLocated', () => {
  it('does not page when the trigger is already located', async () => {
    const run = createRun({ historyPages: 5, locateAfterPages: 0 });

    await pageUntilLocated(run, { inputEventId: 'evt-1' });

    expect(run.pagesLoaded).toBe(0);
  });

  it('stops the moment the trigger surfaces rather than draining history', async () => {
    const run = createRun({ historyPages: 20, locateAfterPages: 1 });

    await pageUntilLocated(run, { inputEventId: 'evt-1' });

    expect(run.pagesLoaded).toBe(1);
  });

  it('keeps paging until the trigger surfaces on a later page', async () => {
    const run = createRun({ historyPages: 20, locateAfterPages: 3 });

    await pageUntilLocated(run, { inputEventId: 'evt-1' });

    expect(run.pagesLoaded).toBe(3);
  });

  it('throws once the page ceiling is reached without locating the trigger', async () => {
    const run = createRun({ historyPages: 100 });

    await expect(
      pageUntilLocated(run, { inputEventId: 'evt-missing', maxPages: 4, triggerWaitMs: 1 }),
    ).rejects.toBeErrorInfoWithCode(ErrorCode.InputEventNotFound);

    expect(run.pagesLoaded).toBe(4);
  });

  it('names the missing input event in the error', async () => {
    const run = createRun({ historyPages: 1 });

    await expect(
      pageUntilLocated(run, { inputEventId: 'evt-missing', maxPages: 1, triggerWaitMs: 1 }),
    ).rejects.toBeErrorInfo({
      code: ErrorCode.InputEventNotFound,
      statusCode: 504,
      message: 'unable to open run; trigger event evt-missing not located within 1 history pages',
    });
  });

  it('waits for a live trigger once history is exhausted', async () => {
    const run = createRun({ historyPages: 0 });
    let resolveLive: (() => void) | undefined;
    const live = new Promise<void>((resolve) => {
      resolveLive = resolve;
    });
    const runWithLiveTrigger: LocatableRun = { located: live, view: run.view };

    const call = pageUntilLocated(runWithLiveTrigger, { inputEventId: 'evt-1', triggerWaitMs: 10_000 });
    await flushMicrotasks();
    resolveLive?.();

    await expect(call).resolves.toBeUndefined();
    expect(run.pagesLoaded).toBe(0);
  });

  it('reports each page so a caller can heartbeat', async () => {
    const run = createRun({ historyPages: 20, locateAfterPages: 3 });
    const onPage = vi.fn();

    await pageUntilLocated(run, { inputEventId: 'evt-1', onPage });

    expect(onPage).toHaveBeenCalledTimes(3);
  });

  it('propagates a located rejection', async () => {
    const failure = new Ably.ErrorInfo('unable to locate input event; session closed', ErrorCode.SessionClosed, 400);
    const run: LocatableRun = {
      located: Promise.reject(failure),
      view: {
        hasOlder: () => false,
        loadOlder: async () => {
          await Promise.resolve();
          return;
        },
      },
    };

    await expect(pageUntilLocated(run, { inputEventId: 'evt-1' })).rejects.toBe(failure);
  });
});
