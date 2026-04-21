import type * as Ably from 'ably';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HEADER_AMEND, HEADER_MSG_ID, HEADER_TURN_ID } from '../../../src/constants.js';
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
// Keyed by message identity (not serial) because a streaming turn's wire
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
 * Build a discrete (non-turn) message and the corresponding decoder output.
 * @param msgId - The `x-ably-msg-id` header value.
 * @param content - The domain message content.
 * @param extraHeaders - Additional headers to set on the Ably message.
 * @returns The built Ably message, with outputs registered.
 */
const discreteMsg = (msgId: string, content: string, extraHeaders: Record<string, string> = {}): Ably.InboundMessage =>
  withOutputs(ablyMsg({ headers: { [HEADER_MSG_ID]: msgId, ...extraHeaders } }), [
    { kind: 'message', message: { id: msgId, content } },
  ]);

/**
 * Build the four wire messages for a single streaming turn. All four share
 * the same Ably serial (per real Ably append semantics) and the same
 * `x-ably-msg-id` header. Returned in newest-first order to match Ably
 * history's convention (finish first, then deltas, then create).
 * @param turnId - The `x-ably-turn-id` header value.
 * @param msgId - The `x-ably-msg-id` header value.
 * @param deltas - Text deltas in chronological (send) order.
 * @returns `[finish, ...deltas.reverse(), create]` — newest-first.
 */
const streamingTurn = (turnId: string, msgId: string, deltas: string[]): Ably.InboundMessage[] => {
  const serial = nextSerial();
  const baseHeaders = { [HEADER_TURN_ID]: turnId, [HEADER_MSG_ID]: msgId };

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
      headers: { ...baseHeaders, 'x-ably-status': 'finished' },
      serial,
    }),
    [{ kind: 'event', event: { type: 'finish' }, messageId: msgId }],
  );

  // Newest-first: finish, then deltas reversed, then create.
  return [finish, ...deltaMessages.toReversed(), create];
};

/**
 * Build a cross-turn amendment targeting an existing message.
 * @param targetMsgId - The `x-ably-msg-id` of the existing message to amend.
 * @param turnId - The `x-ably-turn-id` of the amending turn.
 * @returns The built Ably message, with outputs registered.
 */
const amendMsg = (targetMsgId: string, turnId: string): Ably.InboundMessage =>
  withOutputs(
    ablyMsg({
      headers: {
        [HEADER_MSG_ID]: targetMsgId,
        [HEADER_AMEND]: targetMsgId,
        [HEADER_TURN_ID]: turnId,
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
// real aggregation of discrete messages and streamed turns.
// ---------------------------------------------------------------------------

const createMockDecoder = (): StreamDecoder<TestEvent, TestMessage> => {
  const seenSerials = new Set<string>();
  return {
    decode: vi.fn((msg: Ably.InboundMessage): TestDecoderOutput[] => {
      const outputs = outputsByMessage.get(msg);
      if (!outputs) return [];
      // Simulate the real decoder's per-serial state: an append/update on a
      // serial that hasn't been opened by a prior `message.create` is a
      // regression signal. Emit nothing to make such bugs observable.
      const serial = msg.serial ?? '';
      const action = msg.action;
      if (action === 'message.create') {
        seenSerials.add(serial);
      } else if (!seenSerials.has(serial)) {
        // Out-of-order: append/update arrived before its create was seen.
        return [];
      }
      return outputs.map((o) => ({ ...o }));
    }),
  };
};

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

  it('reconstructs a turn whose stream spans a page boundary', async () => {
    // Turn T1: message.create is in the OLDER page, the deltas and finish are
    // in the NEWER page. All four wire messages share the SAME Ably serial
    // (real append semantics), so the decoder's per-serial state must be
    // built from oldest to newest - otherwise the appends hit before the
    // create and emit nothing. This directly exercises the invariant that
    // decode-history re-decodes in chronological order.
    const [finish, delta2, delta1, create] = streamingTurn('T1', 'asst-1', ['hello', ' world']);
    if (!finish || !delta2 || !delta1 || !create) throw new Error('invariant: 4 wire messages');

    // Newest page: finish, delta2, delta1 (newest-first within the page).
    // Older page: just the create.
    const channel = createMockChannel([[finish, delta2, delta1], [create]]);
    const codec = createMockCodec();

    const page = await decodeHistory(channel, codec, { limit: 1 }, silentLogger);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.message).toEqual({ id: 'asst-1', content: 'hello world' });
  });

  it('handles two turns interleaved across pages', async () => {
    // Each turn's four wire messages share their own serial. The turns are
    // interleaved so that both cross the page boundary.
    const [aFinish, aDelta, aCreate] = streamingTurn('TA', 'asst-A', ['A-text']);
    const [bFinish, bDelta, bCreate] = streamingTurn('TB', 'asst-B', ['B-text']);
    if (!aFinish || !aDelta || !aCreate || !bFinish || !bDelta || !bCreate) {
      throw new Error('invariant: 3 wire messages per turn (finish, delta, create)');
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

  it('omits turns that never received a terminal event', async () => {
    // Complete turn (create + delta + finish) plus an incomplete turn (just
    // a create). Only the completed one should be returned.
    const [completeFinish, completeDelta, completeCreate] = streamingTurn('T1', 'asst-1', ['done']);
    const [incompleteCreate] = streamingTurn('T2', 'asst-2', []);
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

  it('routes cross-turn amendments to the originating turn', async () => {
    // Turn T1 streams and finishes. A later message in turn T2 amends T1's
    // message. The amendment should be applied to the existing message via
    // initMessage/completeMessage, not create a duplicate.
    const [finish, delta, create] = streamingTurn('T1', 'asst-1', ['original']);
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
});
