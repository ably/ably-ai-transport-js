/**
 * locateInputEvent unit tests.
 *
 * The lookup races three sources for the triggering input event: a Tree
 * event-id pre-scan, a live `ably-message` listener, and the shared history
 * hydrator (whose folds surface through the same listener). It resolves with
 * whichever finds the expected event-id first, and is bounded only by
 * `timeoutMs` — on timeout it rejects with InputEventNotFound, carrying any
 * history-scan failure as `cause`. These tests drive each source with a fake
 * Tree and a fake hydrator.
 */

import * as Ably from 'ably';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HEADER_EVENT_ID, HEADER_RUN_ID } from '../../../src/constants.js';
import type { HistoryHydrator } from '../../../src/core/transport/history-hydrator.js';
import { type InputEventSource, locateInputEvent } from '../../../src/core/transport/input-event-locator.js';
import { ErrorCode } from '../../../src/errors.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';

const silentLogger = makeLogger({ logLevel: LogLevel.Silent });

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

// An inbound wire carrying the given event-id (and optional clientId + run-id).
const msg = (eventId: string, opts: { clientId?: string; runId?: string } = {}): Ably.InboundMessage =>
  ({
    clientId: opts.clientId,
    extras: {
      ai: {
        transport: {
          [HEADER_EVENT_ID]: eventId,
          ...(opts.runId !== undefined && { [HEADER_RUN_ID]: opts.runId }),
        },
      },
    },
  }) as unknown as Ably.InboundMessage;

// A fake Tree exposing the two capabilities the locator reads, plus an `emit`
// hook so a test can simulate a live arrival / a hydrator fold.
const makeTree = (): InputEventSource & {
  emit: (m: Ably.InboundMessage) => void;
  seed: (eventId: string, m: Ably.InboundMessage) => void;
} => {
  const listeners = new Set<(m: Ably.InboundMessage) => void>();
  const index = new Map<string, Ably.InboundMessage>();
  return {
    findAblyMessageByEventId: (eventId) => index.get(eventId),
    on: (_event, handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    emit: (m) => {
      for (const l of listeners) l(m);
    },
    seed: (eventId, m) => index.set(eventId, m),
  };
};

type FoldUntilImpl = (shouldStop: () => boolean, signal?: AbortSignal) => Promise<{ exhausted: boolean }>;

// A fake hydrator with a controllable foldUntil, returned alongside the spy so
// tests can assert on its calls without an unbound-method reference.
const makeHydrator = (impl: FoldUntilImpl): { hydrator: HistoryHydrator; foldUntil: ReturnType<typeof vi.fn> } => {
  const foldUntil = vi.fn(impl);
  return { hydrator: { foldUntil, hasNext: () => true }, foldUntil };
};

// foldUntil that never settles (the live / pre-scan path wins instead).
// eslint-disable-next-line @typescript-eslint/promise-function-async -- the body IS a Promise executor that never settles
const neverFolds: FoldUntilImpl = () =>
  new Promise<{ exhausted: boolean }>(() => {
    /* never settles */
  });

const baseOpts = {
  invocationId: 'inv-1',
  runId: 'run-1',
  expectedEventId: 'p-1',
  timeoutMs: 1000,
  logger: silentLogger,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('locateInputEvent', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves from the Tree pre-scan without driving the hydrator', async () => {
    const tree = makeTree();
    tree.seed('p-1', msg('p-1', { clientId: 'client-A', runId: 'R9' }));
    const { hydrator, foldUntil } = makeHydrator(neverFolds);

    const result = await locateInputEvent({ ...baseOpts, tree, hydrator, signal: new AbortController().signal });

    expect(result.clientId).toBe('client-A');
    expect(result.headers?.[HEADER_RUN_ID]).toBe('R9');
    expect(foldUntil).not.toHaveBeenCalled();
  });

  it('resolves from a live arrival while the history scan is still running', async () => {
    const tree = makeTree();
    const { hydrator } = makeHydrator(neverFolds);

    const p = locateInputEvent({ ...baseOpts, tree, hydrator, signal: new AbortController().signal });
    // A matching message arrives live after the listener is registered.
    tree.emit(msg('p-1', { clientId: 'client-B' }));

    await expect(p).resolves.toEqual({ headers: { [HEADER_EVENT_ID]: 'p-1' }, clientId: 'client-B' });
  });

  it('resolves from a message the hydrator folds during its scan', async () => {
    const tree = makeTree();
    // Folding surfaces the match through the same `ably-message` listener.
    const { hydrator, foldUntil } = makeHydrator(
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns a resolved promise
      () => {
        tree.emit(msg('p-1', { clientId: 'client-C' }));
        return Promise.resolve({ exhausted: false });
      },
    );

    const result = await locateInputEvent({ ...baseOpts, tree, hydrator, signal: new AbortController().signal });

    expect(result.clientId).toBe('client-C');
    expect(foldUntil).toHaveBeenCalledTimes(1);
  });

  it('rejects with InputEventNotFound on timeout, carrying the history failure as cause', async () => {
    vi.useFakeTimers();
    const tree = makeTree();
    const historyErr = new Ably.ErrorInfo('history offline', ErrorCode.HistoryFetchFailed, 500);
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns a rejected promise
    const { hydrator } = makeHydrator(() => Promise.reject(historyErr));

    const p = locateInputEvent({ ...baseOpts, tree, hydrator, signal: new AbortController().signal });
    // Attach the rejection handler before firing the timer so the rejection is
    // never momentarily unhandled.
    const expectation = expect(p).rejects.toBeErrorInfo({
      code: ErrorCode.InputEventNotFound,
      cause: { code: ErrorCode.HistoryFetchFailed },
    });
    // Flush the rejected foldUntil (records the cause), then fire the timeout.
    await vi.advanceTimersByTimeAsync(1000);
    await expectation;
  });

  it('rejects with InvalidArgument when the signal is already aborted', async () => {
    const tree = makeTree();
    const { hydrator, foldUntil } = makeHydrator(neverFolds);
    const controller = new AbortController();
    controller.abort();

    await expect(
      locateInputEvent({ ...baseOpts, tree, hydrator, signal: controller.signal }),
    ).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
    expect(foldUntil).not.toHaveBeenCalled();
  });

  it('rejects with InvalidArgument when the signal aborts mid-wait', async () => {
    const tree = makeTree();
    const { hydrator } = makeHydrator(neverFolds);
    const controller = new AbortController();

    const p = locateInputEvent({ ...baseOpts, tree, hydrator, signal: controller.signal });
    controller.abort();

    await expect(p).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
  });
});
