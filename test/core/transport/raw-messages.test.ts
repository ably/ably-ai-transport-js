/**
 * Unit tests for the raw-message helpers — the surface for sharing a session
 * channel with plain Ably Pub/Sub traffic:
 *
 *  - `isTransportMessage` / `isForeignMessage` classify channel messages by
 *    the reserved `ai-` name prefix and `extras.ai` envelope
 *  - `fetchRawHistory` pages history newest-first and returns filtered
 *    messages oldest-first, honouring `sinceSerial` / `untilSerial` /
 *    `maxPages` / `untilAttach`, and rejects rather than silently truncating
 *  - `runStartSerialOf` composes the View's run lookup with the Tree's
 *    run-node record into the merge's `serialOf`
 *  - `mergeBySerial` interleaves View conversation messages with raw
 *    messages into one serial-ordered transcript
 */

import type * as Ably from 'ably';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchRawHistory,
  isForeignMessage,
  isTransportMessage,
  mergeBySerial,
  runStartSerialOf,
} from '../../../src/core/transport/raw-messages.js';
import type { Tree, View } from '../../../src/core/transport/types.js';
import { ErrorCode } from '../../../src/errors.js';
import type { Logger } from '../../../src/logger.js';
import { buildPageChain, createHistoryChannel, type MockPage } from '../../helper/history-pages.js';

let serialCounter = 0;
const nextSerial = (): string => {
  serialCounter += 1;
  return `01H${String(serialCounter).padStart(10, '0')}`;
};

const rawMsg = (overrides: Partial<Ably.InboundMessage> = {}): Ably.InboundMessage =>
  ({
    name: 'handoff.message',
    action: 'message.create',
    serial: nextSerial(),
    data: {},
    ...overrides,
  }) as unknown as Ably.InboundMessage;

const transportMsg = (overrides: Partial<Ably.InboundMessage> = {}): Ably.InboundMessage =>
  rawMsg({ name: 'ai-output', extras: { ai: { transport: {} } }, ...overrides });

const recordingLogger = (): { logger: Logger; trace: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> } => {
  const trace = vi.fn();
  const debug = vi.fn();
  const logger: Logger = {
    trace,
    debug,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: () => logger,
  };
  return { logger, trace, debug };
};

describe('isTransportMessage / isForeignMessage', () => {
  it('classifies an `ai-` prefixed name as transport traffic', () => {
    const msg = rawMsg({ name: 'ai-output', extras: undefined });
    expect(isTransportMessage(msg)).toBe(true);
    expect(isForeignMessage(msg)).toBe(false);
  });

  it('classifies a message carrying `extras.ai` as transport traffic regardless of name', () => {
    const msg = rawMsg({ name: 'app.event', extras: { ai: { transport: {} } } });
    expect(isTransportMessage(msg)).toBe(true);
    expect(isForeignMessage(msg)).toBe(false);
  });

  it('classifies a plain message as foreign', () => {
    const msg = rawMsg({ name: 'handoff.message', extras: undefined });
    expect(isTransportMessage(msg)).toBe(false);
    expect(isForeignMessage(msg)).toBe(true);
  });

  it('treats `extras` without an `ai` key as foreign', () => {
    const msg = rawMsg({ name: 'app.event', extras: { headers: { foo: 'bar' } } });
    expect(isForeignMessage(msg)).toBe(true);
  });

  it('treats a null `extras.ai` as foreign', () => {
    // eslint-disable-next-line unicorn/no-null -- the malformed wire value under test
    const msg = rawMsg({ name: 'app.event', extras: { ai: null } });
    expect(isForeignMessage(msg)).toBe(true);
  });

  it('treats a nameless message without `extras.ai` as foreign', () => {
    const msg = rawMsg({ name: undefined, extras: undefined });
    expect(isForeignMessage(msg)).toBe(true);
  });
});

describe('fetchRawHistory', () => {
  beforeEach(() => {
    serialCounter = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns foreign messages oldest-first, dropping transport traffic by default', async () => {
    const r1 = rawMsg();
    const t1 = transportMsg();
    const r2 = rawMsg();
    // History pages are newest-first.
    const { channel } = createHistoryChannel([[r2, t1, r1]]);

    const result = await fetchRawHistory(channel);
    expect(result).toEqual([r1, r2]);
  });

  it('collects across pages', async () => {
    const r1 = rawMsg();
    const r2 = rawMsg();
    const r3 = rawMsg();
    const { channel } = createHistoryChannel([[r3], [r2], [r1]]);

    const result = await fetchRawHistory(channel);
    expect(result).toEqual([r1, r2, r3]);
  });

  it('applies a custom filter', async () => {
    const chat = rawMsg({ name: 'handoff.message' });
    const event = rawMsg({ name: 'handoff.event' });
    const { channel } = createHistoryChannel([[event, chat]]);

    const result = await fetchRawHistory(channel, { filter: (m) => m.name === 'handoff.message' });
    expect(result).toEqual([chat]);
  });

  it('stops at `sinceSerial` and excludes older messages (inclusive floor)', async () => {
    const older = rawMsg();
    const floor = rawMsg();
    const newer = rawMsg();
    const { channel } = createHistoryChannel([[newer, floor], [older]]);

    const floorSerial = floor.serial;
    expect(floorSerial).toBeDefined();
    const result = await fetchRawHistory(channel, { sinceSerial: floorSerial });
    expect(result).toEqual([floor, newer]);
  });

  it('stops paging once `sinceSerial` is crossed', async () => {
    const older = rawMsg();
    const newer = rawMsg();
    let secondPageFetched = false;
    // `hasNext()` is false, so the walk never calls `page2.next()`.
    const page2: MockPage = {
      items: [],
      hasNext: () => false,
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
      next: () => Promise.resolve(page2),
    };
    const page1: MockPage = {
      items: [newer, older],
      hasNext: () => true,
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
      next: () => {
        secondPageFetched = true;
        return Promise.resolve(page2);
      },
    };
    const channel = {
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
      attach: vi.fn(() => Promise.resolve()),
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
      history: vi.fn(() => Promise.resolve(page1)),
    };

    const newerSerial = newer.serial;
    expect(newerSerial).toBeDefined();
    const result = await fetchRawHistory(channel as unknown as Ably.RealtimeChannel, { sinceSerial: newerSerial });
    expect(result).toEqual([newer]);
    expect(secondPageFetched).toBe(false);
  });

  it('excludes messages newer than `untilSerial` (inclusive ceiling)', async () => {
    const older = rawMsg();
    const ceiling = rawMsg();
    const newer = rawMsg();
    const { channel } = createHistoryChannel([[newer, ceiling, older]]);

    const ceilingSerial = ceiling.serial;
    expect(ceilingSerial).toBeDefined();
    const result = await fetchRawHistory(channel, { untilSerial: ceilingSerial });
    expect(result).toEqual([older, ceiling]);
  });

  it('fetches a closed serial window when `sinceSerial` and `untilSerial` are combined', async () => {
    const before = rawMsg();
    const first = rawMsg();
    const second = rawMsg();
    const after = rawMsg();
    const { channel } = createHistoryChannel([
      [after, second],
      [first, before],
    ]);

    const result = await fetchRawHistory(channel, { sinceSerial: first.serial, untilSerial: second.serial });
    expect(result).toEqual([first, second]);
  });

  it('rejects `HistoryFetchFailed` when `maxPages` is reached with history remaining', async () => {
    const r1 = rawMsg();
    const r2 = rawMsg();
    const r3 = rawMsg();
    const { channel } = createHistoryChannel([[r3], [r2], [r1]]);

    await expect(fetchRawHistory(channel, { maxPages: 2 })).rejects.toBeErrorInfoWithCode(ErrorCode.HistoryFetchFailed);
  });

  it('does not reject when history is exhausted exactly at `maxPages`', async () => {
    const r1 = rawMsg();
    const r2 = rawMsg();
    const { channel } = createHistoryChannel([[r2], [r1]]);

    await expect(fetchRawHistory(channel, { maxPages: 2 })).resolves.toEqual([r1, r2]);
  });

  it('does not reject when `sinceSerial` is reached within `maxPages`', async () => {
    const older = rawMsg();
    const floor = rawMsg();
    const newer = rawMsg();
    const { channel } = createHistoryChannel([[newer], [floor, older], [rawMsg()]]);

    const result = await fetchRawHistory(channel, { sinceSerial: floor.serial, maxPages: 2 });
    expect(result).toEqual([floor, newer]);
  });

  it('attaches the channel and bounds the read `untilAttach` by default', async () => {
    const { channel, historyMock, attachMock } = createHistoryChannel([[rawMsg()]]);
    await fetchRawHistory(channel);
    expect(attachMock).toHaveBeenCalled();
    expect(historyMock).toHaveBeenCalledWith(expect.objectContaining({ untilAttach: true }));
  });

  it('passes `untilAttach: false` through when set', async () => {
    const { channel, historyMock } = createHistoryChannel([[rawMsg()]]);
    await fetchRawHistory(channel, { untilAttach: false });
    expect(historyMock).toHaveBeenCalledWith(expect.objectContaining({ untilAttach: false }));
  });

  it('returns an empty array when history is empty', async () => {
    const { channel } = createHistoryChannel([[]]);
    await expect(fetchRawHistory(channel)).resolves.toEqual([]);
  });

  it('traces at entry and reports the completed read through the provided logger', async () => {
    const { channel } = createHistoryChannel([[rawMsg(), rawMsg()]]);
    const { logger, trace, debug } = recordingLogger();

    await fetchRawHistory(channel, { logger });
    expect(trace).toHaveBeenCalledWith('fetchRawHistory();');
    expect(debug).toHaveBeenCalledWith('fetchRawHistory(); read complete', { pagesRead: 1, collected: 2 });
  });

  it('propagates the logger to the underlying page walk', async () => {
    vi.useFakeTimers();
    const { logger, debug } = recordingLogger();
    const channel = {
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
      attach: vi.fn(() => Promise.resolve()),
      history: vi
        .fn()
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValueOnce(buildPageChain([[rawMsg()]])),
    };

    const pending = fetchRawHistory(channel as unknown as Ably.RealtimeChannel, { logger });
    await vi.runAllTimersAsync();
    await pending;
    // The retry diagnostic is emitted by loadHistoryPages — proof the logger
    // reached the page walk.
    expect(debug).toHaveBeenCalledWith(
      'loadHistoryPages.fetchPageWithRetry(); page fetch failed, retrying',
      expect.objectContaining({ attempt: 1 }),
    );
  });

  it('rejects `HistoryFetchFailed` when the history read exhausts retries', async () => {
    vi.useFakeTimers();
    const channel = {
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
      attach: vi.fn(() => Promise.resolve()),
      history: vi.fn().mockRejectedValue(new Error('permanent')),
    };

    const pending = fetchRawHistory(channel as unknown as Ably.RealtimeChannel);
    const assertion = expect(pending).rejects.toBeErrorInfoWithCode(ErrorCode.HistoryFetchFailed);
    await vi.runAllTimersAsync();
    await assertion;
  });
});

const makeViewAndTree = (
  runByMessage: Map<string, string>,
  serialByRun: Map<string, string>,
): { view: View<string>; tree: Tree<never, unknown> } => {
  const view = {
    runOf: (codecMessageId: string) => {
      const runId = runByMessage.get(codecMessageId);
      return runId === undefined ? undefined : { runId };
    },
  };
  const tree = {
    getRunNode: (runId: string) =>
      serialByRun.has(runId) ? { runId, startSerial: serialByRun.get(runId) } : undefined,
  };
  // CAST: the mocks implement only the lookup surface the factory reads.
  return { view: view as unknown as View<string>, tree: tree as unknown as Tree<never, unknown> };
};

describe('runStartSerialOf', () => {
  it('resolves a codec-message-id to its owning run start serial', () => {
    const { view, tree } = makeViewAndTree(new Map([['c1', 'run1']]), new Map([['run1', 'serial-1']]));
    expect(runStartSerialOf(view, tree)('c1')).toBe('serial-1');
  });

  it('returns undefined for a codec-message-id with no owning run', () => {
    const { view, tree } = makeViewAndTree(new Map(), new Map());
    expect(runStartSerialOf(view, tree)('unknown')).toBeUndefined();
  });

  it('returns undefined when the owning run is not on the tree', () => {
    const { view, tree } = makeViewAndTree(new Map([['c1', 'run1']]), new Map());
    expect(runStartSerialOf(view, tree)('c1')).toBeUndefined();
  });
});

const conv = (codecMessageId: string, message: string): { codecMessageId: string; message: string } => ({
  codecMessageId,
  message,
});

/** A serialOf lookup that knows no serials. */
const noSerials = new Map<string, string>();

describe('mergeBySerial', () => {
  beforeEach(() => {
    serialCounter = 0;
  });

  it('interleaves raw messages between conversation messages by serial', () => {
    const s1 = nextSerial();
    const raw1 = rawMsg();
    const raw2 = rawMsg();
    const s2 = nextSerial();
    const serials = new Map([
      ['c1', s1],
      ['c2', s2],
    ]);

    const merged = mergeBySerial([conv('c1', 'first'), conv('c2', 'second')], (id) => serials.get(id), [raw1, raw2]);
    expect(merged).toEqual([
      { kind: 'conversation', codecMessageId: 'c1', message: 'first' },
      { kind: 'raw', message: raw1 },
      { kind: 'raw', message: raw2 },
      { kind: 'conversation', codecMessageId: 'c2', message: 'second' },
    ]);
  });

  it('emits raw messages older than the first conversation message first', () => {
    const raw1 = rawMsg();
    const s1 = nextSerial();

    const merged = mergeBySerial([conv('c1', 'first')], () => s1, [raw1]);
    expect(merged).toEqual([
      { kind: 'raw', message: raw1 },
      { kind: 'conversation', codecMessageId: 'c1', message: 'first' },
    ]);
  });

  it('flushes trailing raw messages after the last conversation message', () => {
    const s1 = nextSerial();
    const raw1 = rawMsg();

    const merged = mergeBySerial([conv('c1', 'first')], () => s1, [raw1]);
    expect(merged).toEqual([
      { kind: 'conversation', codecMessageId: 'c1', message: 'first' },
      { kind: 'raw', message: raw1 },
    ]);
  });

  it('keeps a conversation message with no serial in place without consuming raw messages', () => {
    const s1 = nextSerial();
    const raw1 = rawMsg();
    const serials = new Map([['c1', s1]]);

    // c2 is optimistic — its run has not started, so it has no serial yet.
    const merged = mergeBySerial([conv('c1', 'first'), conv('c2', 'pending')], (id) => serials.get(id), [raw1]);
    expect(merged).toEqual([
      { kind: 'conversation', codecMessageId: 'c1', message: 'first' },
      { kind: 'conversation', codecMessageId: 'c2', message: 'pending' },
      { kind: 'raw', message: raw1 },
    ]);
  });

  it('positions a raw message with a serial equal to a conversation serial after it', () => {
    const s1 = nextSerial();
    const raw1 = rawMsg({ serial: s1 });

    const merged = mergeBySerial([conv('c1', 'first')], () => s1, [raw1]);
    expect(merged).toEqual([
      { kind: 'conversation', codecMessageId: 'c1', message: 'first' },
      { kind: 'raw', message: raw1 },
    ]);
  });

  it('drops raw messages without a serial', () => {
    const raw1 = rawMsg({ serial: undefined });
    const merged = mergeBySerial([], (id) => noSerials.get(id), [raw1]);
    expect(merged).toEqual([]);
  });

  it('returns only raw messages when the conversation is empty', () => {
    const raw1 = rawMsg();
    const raw2 = rawMsg();
    const merged = mergeBySerial([], (id) => noSerials.get(id), [raw1, raw2]);
    expect(merged).toEqual([
      { kind: 'raw', message: raw1 },
      { kind: 'raw', message: raw2 },
    ]);
  });

  it('returns only conversation messages when there are no raw messages', () => {
    const merged = mergeBySerial([conv('c1', 'first')], () => nextSerial(), []);
    expect(merged).toEqual([{ kind: 'conversation', codecMessageId: 'c1', message: 'first' }]);
  });

  it('returns an empty array for empty inputs', () => {
    expect(mergeBySerial([], (id) => noSerials.get(id), [])).toEqual([]);
  });
});
