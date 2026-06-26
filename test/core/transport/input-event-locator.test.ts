/**
 * locateInputEvent unit tests.
 *
 * The watcher resolves the triggering input event from one of two sources: a
 * Tree event-id pre-scan, or a live `ably-message` listener (which also catches
 * folds the history-pagination driver walks in). It is passive — it never pages
 * history — and has no deadline, rejecting only when its signal aborts. These
 * tests drive each source with a fake Tree.
 */

import * as Ably from 'ably';
import { describe, expect, it, vi } from 'vitest';

import { HEADER_EVENT_ID, HEADER_RUN_ID } from '../../../src/constants.js';
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

// A fake Tree exposing the two capabilities the watcher reads, plus an `emit`
// hook so a test can simulate a live arrival / a paged fold.
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

const baseOpts = {
  invocationId: 'inv-1',
  runId: 'run-1',
  expectedEventId: 'p-1',
  logger: silentLogger,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('locateInputEvent', () => {
  it('resolves from the Tree pre-scan', async () => {
    const tree = makeTree();
    tree.seed('p-1', msg('p-1', { clientId: 'client-A', runId: 'R9' }));

    const result = await locateInputEvent({ ...baseOpts, tree, signal: new AbortController().signal });

    expect(result.clientId).toBe('client-A');
    expect(result.headers?.[HEADER_RUN_ID]).toBe('R9');
  });

  it('resolves from a live arrival after the listener is registered', async () => {
    const tree = makeTree();

    const p = locateInputEvent({ ...baseOpts, tree, signal: new AbortController().signal });
    // A matching message arrives live (or is walked in by a loadOlder page).
    tree.emit(msg('p-1', { clientId: 'client-B' }));

    await expect(p).resolves.toEqual({ headers: { [HEADER_EVENT_ID]: 'p-1' }, clientId: 'client-B' });
  });

  it('ignores non-matching arrivals and resolves only on the expected event-id', async () => {
    const tree = makeTree();

    const p = locateInputEvent({ ...baseOpts, tree, signal: new AbortController().signal });
    tree.emit(msg('p-other', { clientId: 'nope' }));
    tree.emit(msg('p-1', { clientId: 'client-C' }));

    await expect(p).resolves.toEqual({ headers: { [HEADER_EVENT_ID]: 'p-1' }, clientId: 'client-C' });
  });

  it('fires onMatched synchronously, before the promise resolves', async () => {
    const tree = makeTree();
    tree.seed('p-1', msg('p-1', { clientId: 'client-A' }));
    const onMatched = vi.fn();

    const p = locateInputEvent({ ...baseOpts, tree, onMatched, signal: new AbortController().signal });
    // The pre-scan match fires onMatched synchronously within the call, before
    // the returned promise has a chance to settle on a later microtask.
    expect(onMatched).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'client-A' }));

    await p;
  });

  it('fires onMatched inside the fold that surfaces a live match', async () => {
    const tree = makeTree();
    const onMatched = vi.fn();

    const p = locateInputEvent({ ...baseOpts, tree, onMatched, signal: new AbortController().signal });
    expect(onMatched).not.toHaveBeenCalled();
    // emit() invokes the listener synchronously, mirroring a Tree fold; onMatched
    // must run within that synchronous emit.
    tree.emit(msg('p-1', { clientId: 'client-D' }));
    expect(onMatched).toHaveBeenCalledTimes(1);

    await p;
  });

  it('rejects with InvalidArgument when the signal is already aborted', async () => {
    const tree = makeTree();
    const controller = new AbortController();
    controller.abort();

    await expect(locateInputEvent({ ...baseOpts, tree, signal: controller.signal })).rejects.toBeErrorInfoWithCode(
      ErrorCode.InvalidArgument,
    );
  });

  it('rejects with InvalidArgument when the signal aborts mid-wait', async () => {
    const tree = makeTree();
    const controller = new AbortController();

    const p = locateInputEvent({ ...baseOpts, tree, signal: controller.signal });
    controller.abort();

    await expect(p).rejects.toBeErrorInfoWithCode(ErrorCode.InvalidArgument);
  });
});
