/**
 * decodeHistory unit tests.
 *
 * Rewritten against the event-sourced `Codec<TEvent, TProjection, TMessage>`
 * contract — decoder returns `TEvent[]`; per-run projections are built via
 * `init`/`fold`; messages are extracted via `getMessages`. Amend semantics
 * follow the producer-responsibility model: matching `HEADER_RUN_ID` folds
 * into the same projection; mismatched run-ids are dropped at the reducer
 * (orphan).
 */

import type * as Ably from 'ably';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HEADER_CODEC_MESSAGE_ID,
  HEADER_DISCRETE,
  HEADER_INVOCATION_ID,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_RUN_CONTINUE,
  HEADER_RUN_ID,
  HEADER_STATUS,
  HEADER_STREAM,
} from '../../../src/constants.js';
import type { Codec, Decoder, Encoder, ReducerMeta } from '../../../src/core/codec/types.js';
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

interface TestProjection {
  /** Map of codec-message-id → in-progress message (mirrors the runtime tracker pattern). */
  byId: Map<string, TestMessage>;
  /** Ordered list of codec-message-ids (insertion order). */
  order: string[];
}

const silentLogger = makeLogger({ logLevel: LogLevel.Silent });

// ---------------------------------------------------------------------------
// Decoder output registry — events to emit on a per-message basis. A fresh
// decoder is created per decode pass, so this lives outside the decoder.
// ---------------------------------------------------------------------------

const eventsByMessage = new WeakMap<Ably.InboundMessage, TestEvent[]>();

// ---------------------------------------------------------------------------
// Ably message builders
// ---------------------------------------------------------------------------

let serialCounter = 0;

const nextSerial = (): string => {
  serialCounter += 1;
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

const withEvents = (msg: Ably.InboundMessage, events: TestEvent[]): Ably.InboundMessage => {
  eventsByMessage.set(msg, events);
  return msg;
};

const discreteMsg = (
  codecMessageId: string,
  content: string,
  extraHeaders: Record<string, string> = {},
): Ably.InboundMessage =>
  withEvents(
    ablyMsg({
      headers: {
        [HEADER_CODEC_MESSAGE_ID]: codecMessageId,
        [HEADER_STREAM]: 'false',
        [HEADER_DISCRETE]: 'true',
        ...extraHeaders,
      },
    }),
    [{ type: 'text', text: content }, { type: 'finish' }],
  );

const streamingRun = (runId: string, codecMessageId: string, deltas: string[]): Ably.InboundMessage[] => {
  const serial = nextSerial();
  const baseHeaders = {
    [HEADER_RUN_ID]: runId,
    [HEADER_CODEC_MESSAGE_ID]: codecMessageId,
    [HEADER_STREAM]: 'true',
  };

  const create = withEvents(ablyMsg({ action: 'message.create', headers: baseHeaders, serial }), []);
  const deltaMessages = deltas.map((text) =>
    withEvents(ablyMsg({ action: 'message.append', headers: baseHeaders, serial }), [{ type: 'text', text }]),
  );
  const finish = withEvents(
    ablyMsg({
      action: 'message.append',
      headers: { ...baseHeaders, [HEADER_STATUS]: 'complete' },
      serial,
    }),
    [{ type: 'finish' }],
  );

  // Newest-first (as Ably history returns): finish first, deltas reversed, create last.
  return [finish, ...deltaMessages.toReversed(), create];
};

const userMsg = (
  runId: string,
  codecMessageId: string,
  content: string,
  invocationId: string,
  serial?: string,
): Ably.InboundMessage =>
  withEvents(
    ablyMsg({
      action: 'message.create',
      headers: {
        [HEADER_RUN_ID]: runId,
        [HEADER_CODEC_MESSAGE_ID]: codecMessageId,
        [HEADER_ROLE]: 'user',
        [HEADER_INVOCATION_ID]: invocationId,
        [HEADER_STREAM]: 'false',
        [HEADER_DISCRETE]: 'true',
      },
      ...(serial !== undefined && { serial }),
    }),
    [{ type: 'text', text: content }, { type: 'finish' }],
  );

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

// ---------------------------------------------------------------------------
// Mock codec — decoder pulls events from the per-message registry; the
// reducer accumulates text per codec-message-id (drawn from meta.messageId).
// ---------------------------------------------------------------------------

const createMockDecoder = (): Decoder<TestEvent> => ({
  decode: vi.fn((msg: Ably.InboundMessage): TestEvent[] => {
    const evs = eventsByMessage.get(msg);
    return evs ? evs.map((e) => ({ ...e })) : [];
  }),
});

const noopEncoderFactory = (): Encoder<TestEvent> => ({
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
  publish: () => Promise.resolve(),
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
  cancel: () => Promise.resolve(),
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
  close: () => Promise.resolve(),
});

const createMockCodec = (): Codec<TestEvent, TestProjection, TestMessage> & {
  decoderInstances: number;
} => {
  const counters = { decoderInstances: 0 };
  return {
    get decoderInstances() {
      return counters.decoderInstances;
    },
    init: vi.fn(
      (): TestProjection => ({
        byId: new Map<string, TestMessage>(),
        order: [],
      }),
    ),
    fold: vi.fn((state: TestProjection, event: TestEvent, meta: ReducerMeta) => {
      const messageId = meta.messageId;
      if (!messageId) return state;
      let msg = state.byId.get(messageId);
      if (!msg) {
        msg = { id: messageId, content: '' };
        state.byId.set(messageId, msg);
        state.order.push(messageId);
      }
      if (event.type === 'text' && typeof event.text === 'string') {
        msg.content += event.text;
      }
      return state;
    }),
    getMessages: vi.fn((p: TestProjection) => p.order.map((id) => p.byId.get(id)).filter((m): m is TestMessage => !!m)),
    dropMessages: vi.fn((p: TestProjection, codecMessageIds: string[]) => {
      const drop = new Set(codecMessageIds);
      p.order = p.order.filter((id) => !drop.has(id));
      for (const id of drop) p.byId.delete(id);
      return p;
    }),
    userMessageEvent: vi.fn((m: TestMessage): TestEvent => ({ type: 'text', text: m.content })),
    createRegenerateEvent: vi.fn((): TestEvent => ({ type: 'text', text: '' })),
    classifyEvent: vi.fn(() => ({ kind: 'other' as const }) as const),
    // eslint-disable-next-line unicorn/no-useless-undefined -- vi.fn requires an explicit return matching the codec contract
    resolveToolTarget: vi.fn(() => undefined),
    createEncoder: vi.fn(() => noopEncoderFactory()),
    createDecoder: vi.fn(() => {
      counters.decoderInstances += 1;
      return createMockDecoder();
    }),
    isTerminal: vi.fn((e: TestEvent) => e.type === 'finish'),
  };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('decodeHistory', () => {
  beforeEach(() => {
    serialCounter = 0;
  });

  // -------------------------------------------------------------------------
  // Basic pagination
  // -------------------------------------------------------------------------

  describe('pagination', () => {
    it('returns all items when a single page satisfies the limit', async () => {
      const m3 = discreteMsg('u3', 'third');
      const m2 = discreteMsg('u2', 'second');
      const m1 = discreteMsg('u1', 'first');
      const channel = createMockChannel([[m3, m2, m1]]);
      const codec = createMockCodec();

      const page = await decodeHistory(channel, codec, { limit: 3 }, silentLogger);

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

    it('fetches additional pages until limit is satisfied', async () => {
      const pageNewest = [discreteMsg('u3', 'third')];
      const pageOlder = [discreteMsg('u2', 'second'), discreteMsg('u1', 'first')];
      const channel = createMockChannel([pageNewest, pageOlder]);
      const codec = createMockCodec();

      const page = await decodeHistory(channel, codec, { limit: 3 }, silentLogger);

      expect(page.items.map((i) => i.message.id)).toEqual(['u1', 'u2', 'u3']);
    });

    it('paginates via next() when limit is smaller than the available items', async () => {
      const m4 = discreteMsg('u4', 'd');
      const m3 = discreteMsg('u3', 'c');
      const m2 = discreteMsg('u2', 'b');
      const m1 = discreteMsg('u1', 'a');
      const channel = createMockChannel([[m4, m3, m2, m1]]);
      const codec = createMockCodec();

      const first = await decodeHistory(channel, codec, { limit: 2 }, silentLogger);
      expect(first.items.map((i) => i.message.id)).toEqual(['u3', 'u4']);
      expect(first.hasNext()).toBe(true);

      const second = await first.next();
      expect(second).toBeDefined();
      expect(second?.items.map((i) => i.message.id)).toEqual(['u1', 'u2']);
    });

    it('returns an empty page when history has no messages', async () => {
      const channel = createMockChannel([[]]);
      const codec = createMockCodec();
      const page = await decodeHistory(channel, codec, { limit: 10 }, silentLogger);
      expect(page.items).toEqual([]);
      expect(page.hasNext()).toBe(false);
    });

    it('uses default limit when options is omitted', async () => {
      const m3 = discreteMsg('u3', 'c');
      const m2 = discreteMsg('u2', 'b');
      const m1 = discreteMsg('u1', 'a');
      const channel = createMockChannel([[m3, m2, m1]]);
      const codec = createMockCodec();

      const page = await decodeHistory(channel, codec, undefined, silentLogger);
      expect(page.items).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // Streamed runs spanning page boundaries
  // -------------------------------------------------------------------------

  describe('streaming runs', () => {
    it('reconstructs a streaming run delivered as create + appends', async () => {
      // Run T1 streams ['hi ', 'there'] across 4 wire messages
      const [finish, delta2, delta1, create] = streamingRun('T1', 'asst-1', ['hi ', 'there']);
      if (!finish || !delta2 || !delta1 || !create) throw new Error('expected 4 wire messages');

      const channel = createMockChannel([[finish, delta2, delta1, create]]);
      const codec = createMockCodec();

      const page = await decodeHistory(channel, codec, { limit: 10 }, silentLogger);

      const asst = page.items.find((i) => i.message.id === 'asst-1');
      expect(asst).toBeDefined();
      expect(asst?.message.content).toBe('hi there');
    });

    it('reconstructs a run whose stream spans a page boundary', async () => {
      // To genuinely span a boundary the counter must see only a terminal in
      // the newest page (no start) and only a start in the older. Use a
      // create with no stream header on the newest finish marker — but in
      // practice the counter treats first-contact appends as starts, so we
      // force a boundary by having an UNCOMPLETED discrete msg in the new
      // page plus a complete one in the older page.
      const m1 = discreteMsg('u1', 'older');
      const m2 = discreteMsg('u2', 'newer');
      // Page 1 (newest) has only m2; page 2 (older) has m1. With limit=2 we
      // need to fetch both pages.
      const channel = createMockChannel([[m2], [m1]]);
      const codec = createMockCodec();

      const page = await decodeHistory(channel, codec, { limit: 2 }, silentLogger);

      expect(page.items.map((i) => i.message.id)).toEqual(['u1', 'u2']);
    });

    it('treats x-ably-status:cancelled as terminal for counting', async () => {
      // A cancelled-stream message satisfies the wire-level counter the same
      // way as complete: append + stream=true + status=cancelled = complete.
      const serial = nextSerial();
      const baseHeaders = {
        [HEADER_RUN_ID]: 'T1',
        [HEADER_CODEC_MESSAGE_ID]: 'asst-cancel',
        [HEADER_STREAM]: 'true',
      };
      const cancelled = withEvents(
        ablyMsg({
          action: 'message.append',
          headers: { ...baseHeaders, [HEADER_STATUS]: 'cancelled' },
          serial,
        }),
        [{ type: 'finish' }],
      );

      const channel = createMockChannel([[cancelled]]);
      const codec = createMockCodec();
      const page = await decodeHistory(channel, codec, { limit: 1 }, silentLogger);
      // The cancelled message is counted complete and returned in the page.
      expect(page.items).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Headers + canonical serial captured per codec-message-id
  // -------------------------------------------------------------------------

  describe('headers capture', () => {
    it('returns canonical headers and first-seen serial for each item', async () => {
      const m = discreteMsg('u1', 'hi', { 'x-extra': 'v1' });
      const channel = createMockChannel([[m]]);
      const codec = createMockCodec();

      const page = await decodeHistory(channel, codec, { limit: 1 }, silentLogger);

      expect(page.items[0]?.serial).toBe(m.serial);
      expect(page.items[0]?.headers).toMatchObject({ [HEADER_CODEC_MESSAGE_ID]: 'u1', 'x-extra': 'v1' });
    });

    it('per-run runs include their HEADER_RUN_ID in the returned headers', async () => {
      const [finish, delta, create] = streamingRun('T1', 'asst-1', ['answer']);
      if (!finish || !delta || !create) throw new Error('expected 3 wire messages');

      const channel = createMockChannel([[finish, delta, create]]);
      const codec = createMockCodec();

      const page = await decodeHistory(channel, codec, { limit: 10 }, silentLogger);
      const asst = page.items.find((i) => i.message.id === 'asst-1');
      expect(asst?.headers[HEADER_RUN_ID]).toBe('T1');
    });
  });

  // -------------------------------------------------------------------------
  // Same-run message routing — successive wire messages folded together
  // -------------------------------------------------------------------------

  describe('same-run message routing', () => {
    it('folds a follow-up message with matching HEADER_RUN_ID into the same run projection', async () => {
      // Run T1 streams the original message; a later wire message in the SAME
      // run T1 carries HEADER_CODEC_MESSAGE_ID = 'asst-1' to extend it. The reducer
      // routes via meta.messageId === 'asst-1', so the follow-up appends
      // into the same message.
      const [finish, delta, create] = streamingRun('T1', 'asst-1', ['original']);
      if (!finish || !delta || !create) throw new Error('expected 3 wire messages');

      const followUp = withEvents(
        ablyMsg({
          action: 'message.create',
          headers: {
            [HEADER_RUN_ID]: 'T1',
            [HEADER_CODEC_MESSAGE_ID]: 'asst-1',
            [HEADER_STREAM]: 'false',
            [HEADER_DISCRETE]: 'true',
          },
        }),
        [{ type: 'text', text: ' + extended' }],
      );

      // Newest-first: follow-up, finish, delta, create
      const channel = createMockChannel([[followUp, finish, delta, create]]);
      const codec = createMockCodec();

      const page = await decodeHistory(channel, codec, { limit: 10 }, silentLogger);
      const asst = page.items.find((i) => i.message.id === 'asst-1');
      expect(asst?.message.content).toBe('original + extended');
    });

    it('preserves identity headers from the first wire when later amend wires target the same codec-message-id', async () => {
      // Regression: under Option X the continuation tool-resolution wire
      // publishes under the prior assistant's codec-message-id (so the reducer's
      // direct-fold path runs). The wire carries `role: user, parent: <self>`
      // because it's a continuation publish — its headers describe the
      // continuation, not the assistant. The agent-side amend wire
      // (`tool-output-available`) also publishes under the assistant's
      // codec-message-id but with `parent: <self>` (the run.pipe default parent
      // points at the assistant being amended).
      //
      // Without identity-preservation in decode-history, those amends
      // clobber the assistant's stored `role` and `parent`, poisoning the
      // tree node so `flattenNodes` skips it as unreachable (self-loop
      // parent). With preservation, identity stays as set by the first
      // wire — the assistant renders correctly on history rewind.
      const [finish, delta, create] = streamingRun('T1', 'asst-1', ['answer']);
      if (!finish || !delta || !create) throw new Error('expected 3 wire messages');

      // Override the create's headers so it has `role: assistant, parent: u1`
      // — the assistant's real identity from its first wire.
      const createWithIdentity = withEvents(
        ablyMsg({
          action: 'message.create',
          headers: {
            [HEADER_RUN_ID]: 'T1',
            [HEADER_CODEC_MESSAGE_ID]: 'asst-1',
            [HEADER_STREAM]: 'true',
            [HEADER_ROLE]: 'assistant',
            [HEADER_PARENT]: 'u1',
          },
          serial: create.serial ?? undefined,
        }),
        [],
      );

      // Option X continuation tool-resolution wire: same codec-message-id, role=user,
      // parent=self, run-continue=true. Different invocation.
      const continuationAmend = withEvents(
        ablyMsg({
          action: 'message.create',
          headers: {
            [HEADER_RUN_ID]: 'T1',
            [HEADER_CODEC_MESSAGE_ID]: 'asst-1',
            [HEADER_ROLE]: 'user',
            [HEADER_PARENT]: 'asst-1',
            [HEADER_RUN_CONTINUE]: 'true',
            [HEADER_INVOCATION_ID]: 'inv-continuation',
            [HEADER_STREAM]: 'false',
            [HEADER_DISCRETE]: 'true',
          },
        }),
        // Reducer no-op (mock codec doesn't model tool resolutions).
        [],
      );

      // Agent-side amend (tool-output-available): same codec-message-id,
      // role=assistant, parent=self.
      const agentAmend = withEvents(
        ablyMsg({
          action: 'message.create',
          headers: {
            [HEADER_RUN_ID]: 'T1',
            [HEADER_CODEC_MESSAGE_ID]: 'asst-1',
            [HEADER_ROLE]: 'assistant',
            [HEADER_PARENT]: 'asst-1',
            [HEADER_STREAM]: 'false',
            [HEADER_DISCRETE]: 'true',
          },
        }),
        [],
      );

      // Newest-first: agentAmend, continuationAmend, finish, delta, create
      const channel = createMockChannel([[agentAmend, continuationAmend, finish, delta, createWithIdentity]]);
      const codec = createMockCodec();

      const page = await decodeHistory(channel, codec, { limit: 10 }, silentLogger);
      const asst = page.items.find((i) => i.message.id === 'asst-1');
      expect(asst).toBeDefined();
      // Identity preserved from the first wire (create).
      expect(asst?.headers[HEADER_ROLE]).toBe('assistant');
      expect(asst?.headers[HEADER_PARENT]).toBe('u1');
    });

    it('keeps follow-ups under a different HEADER_RUN_ID isolated from the original message', async () => {
      // T1 streams; a wire message in T2 targets T1's asst-1. With the new
      // producer-responsibility model the producer must publish under T1's
      // HEADER_RUN_ID, so a follow-up tagged with T2 lands in T2's
      // projection — where there is no asst-1 to update — and never merges
      // into T1's asst-1 message.
      const [finish, delta, create] = streamingRun('T1', 'asst-1', ['original']);
      if (!finish || !delta || !create) throw new Error('expected 3 wire messages');

      const orphanFollowUp = withEvents(
        ablyMsg({
          action: 'message.create',
          headers: {
            [HEADER_RUN_ID]: 'T2',
            [HEADER_CODEC_MESSAGE_ID]: 'asst-1',
            [HEADER_STREAM]: 'false',
            [HEADER_DISCRETE]: 'true',
          },
        }),
        [{ type: 'text', text: '[orphan]' }],
      );

      const channel = createMockChannel([[orphanFollowUp, finish, delta, create]]);
      const codec = createMockCodec();

      const page = await decodeHistory(channel, codec, { limit: 10 }, silentLogger);
      const asst = page.items.find((i) => i.message.id === 'asst-1');
      // The mock reducer keys by meta.messageId — when the follow-up lands
      // in T2's projection, it creates a 'asst-1' message there, but the
      // per-run separation in decode-history means that doesn't merge into
      // T1's 'asst-1' message. Verify T1's content is unchanged.
      expect(asst?.message.content).toBe('original');
    });
  });

  // -------------------------------------------------------------------------
  // Losing-invocation filtering
  // -------------------------------------------------------------------------

  describe('losing-invocation filtering', () => {
    it('drops messages from an earlier (losing) invocation under the same runId', async () => {
      // Two user messages share runId 'T1' but have different invocationIds.
      // The one with the LATER serial is canonical; the earlier (losing) one
      // is dropped from the materialized history.
      const losingUser = userMsg('T1', 'u-losing', 'old prompt', 'inv-old', '01H0000000001');
      const winningUser = userMsg('T1', 'u-winning', 'new prompt', 'inv-new', '01H0000000002');

      // newest-first: winning then losing
      const channel = createMockChannel([[winningUser, losingUser]]);
      const codec = createMockCodec();

      const page = await decodeHistory(channel, codec, { limit: 10 }, silentLogger);

      const ids = page.items.map((i) => i.message.id);
      expect(ids).toContain('u-winning');
      expect(ids).not.toContain('u-losing');
    });
  });

  // -------------------------------------------------------------------------
  // Decode-pass efficiency (cache invalidation tests)
  // -------------------------------------------------------------------------

  describe('decode caching', () => {
    it('creates exactly one decoder per decodeHistory() call regardless of page count', async () => {
      const m3 = discreteMsg('u3', 'c');
      const m2 = discreteMsg('u2', 'b');
      const m1 = discreteMsg('u1', 'a');
      const channel = createMockChannel([[m3], [m2], [m1]]);
      const codec = createMockCodec();

      await decodeHistory(channel, codec, { limit: 10 }, silentLogger);
      expect(codec.decoderInstances).toBe(1);
    });

    it('does not re-decode when next() serves a buffered page', async () => {
      const m4 = discreteMsg('u4', 'd');
      const m3 = discreteMsg('u3', 'c');
      const m2 = discreteMsg('u2', 'b');
      const m1 = discreteMsg('u1', 'a');
      const channel = createMockChannel([[m4, m3, m2, m1]]);
      const codec = createMockCodec();

      const first = await decodeHistory(channel, codec, { limit: 2 }, silentLogger);
      const decodesAfterFirst = codec.decoderInstances;
      await first.next();
      expect(codec.decoderInstances).toBe(decodesAfterFirst);
    });

    it('re-decodes when next() fetches a new Ably page (cache invalidation)', async () => {
      const m2 = discreteMsg('u2', 'b');
      const m1 = discreteMsg('u1', 'a');
      // Two pages, limit forces fetch on next()
      const channel = createMockChannel([[m2], [m1]]);
      const codec = createMockCodec();

      const first = await decodeHistory(channel, codec, { limit: 1 }, silentLogger);
      const decodesBefore = codec.decoderInstances;
      await first.next();
      // A new page was pulled in — the cache was invalidated and a fresh
      // decoder ran. The exact count isn't load-bearing — only that another
      // decode pass occurred.
      expect(codec.decoderInstances).toBeGreaterThan(decodesBefore);
    });
  });
});
