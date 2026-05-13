import type * as Ably from 'ably';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HEADER_AMEND,
  HEADER_DISCRETE,
  HEADER_INVOCATION_ID,
  HEADER_MSG_ID,
  HEADER_ROLE,
  HEADER_RUN_ID,
  HEADER_STATUS,
  HEADER_STREAM,
} from '../../../src/constants.js';
import type { Codec, DecoderOutput, MessageAccumulator, StreamDecoder } from '../../../src/core/codec/types.js';
import { decodeHistory } from '../../../src/core/transport/decode-history.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';

// ---------------------------------------------------------------------------
// Test types
// ---------------------------------------------------------------------------

interface TestEvent {
  type: 'text' | 'finish';
  text?: string;
}

interface TestMessage {
  id: string;
  content: string;
}

type TestDecoderOutput = DecoderOutput<TestEvent, TestMessage>;

const silentLogger = makeLogger({ logLevel: LogLevel.Silent });

// ---------------------------------------------------------------------------
// Shared outputs lookup — a fresh decoder is created per decodeAll call, so
// the decoder -> outputs mapping needs to live outside the decoder instance.
// Keyed by message identity (not serial) because a streaming run's wire
// messages all share the same Ably serial.
// ---------------------------------------------------------------------------

const outputsByMessage = new WeakMap<Ably.InboundMessage, TestDecoderOutput[]>();

// ---------------------------------------------------------------------------
// Ably message builders
// ---------------------------------------------------------------------------

let serialCounter = 0;

const nextSerial = (): string => {
  serialCounter += 1;
  // Lexicographically comparable, like real Ably serials.
  return `01H${String(serialCounter).padStart(10, '0')}`;
};

interface MsgOpts {
  name?: string;
  headers?: Record<string, string>;
  data?: unknown;
  action?: string;
  serial?: string;
}

const ablyMsg = (opts: MsgOpts = {}): Ably.InboundMessage =>
  ({
    name: opts.name ?? 'msg',
    data: opts.data,
    action: opts.action ?? 'message.create',
    extras: { headers: opts.headers ?? {} },
    serial: opts.serial ?? nextSerial(),
  }) as unknown as Ably.InboundMessage;

/**
 * Register outputs the mock decoder should emit for the given Ably message.
 * @param msg - The Ably message to attach outputs to.
 * @param outputs - Decoder outputs to emit when this message is decoded.
 * @returns The same Ably message (for chaining).
 */
const withOutputs = (msg: Ably.InboundMessage, outputs: TestDecoderOutput[]): Ably.InboundMessage => {
  outputsByMessage.set(msg, outputs);
  return msg;
};

/**
 * Build a discrete (non-run) message and the corresponding decoder output.
 * Matches the real encoder's wire format for `publishDiscreteBatch`:
 * `x-ably-stream: "false"` plus `x-ably-discrete: "true"`.
 * @param msgId - The `x-ably-msg-id` header value.
 * @param content - The domain message content.
 * @param extraHeaders - Additional headers to set on the Ably message.
 * @returns The built Ably message, with outputs registered.
 */
const discreteMsg = (msgId: string, content: string, extraHeaders: Record<string, string> = {}): Ably.InboundMessage =>
  withOutputs(
    ablyMsg({
      headers: {
        [HEADER_MSG_ID]: msgId,
        [HEADER_STREAM]: 'false',
        [HEADER_DISCRETE]: 'true',
        ...extraHeaders,
      },
    }),
    [{ kind: 'message', message: { id: msgId, content } }],
  );

/**
 * Build the four wire messages for a single streaming run. All four share
 * the same Ably serial (per real Ably append semantics) and the same
 * `x-ably-msg-id` header. Returned in newest-first order to match Ably
 * history's convention (finish first, then deltas, then create).
 * @param runId - The `x-ably-run-id` header value.
 * @param msgId - The `x-ably-msg-id` header value.
 * @param deltas - Text deltas in chronological (send) order.
 * @returns `[finish, ...deltas.reverse(), create]` — newest-first.
 */
const streamingRun = (runId: string, msgId: string, deltas: string[]): Ably.InboundMessage[] => {
  const serial = nextSerial();
  const baseHeaders = {
    [HEADER_RUN_ID]: runId,
    [HEADER_MSG_ID]: msgId,
    [HEADER_STREAM]: 'true',
  };

  const create = withOutputs(ablyMsg({ action: 'message.create', headers: baseHeaders, serial }), [
    { kind: 'event', event: { type: 'text', text: '' }, messageId: msgId },
  ]);
  const deltaMessages = deltas.map((text) =>
    withOutputs(ablyMsg({ action: 'message.append', headers: baseHeaders, serial }), [
      { kind: 'event', event: { type: 'text', text }, messageId: msgId },
    ]),
  );
  const finish = withOutputs(
    ablyMsg({
      action: 'message.append',
      headers: { ...baseHeaders, [HEADER_STATUS]: 'finished' },
      serial,
    }),
    [{ kind: 'event', event: { type: 'finish' }, messageId: msgId }],
  );

  // Newest-first: finish, then deltas reversed, then create.
  return [finish, ...deltaMessages.toReversed(), create];
};

/**
 * Build a cross-run amendment targeting an existing message.
 * @param targetMsgId - The `x-ably-msg-id` of the existing message to amend.
 * @param runId - The `x-ably-run-id` of the amending run.
 * @returns The built Ably message, with outputs registered.
 */
const amendMsg = (targetMsgId: string, runId: string): Ably.InboundMessage =>
  withOutputs(
    ablyMsg({
      headers: {
        [HEADER_MSG_ID]: targetMsgId,
        [HEADER_AMEND]: targetMsgId,
        [HEADER_RUN_ID]: runId,
      },
    }),
    [{ kind: 'event', event: { type: 'text', text: '[amended]' }, messageId: targetMsgId }],
  );

// ---------------------------------------------------------------------------
// Mock Ably history pages (newest-first, as Ably returns them)
// ---------------------------------------------------------------------------

interface MockHistoryPage {
  items: Ably.InboundMessage[];
  hasNext: () => boolean;
  next: () => Promise<MockHistoryPage | undefined>;
}

/**
 * Build a chain of Ably history pages. Pass pages newest-first — `pages[0]`
 * is the first page returned by `channel.history()`, `pages[1]` is fetched
 * via `.next()`, and so on. Each page's `items` are also newest-first.
 * @param pages - Pages in newest-first order. Each page's items are also newest-first.
 * @returns The head of the page chain.
 */
const buildHistoryChain = (pages: Ably.InboundMessage[][]): MockHistoryPage => {
  const build = (i: number): MockHistoryPage => ({
    items: pages[i] ?? [],
    hasNext: () => i < pages.length - 1,
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    next: () => Promise.resolve(i < pages.length - 1 ? build(i + 1) : undefined),
  });
  return build(0);
};

/**
 * Build a mock Ably channel whose `history()` returns the given page chain.
 * @param pages - Pages in newest-first order; each page's items are also newest-first.
 * @returns A minimal `RealtimeChannel` with `attach` and `history` mocked.
 */
const createMockChannel = (pages: Ably.InboundMessage[][] = []): Ably.RealtimeChannel => {
  const channel = {
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    attach: vi.fn(() => Promise.resolve()),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
    history: vi.fn(() => Promise.resolve(buildHistoryChain(pages))),
  };
  return channel as unknown as Ably.RealtimeChannel;
};

// ---------------------------------------------------------------------------
// Mock codec — decoder looks up per-serial outputs; accumulator simulates
// real aggregation of discrete messages and streamed runs.
// ---------------------------------------------------------------------------

// The real decoder handles first-contact for `message.update` and
// `message.append` on an unseen serial (see `_decodeUpdate` /
// `_decodeFirstContact`), so the mock does not require a preceding
// `message.create`. Chronological-order regressions are still caught by
// the mock accumulator below: text deltas applied in the wrong order
// produce wrong `content`, and a finish event arriving before its
// message's first event never moves anything into `completedMessages`.
const createMockDecoder = (): StreamDecoder<TestEvent, TestMessage> => ({
  decode: vi.fn((msg: Ably.InboundMessage): TestDecoderOutput[] => {
    const outputs = outputsByMessage.get(msg);
    return outputs ? outputs.map((o) => ({ ...o })) : [];
  }),
});

const createMockAccumulator = (): MessageAccumulator<TestEvent, TestMessage> => {
  const messages: TestMessage[] = [];
  const completed: TestMessage[] = [];
  const active = new Map<string, TestMessage>();

  const complete = (msgId: string): void => {
    const m = active.get(msgId);
    if (!m) return;
    if (!completed.includes(m)) completed.push(m);
    active.delete(msgId);
  };

  return {
    processOutputs: (outputs) => {
      for (const output of outputs) {
        if (output.kind === 'message') {
          messages.push(output.message);
          completed.push(output.message);
          continue;
        }
        const { event, messageId } = output;
        if (!messageId) continue;
        if (event.type === 'finish') {
          complete(messageId);
          continue;
        }
        // text event
        let m = active.get(messageId);
        if (!m) {
          m = { id: messageId, content: '' };
          active.set(messageId, m);
          messages.push(m);
        }
        m.content += event.text ?? '';
      }
    },
    updateMessage: () => {
      /* not exercised by these tests */
    },
    initMessage: (messageId, message) => {
      if (!active.has(messageId)) {
        active.set(messageId, message);
      }
    },
    completeMessage: (messageId) => {
      complete(messageId);
    },
    messages,
    completedMessages: completed,
    hasActiveStream: false,
  };
};

const createMockCodec = (): Codec<TestEvent, TestMessage> => ({
  createEncoder: vi.fn(),
  createDecoder: vi.fn(() => createMockDecoder()),
  createAccumulator: vi.fn(() => createMockAccumulator()),
  isTerminal: vi.fn((event: TestEvent) => event.type === 'finish'),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('decodeHistory', () => {
  beforeEach(() => {
    serialCounter = 0;
  });

  it('returns all items when a single page fully satisfies the limit', async () => {
    // Ably pages arrive newest-first, so the newest message is first in the array.
    const m3 = discreteMsg('u3', 'third');
    const m2 = discreteMsg('u2', 'second');
    const m1 = discreteMsg('u1', 'first');

    const channel = createMockChannel([[m3, m2, m1]]);
    const codec = createMockCodec();

    const page = await decodeHistory(channel, codec, { limit: 3 }, silentLogger);

    // items are chronological (oldest first) in the public result.
    expect(page.items.map((i) => i.message.id)).toEqual(['u1', 'u2', 'u3']);
    expect(page.items.map((i) => i.message.content)).toEqual(['first', 'second', 'third']);
    expect(page.hasNext()).toBe(false);
    expect(page.rawMessages.map((m) => m.serial)).toEqual([m1.serial, m2.serial, m3.serial]);
  });

  it('returns fewer than limit when history has fewer completed messages', async () => {
    const m2 = discreteMsg('u2', 'second');
    const m1 = discreteMsg('u1', 'first');
    const channel = createMockChannel([[m2, m1]]);
    const codec = createMockCodec();

    const page = await decodeHistory(channel, codec, { limit: 10 }, silentLogger);

    expect(page.items).toHaveLength(2);
    expect(page.hasNext()).toBe(false);
  });

  it('fetches additional pages until the limit is satisfied', async () => {
    // Page 1 (newest): 1 complete. Page 2 (older): 2 complete. Limit = 3.
    const pageNewest = [discreteMsg('u3', 'third')];
    const pageOlder = [discreteMsg('u2', 'second'), discreteMsg('u1', 'first')];

    const channel = createMockChannel([pageNewest, pageOlder]);
    const codec = createMockCodec();

    const page = await decodeHistory(channel, codec, { limit: 3 }, silentLogger);

    expect(page.items.map((i) => i.message.id)).toEqual(['u1', 'u2', 'u3']);
    expect(page.hasNext()).toBe(false);
  });

  it('reconstructs a run whose stream spans a page boundary', async () => {
    // Run T1: message.create is in the OLDER page, the deltas and finish are
    // in the NEWER page. All four wire messages share the SAME Ably serial
    // (real append semantics), so the decoder's per-serial state must be
    // built from oldest to newest - otherwise the appends hit before the
    // create and emit nothing. This directly exercises the invariant that
    // decode-history re-decodes in chronological order.
    const [finish, delta2, delta1, create] = streamingRun('T1', 'asst-1', ['hello', ' world']);
    if (!finish || !delta2 || !delta1 || !create) throw new Error('invariant: 4 wire messages');

    // Newest page: finish, delta2, delta1 (newest-first within the page).
    // Older page: just the create.
    const channel = createMockChannel([[finish, delta2, delta1], [create]]);
    const codec = createMockCodec();

    const page = await decodeHistory(channel, codec, { limit: 1 }, silentLogger);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.message).toEqual({ id: 'asst-1', content: 'hello world' });
  });

  it('handles two runs interleaved across pages', async () => {
    // Each run's four wire messages share their own serial. The runs are
    // interleaved so that both cross the page boundary.
    const [aFinish, aDelta, aCreate] = streamingRun('TA', 'asst-A', ['A-text']);
    const [bFinish, bDelta, bCreate] = streamingRun('TB', 'asst-B', ['B-text']);
    if (!aFinish || !aDelta || !aCreate || !bFinish || !bDelta || !bCreate) {
      throw new Error('invariant: 3 wire messages per run (finish, delta, create)');
    }

    // Newest page (top of history): aFinish, bFinish, aDelta, bDelta
    // Older page: bCreate, aCreate (in newest-first order within the page)
    const channel = createMockChannel([
      [aFinish, bFinish, aDelta, bDelta],
      [bCreate, aCreate],
    ]);
    const codec = createMockCodec();

    const page = await decodeHistory(channel, codec, { limit: 10 }, silentLogger);

    const byId = new Map(page.items.map((i) => [i.message.id, i.message.content]));
    expect(byId.get('asst-A')).toBe('A-text');
    expect(byId.get('asst-B')).toBe('B-text');
    expect(page.items).toHaveLength(2);
  });

  it('omits runs that never received a terminal event', async () => {
    // Complete run (create + delta + finish) plus an incomplete run (just
    // a create). Only the completed one should be returned.
    const [completeFinish, completeDelta, completeCreate] = streamingRun('T1', 'asst-1', ['done']);
    const [incompleteCreate] = streamingRun('T2', 'asst-2', []);
    if (!completeFinish || !completeDelta || !completeCreate || !incompleteCreate) {
      throw new Error('invariant: wire messages present');
    }

    // All on a single page, newest-first.
    const channel = createMockChannel([[completeFinish, completeDelta, completeCreate, incompleteCreate]]);
    const codec = createMockCodec();

    const page = await decodeHistory(channel, codec, { limit: 10 }, silentLogger);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.message.id).toBe('asst-1');
  });

  it('returns an empty page when history has no messages', async () => {
    const channel = createMockChannel([]);
    const codec = createMockCodec();

    const page = await decodeHistory(channel, codec, { limit: 10 }, silentLogger);

    expect(page.items).toEqual([]);
    expect(page.rawMessages).toEqual([]);
    expect(page.hasNext()).toBe(false);
  });

  it('paginates via next() when the first page is limited by `limit`', async () => {
    // Single Ably page has 4 completes; limit=2 forces a paginated result.
    const m4 = discreteMsg('u4', 'd');
    const m3 = discreteMsg('u3', 'c');
    const m2 = discreteMsg('u2', 'b');
    const m1 = discreteMsg('u1', 'a');

    const channel = createMockChannel([[m4, m3, m2, m1]]);
    const codec = createMockCodec();

    const first = await decodeHistory(channel, codec, { limit: 2 }, silentLogger);
    expect(first.items.map((i) => i.message.id)).toEqual(['u3', 'u4']); // newest two, chronological
    expect(first.hasNext()).toBe(true);

    const second = await first.next();
    expect(second).toBeDefined();
    expect(second?.items.map((i) => i.message.id)).toEqual(['u1', 'u2']); // older two
    expect(second?.hasNext()).toBe(false);
  });

  it('serves next() from the buffer without fetching another Ably page', async () => {
    // Only one Ably page, but buffer holds more completes than `limit`.
    const m3 = discreteMsg('u3', 'c');
    const m2 = discreteMsg('u2', 'b');
    const m1 = discreteMsg('u1', 'a');
    const channel = createMockChannel([[m3, m2, m1]]);
    const codec = createMockCodec();

    const first = await decodeHistory(channel, codec, { limit: 2 }, silentLogger);
    expect(first.items).toHaveLength(2);

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.mocked takes a method reference
    const historySpy = vi.mocked(channel.history);
    const callsBefore = historySpy.mock.calls.length;

    const second = await first.next();
    expect(second?.items.map((i) => i.message.id)).toEqual(['u1']);

    // Should not have made another `channel.history()` call — the buffer
    // already held the remaining message.
    expect(historySpy.mock.calls.length).toBe(callsBefore);
  });

  it('returns the canonical headers and first-seen serial for each item', async () => {
    const extra = { 'x-extra': 'v1' };
    const m = discreteMsg('u1', 'hi', extra);
    const channel = createMockChannel([[m]]);
    const codec = createMockCodec();

    const page = await decodeHistory(channel, codec, { limit: 1 }, silentLogger);

    expect(page.items[0]?.serial).toBe(m.serial);
    expect(page.items[0]?.headers).toMatchObject({ [HEADER_MSG_ID]: 'u1', 'x-extra': 'v1' });
  });

  it('routes cross-run amendments to the originating run', async () => {
    // Run T1 streams and finishes. A later message in run T2 amends T1's
    // message. The amendment should be applied to the existing message via
    // initMessage/completeMessage, not create a duplicate.
    const [finish, delta, create] = streamingRun('T1', 'asst-1', ['original']);
    if (!finish || !delta || !create) throw new Error('invariant: 3 wire messages');
    const amend = amendMsg('asst-1', 'T2');

    const channel = createMockChannel([[amend, finish, delta, create]]);
    const codec = createMockCodec();

    const page = await decodeHistory(channel, codec, { limit: 10 }, silentLogger);

    // Only the one message from T1 should appear; T2's amendment targets it.
    const asstItems = page.items.filter((i) => i.message.id === 'asst-1');
    expect(asstItems).toHaveLength(1);
    // Amend appends '[amended]' to the existing content via the simulated
    // accumulator (the real accumulator does the same via initMessage).
    expect(asstItems[0]?.message.content).toContain('original');
  });

  it('uses a default limit when options is omitted', async () => {
    // Three messages, no options. With the default limit (100) all three
    // must come back in a single page.
    const m3 = discreteMsg('u3', 'c');
    const m2 = discreteMsg('u2', 'b');
    const m1 = discreteMsg('u1', 'a');
    const channel = createMockChannel([[m3, m2, m1]]);
    const codec = createMockCodec();

    const page = await decodeHistory(channel, codec, undefined, silentLogger);

    expect(page.items).toHaveLength(3);
    expect(page.hasNext()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Efficiency tests — bound the number of decoder instantiations to guard
  // against re-introducing redundant decode passes. Each decodeAll call
  // creates a fresh decoder, so `codec.createDecoder` invocation count is a
  // direct proxy for how many full decodes ran.
  // -------------------------------------------------------------------------

  it('does not decode twice when buildResult follows fetchUntilLimit on unchanged state', async () => {
    // Single page, fits under limit. fetchUntilLimit decodes once to check
    // the count; buildResult must reuse that result, not re-decode.
    const m3 = discreteMsg('u3', 'c');
    const m2 = discreteMsg('u2', 'b');
    const m1 = discreteMsg('u1', 'a');
    const channel = createMockChannel([[m3, m2, m1]]);
    const codec = createMockCodec();

    await decodeHistory(channel, codec, { limit: 10 }, silentLogger);

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.mocked takes a method reference
    expect(vi.mocked(codec.createDecoder).mock.calls.length).toBe(1);
  });

  it('serves buffered next() without re-decoding', async () => {
    // Single Ably page with 4 completes; limit=2 forces paginated result.
    // The second page (served from buffer) must not trigger a fresh decode.
    const m4 = discreteMsg('u4', 'd');
    const m3 = discreteMsg('u3', 'c');
    const m2 = discreteMsg('u2', 'b');
    const m1 = discreteMsg('u1', 'a');
    const channel = createMockChannel([[m4, m3, m2, m1]]);
    const codec = createMockCodec();

    const first = await decodeHistory(channel, codec, { limit: 2 }, silentLogger);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.mocked takes a method reference
    const callsAfterFirst = vi.mocked(codec.createDecoder).mock.calls.length;

    await first.next();

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.mocked takes a method reference
    expect(vi.mocked(codec.createDecoder).mock.calls.length).toBe(callsAfterFirst);
  });

  it('decodes exactly once per Ably page fetched across decodeHistory() + next()', async () => {
    // Two Ably pages, 1 complete each, limit=1. First decodeHistory() fetches
    // page 1 (1 decode); next() fetches page 2 (1 more decode). Anything
    // higher means either buildResult is re-decoding unchanged state, or
    // fetchUntilLimit is decoding more than once per added page.
    const channel = createMockChannel([[discreteMsg('u2', 'b')], [discreteMsg('u1', 'a')]]);
    const codec = createMockCodec();

    const first = await decodeHistory(channel, codec, { limit: 1 }, silentLogger);
    await first.next();

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.mocked takes a method reference
    expect(vi.mocked(codec.createDecoder).mock.calls.length).toBe(2);
  });

  it('returns correct data when next() fetches a new Ably page (cache invalidation)', async () => {
    // A broken cache that failed to invalidate on new pages would return
    // stale page-1 data here. This is the correctness counterpart to the
    // decoder-count assertion above.
    const channel = createMockChannel([[discreteMsg('u2', 'b')], [discreteMsg('u1', 'a')]]);
    const codec = createMockCodec();

    const first = await decodeHistory(channel, codec, { limit: 1 }, silentLogger);
    expect(first.items.map((i) => i.message.id)).toEqual(['u2']);

    const second = await first.next();
    expect(second?.items.map((i) => i.message.id)).toEqual(['u1']);
  });

  it('creates exactly one decoder per decodeHistory() call regardless of page count', async () => {
    // Primary O(n^2) regression guard. 20 Ably pages, 1 completed message
    // each. The fetch loop walks all 20 pages using header-based counting;
    // only buildResult runs the full decode. Anything above 1 means
    // fetchUntilLimit is calling decodeAll (the old O(n^2) path) or
    // buildResult is re-decoding cached state.
    const pageCount = 20;
    const pages = Array.from({ length: pageCount }, (_, i) => [discreteMsg(`u${String(pageCount - i)}`, 'x')]);
    const channel = createMockChannel(pages);
    const codec = createMockCodec();

    await decodeHistory(channel, codec, { limit: pageCount }, silentLogger);

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.mocked takes a method reference
    expect(vi.mocked(codec.createDecoder).mock.calls.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Edge cases for the header-based completion counter
  // -------------------------------------------------------------------------

  it('returns empty result without spinning when history has no terminal signal', async () => {
    // A single `message.create` with no terminal anywhere in history. The
    // counter sees "created" but never "terminated", so the loop must
    // exhaust Ably pages and return an empty result rather than hang.
    const create = withOutputs(
      ablyMsg({
        action: 'message.create',
        headers: { [HEADER_RUN_ID]: 'T1', [HEADER_MSG_ID]: 'asst-1', [HEADER_STREAM]: 'true' },
      }),
      [{ kind: 'event', event: { type: 'text', text: '' }, messageId: 'asst-1' }],
    );
    const channel = createMockChannel([[create]]);
    const codec = createMockCodec();

    const page = await decodeHistory(channel, codec, { limit: 10 }, silentLogger);

    expect(page.items).toEqual([]);
    expect(page.hasNext()).toBe(false);
  });

  it('treats x-ably-status:aborted as terminal for counting', async () => {
    // Same shape as a normal finish test but the terminal append carries
    // status=aborted. The counter's terminal rule must accept either
    // "finished" or "aborted" to complete the msg-id on page 1.
    const serial = nextSerial();
    const baseHeaders = { [HEADER_RUN_ID]: 'T1', [HEADER_MSG_ID]: 'asst-1', [HEADER_STREAM]: 'true' };
    const create = withOutputs(ablyMsg({ action: 'message.create', headers: baseHeaders, serial }), [
      { kind: 'event', event: { type: 'text', text: 'partial' }, messageId: 'asst-1' },
    ]);
    const abort = withOutputs(
      ablyMsg({
        action: 'message.append',
        headers: { ...baseHeaders, [HEADER_STATUS]: 'aborted' },
        serial,
      }),
      [{ kind: 'event', event: { type: 'finish' }, messageId: 'asst-1' }],
    );

    // Single page, newest-first: abort then create.
    const channel = createMockChannel([[abort, create]]);
    const codec = createMockCodec();

    const page = await decodeHistory(channel, codec, { limit: 1 }, silentLogger);

    expect(page.items).toHaveLength(1);
  });

  it('completes a streamed run delivered as a single message.update (history compaction)', async () => {
    // history can compact a live `create + append + ... + append{finished}`
    // sequence into a single `message.update` carrying the accumulated data
    // and `x-ably-status: "finished"`. The decoder handles this via
    // first-contact in `_decodeUpdate`; the counter must too, otherwise the
    // fetch loop pages past a compacted run without ever marking it
    // complete (there's no preceding `message.create` to match on).
    //
    // To catch the regression — not just verify user-visible output —
    // stage a second Ably page that must NOT be fetched if the counter
    // correctly recognises the compacted update as complete.
    const compacted = withOutputs(
      ablyMsg({
        action: 'message.update',
        headers: {
          [HEADER_RUN_ID]: 'T1',
          [HEADER_MSG_ID]: 'asst-1',
          [HEADER_STREAM]: 'true',
          [HEADER_STATUS]: 'finished',
        },
      }),
      [
        { kind: 'event', event: { type: 'text', text: 'compacted content' }, messageId: 'asst-1' },
        { kind: 'event', event: { type: 'finish' }, messageId: 'asst-1' },
      ],
    );
    const staleOlderPage = discreteMsg('should-not-be-fetched', 'ignored');
    const channel = createMockChannel([[compacted], [staleOlderPage]]);
    const codec = createMockCodec();

    const page = await decodeHistory(channel, codec, { limit: 1 }, silentLogger);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.message).toEqual({ id: 'asst-1', content: 'compacted content' });
    // If the counter didn't recognise the update as a start, the loop
    // would have paged into `staleOlderPage`. `rawMessages` should only
    // contain the compacted update.
    expect(page.rawMessages).toHaveLength(1);
  });

  it('counts a message.append as a start signal (first-contact delivery)', async () => {
    // Same story as the compacted-update case but with `message.append`.
    // The real decoder falls through to `_decodeUpdate` when an append
    // arrives on a serial it hasn't seen, so a single append with
    // `STATUS=finished` represents a viable completable message.
    const firstContact = withOutputs(
      ablyMsg({
        action: 'message.append',
        headers: {
          [HEADER_RUN_ID]: 'T1',
          [HEADER_MSG_ID]: 'asst-1',
          [HEADER_STREAM]: 'true',
          [HEADER_STATUS]: 'finished',
        },
      }),
      [
        { kind: 'event', event: { type: 'text', text: 'appended content' }, messageId: 'asst-1' },
        { kind: 'event', event: { type: 'finish' }, messageId: 'asst-1' },
      ],
    );
    const staleOlderPage = discreteMsg('should-not-be-fetched', 'ignored');
    const channel = createMockChannel([[firstContact], [staleOlderPage]]);
    const codec = createMockCodec();

    const page = await decodeHistory(channel, codec, { limit: 1 }, silentLogger);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.message).toEqual({ id: 'asst-1', content: 'appended content' });
    expect(page.rawMessages).toHaveLength(1);
  });

  it('does not count cross-run amendments as new completions', async () => {
    // A finished run plus an amendment on the same msg-id. Naive counting
    // that didn't skip HEADER_AMEND would double-count. We only want one
    // completion here.
    const [finish, delta, create] = streamingRun('T1', 'asst-1', ['original']);
    if (!finish || !delta || !create) throw new Error('invariant: 3 wire messages');
    const amend = amendMsg('asst-1', 'T2');
    const channel = createMockChannel([[amend, finish, delta, create]]);
    const codec = createMockCodec();

    const page = await decodeHistory(channel, codec, { limit: 10 }, silentLogger);

    // One message (the amended one). If the counter had incorrectly added
    // the amendment's msg-id again via the terminal status header, the
    // fetch loop would still stop at the correct size because Sets
    // deduplicate - but let's verify the output count matches.
    expect(page.items.filter((i) => i.message.id === 'asst-1')).toHaveLength(1);
  });

  it('handles truncated history (terminal wire message with no create in range)', async () => {
    // Pathological case: a finish survives but the create has rolled off.
    // The counter never marks it complete (needs both halves), so the loop
    // exhausts pages. buildResult decodes and gets nothing (mock decoder
    // emits nothing for appends without a preceding create). The call
    // must return cleanly with fewer items than requested.
    const serial = nextSerial();
    const orphan = withOutputs(
      ablyMsg({
        action: 'message.append',
        headers: {
          [HEADER_RUN_ID]: 'T1',
          [HEADER_MSG_ID]: 'orphan',
          [HEADER_STREAM]: 'true',
          [HEADER_STATUS]: 'finished',
        },
        serial,
      }),
      [{ kind: 'event', event: { type: 'finish' }, messageId: 'orphan' }],
    );
    const channel = createMockChannel([[orphan]]);
    const codec = createMockCodec();

    const page = await decodeHistory(channel, codec, { limit: 5 }, silentLogger);

    expect(page.items).toEqual([]);
    expect(page.hasNext()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Latest-serial-wins per run-id
  // -------------------------------------------------------------------------

  describe('latest-serial-wins on hydration', () => {
    /**
     * Build a user-message discrete wire message with invocation-id.
     * @param msgId - Message identifier stamped in `x-ably-msg-id`.
     * @param content - User text content placed inside the message body.
     * @param runId - Run identifier stamped in `x-ably-run-id`.
     * @param invocationId - Invocation identifier stamped in `x-ably-invocation-id`.
     * @returns A fully formed Ably InboundMessage representing the user prompt.
     */
    const userDiscreteMsg = (
      msgId: string,
      content: string,
      runId: string,
      invocationId: string,
      // eslint-disable-next-line unicorn/consistent-function-scoping -- describe-local helper
    ): Ably.InboundMessage =>
      withOutputs(
        ablyMsg({
          headers: {
            [HEADER_MSG_ID]: msgId,
            [HEADER_RUN_ID]: runId,
            [HEADER_INVOCATION_ID]: invocationId,
            [HEADER_ROLE]: 'user',
            [HEADER_STREAM]: 'false',
            [HEADER_DISCRETE]: 'true',
          },
        }),
        [{ kind: 'message', message: { id: msgId, content } }],
      );

    it('keeps only the winning invocation when a run has multiple user-messages', async () => {
      // Chronological order: invocation-1 (user + assistant), then invocation-2 (user + assistant)
      // History returns newest-first.
      const u1 = userDiscreteMsg('user-1', 'first ask', 'R1', 'inv-1');
      const [aFinish, aDelta, aCreate] = streamingRun('R1', 'asst-1', ['answer-1']);
      const u2 = userDiscreteMsg('user-2', 'second ask', 'R1', 'inv-2');
      const [bFinish, bDelta, bCreate] = streamingRun('R1', 'asst-2', ['answer-2']);
      if (!aFinish || !aDelta || !aCreate || !bFinish || !bDelta || !bCreate) {
        throw new Error('invariant: 3 wire messages per run');
      }

      // Newest-first: invocation-2's chunks (newest), then invocation-1's chunks (older).
      const channel = createMockChannel([[bFinish, bDelta, bCreate, u2, aFinish, aDelta, aCreate, u1]]);
      const codec = createMockCodec();

      const page = await decodeHistory(channel, codec, { limit: 10 }, silentLogger);

      // Only the winning invocation's messages should appear.
      const ids = page.items.map((i) => i.message.id);
      expect(ids).toEqual(['user-2', 'asst-2']);
    });

    it('preserves single-invocation runs unchanged', async () => {
      const u1 = userDiscreteMsg('user-1', 'ask', 'R1', 'inv-1');
      const [finish, delta, create] = streamingRun('R1', 'asst-1', ['answer']);
      if (!finish || !delta || !create) throw new Error('invariant');

      const channel = createMockChannel([[finish, delta, create, u1]]);
      const codec = createMockCodec();

      const page = await decodeHistory(channel, codec, { limit: 10 }, silentLogger);

      const ids = page.items.map((i) => i.message.id);
      expect(ids).toEqual(['user-1', 'asst-1']);
    });

    it('preserves runs that have no user-message with invocation-id (e.g. legacy)', async () => {
      // No user-message at all under this run — the agent published the user message.
      // No winning user-message → no filter applied.
      const [finish, delta, create] = streamingRun('R1', 'asst-1', ['answer']);
      if (!finish || !delta || !create) throw new Error('invariant');

      const channel = createMockChannel([[finish, delta, create]]);
      const codec = createMockCodec();

      const page = await decodeHistory(channel, codec, { limit: 10 }, silentLogger);

      const ids = page.items.map((i) => i.message.id);
      expect(ids).toEqual(['asst-1']);
    });
  });
});
