import type * as Ably from 'ably';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HEADER_INVOCATION_ID, HEADER_MSG_ID, HEADER_ROLE, HEADER_RUN_ID } from '../../../src/constants.js';
import type { Codec } from '../../../src/core/codec/types.js';
// Vitest hoists vi.mock above imports, so this static import gets the mock.
import { decodeHistory } from '../../../src/core/transport/decode-history.js';
import type { DefaultTree } from '../../../src/core/transport/tree.js';
import { createTree } from '../../../src/core/transport/tree.js';
import type { HistoryPage, MessageNode, RunLifecycleEvent, SendOptions } from '../../../src/core/transport/types.js';
import type { SendDelegate } from '../../../src/core/transport/view.js';
import { DefaultView } from '../../../src/core/transport/view.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';
vi.mock('../../../src/core/transport/decode-history.js', () => ({
  decodeHistory: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestEvent {
  type: string;
}
interface TestProjection {
  messages: TestMessage[];
}
interface TestMessage {
  id: string;
  content: string;
}

const silentLogger = makeLogger({ logLevel: LogLevel.Silent });

const createMockChannel = (): Ably.RealtimeChannel => {
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  const emptyPage = { items: [], hasNext: () => false, next: () => Promise.resolve(emptyPage) };
  return {
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    history: vi.fn(() => Promise.resolve(emptyPage)),
    // CAST: Tests only call history() — the full RealtimeChannel surface isn't needed.
  } as unknown as Ably.RealtimeChannel;
};

const createMockCodec = (): Codec<TestEvent, TestProjection, TestMessage> => ({
  init: vi.fn(() => ({ messages: [] })),
  fold: vi.fn((state: TestProjection) => state),
  getMessages: vi.fn((state: TestProjection) => state.messages),
  userMessageEvent: vi.fn(() => ({ type: 'user-message' })),
  createEncoder: vi.fn(),
  createDecoder: vi.fn(() => ({ decode: vi.fn(() => []) })),
  isTerminal: vi.fn(() => false),
});

const createMockSendDelegate = (): SendDelegate<TestEvent, TestMessage> =>
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  vi.fn(() =>
    Promise.resolve({
      stream: new ReadableStream(),
      runId: 'mock-run',
      invocationId: 'mock-inv',
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
      cancel: () => Promise.resolve(),
      optimisticMsgIds: [],
    }),
  );

const makeHeaders = (msgId: string, runId?: string): Record<string, string> => {
  const h: Record<string, string> = { [HEADER_MSG_ID]: msgId };
  if (runId) h[HEADER_RUN_ID] = runId;
  return h;
};

const makePage = (
  items: TestMessage[],
  headers: Record<string, string>[],
  serials: string[],
  hasNextPage = false,
  nextPageFn?: () => Promise<HistoryPage<TestMessage> | undefined>,
): HistoryPage<TestMessage> => ({
  items: items.map((message, i) => ({
    message,
    headers: headers[i] ?? {},
    serial: serials[i] ?? '',
  })),
  rawMessages: [],
  hasNext: () => hasNextPage,
  // eslint-disable-next-line @typescript-eslint/promise-function-async, unicorn/no-useless-undefined -- mock needs explicit undefined for HistoryPage return type
  next: nextPageFn ?? (() => Promise.resolve(undefined)),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DefaultView', () => {
  let tree: DefaultTree<TestMessage>;
  let view: DefaultView<TestEvent, TestProjection, TestMessage>;

  beforeEach(() => {
    vi.mocked(decodeHistory).mockReset();
    tree = createTree<TestMessage>(silentLogger);
    view = new DefaultView({
      tree,
      channel: createMockChannel(),
      codec: createMockCodec(),
      sendDelegate: createMockSendDelegate(),

      logger: silentLogger,
    });
  });

  // -------------------------------------------------------------------------
  // getMessages (convenience)
  // -------------------------------------------------------------------------

  describe('getMessages', () => {
    it('returns domain messages matching flattenNodes', () => {
      tree.upsert('m1', { id: '1', content: 'hi' }, makeHeaders('m1'));
      tree.upsert('m2', { id: '2', content: 'hello' }, makeHeaders('m2'));

      const messages = view.getMessages();
      expect(messages).toEqual([
        { id: '1', content: 'hi' },
        { id: '2', content: 'hello' },
      ]);
      expect(messages).toEqual(view.flattenNodes().map((n) => n.message));
    });

    it('returns empty array when tree is empty', () => {
      expect(view.getMessages()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // flattenNodes (windowed projection)
  // -------------------------------------------------------------------------

  describe('flattenNodes', () => {
    it('returns all tree nodes when nothing is withheld', () => {
      tree.upsert('m1', { id: '1', content: 'hi' }, makeHeaders('m1'));
      tree.upsert('m2', { id: '2', content: 'hello' }, makeHeaders('m2'));

      const nodes = view.flattenNodes();
      expect(nodes).toHaveLength(2);
      expect(nodes[0]?.msgId).toBe('m1');
      expect(nodes[1]?.msgId).toBe('m2');
    });

    it('delegates to tree when nothing is withheld', () => {
      tree.upsert('m1', { id: '1', content: 'hi' }, makeHeaders('m1'));
      expect(view.flattenNodes()).toStrictEqual(tree.flattenNodes(new Map<string, string>()));
    });
  });

  // -------------------------------------------------------------------------
  // update event scoping
  // -------------------------------------------------------------------------

  describe('update events', () => {
    it('emits update when a new node is inserted into the tree', () => {
      const handler = vi.fn();
      view.on('update', handler);

      tree.upsert('m1', { id: '1', content: 'hi' }, makeHeaders('m1'));

      expect(handler).toHaveBeenCalledOnce();
    });

    it('emits update when visible message content changes in place (streaming)', () => {
      tree.upsert('m1', { id: '1', content: 'hi' }, makeHeaders('m1'), 'serial-1');

      const handler = vi.fn();
      view.on('update', handler);

      // Update m1's content — the msgId list hasn't changed, but the
      // message reference differs, so the view emits.
      tree.upsert('m1', { id: '1', content: 'updated' }, makeHeaders('m1'), 'serial-1');

      expect(handler).toHaveBeenCalledOnce();
    });

    it('does not emit update when change is on a non-visible branch', () => {
      tree.upsert('m1', { id: '1', content: 'hi' }, makeHeaders('m1'), 'serial-1');
      tree.upsert(
        'm2',
        { id: '2', content: 'fork' },
        {
          [HEADER_MSG_ID]: 'm2',
          'x-ably-fork-of': 'm1',
        },
        'serial-2',
      );

      // m1 is pinned (was visible when m2 forked). Select m1 explicitly.
      view.select('m1', 0);

      const handler = vi.fn();
      view.on('update', handler);

      // Update m2's content — m2 is on a non-visible branch,
      // so the view should not emit.
      tree.upsert(
        'm2',
        { id: '2', content: 'updated fork' },
        {
          [HEADER_MSG_ID]: 'm2',
          'x-ably-fork-of': 'm1',
        },
        'serial-2',
      );

      expect(handler).not.toHaveBeenCalled();
    });

    it('emits update on branch selection change', () => {
      tree.upsert('m1', { id: '1', content: 'original' }, makeHeaders('m1'), 'serial-1');
      tree.upsert(
        'm2',
        { id: '2', content: 'fork' },
        {
          [HEADER_MSG_ID]: 'm2',
          'x-ably-fork-of': 'm1',
        },
        'serial-2',
      );

      const handler = vi.fn();
      view.on('update', handler);

      view.select('m1', 0);
      expect(handler).toHaveBeenCalledOnce();
    });

    it('unsubscribe stops delivery', () => {
      const handler = vi.fn();
      const unsub = view.on('update', handler);
      unsub();

      tree.upsert('m1', { id: '1', content: 'hi' }, makeHeaders('m1'));
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // ably-message event scoping
  // -------------------------------------------------------------------------

  describe('ably-message events', () => {
    it('forwards ably-message for visible nodes', () => {
      tree.upsert('m1', { id: '1', content: 'hi' }, makeHeaders('m1'));

      const handler = vi.fn();
      view.on('ably-message', handler);

      const msg = { extras: { headers: { [HEADER_MSG_ID]: 'm1' } } } as unknown as Ably.InboundMessage;
      tree.emitAblyMessage(msg);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(msg);
    });

    it('does not forward ably-message for nodes on non-selected branches', () => {
      tree.upsert('m1', { id: '1', content: 'user' }, makeHeaders('m1'), 'serial-1');
      tree.upsert(
        'm2',
        { id: '2', content: 'v1' },
        {
          [HEADER_MSG_ID]: 'm2',
          'x-ably-parent': 'm1',
        },
        'serial-2',
      );
      // Fork m2 — view pins to m2
      tree.upsert(
        'm3',
        { id: '3', content: 'v2' },
        {
          [HEADER_MSG_ID]: 'm3',
          'x-ably-parent': 'm1',
          'x-ably-fork-of': 'm2',
        },
        'serial-3',
      );

      const handler = vi.fn();
      view.on('ably-message', handler);

      // Message for m3 (off-branch) should NOT be forwarded
      const msg = { extras: { headers: { [HEADER_MSG_ID]: 'm3' } } } as unknown as Ably.InboundMessage;
      tree.emitAblyMessage(msg);

      expect(handler).not.toHaveBeenCalled();
    });

    it('forwards ably-message without msg-id (run events)', () => {
      const handler = vi.fn();
      view.on('ably-message', handler);

      const msg = { extras: { headers: {} } } as unknown as Ably.InboundMessage;
      tree.emitAblyMessage(msg);

      expect(handler).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // run event scoping
  // -------------------------------------------------------------------------

  describe('run events', () => {
    it('forwards run events for runs with visible messages', () => {
      tree.upsert('m1', { id: '1', content: 'hi' }, makeHeaders('m1', 'run-1'));
      tree.trackRun('run-1', 'client-a');

      const handler = vi.fn();
      view.on('run', handler);

      const event: RunLifecycleEvent = { type: 'x-ably-run-start', runId: 'run-1', clientId: 'client-a' };
      tree.emitRun(event);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(event);
    });

    it('forwards run-start when no metadata is present (backward compat)', () => {
      tree.trackRun('run-99', 'client-x');

      const handler = vi.fn();
      view.on('run', handler);

      const event: RunLifecycleEvent = { type: 'x-ably-run-start', runId: 'run-99', clientId: 'client-x' };
      tree.emitRun(event);

      expect(handler).toHaveBeenCalledOnce();
    });

    it('forwards run-start when parent is on the visible branch', () => {
      tree.upsert('m1', { id: '1', content: 'hi' }, makeHeaders('m1'), 'serial-1');

      const handler = vi.fn();
      view.on('run', handler);

      const event: RunLifecycleEvent = {
        type: 'x-ably-run-start',
        runId: 'run-2',
        clientId: 'client-b',
        parent: 'm1',
      };
      tree.emitRun(event);

      expect(handler).toHaveBeenCalledOnce();
    });

    it('does not forward run-start when parent is on a non-visible branch', () => {
      // Create a fork: m2 and m3 are siblings under m1
      tree.upsert('m1', { id: '1', content: 'user' }, makeHeaders('m1'), 'serial-1');
      tree.upsert(
        'm2',
        { id: '2', content: 'v1' },
        {
          [HEADER_MSG_ID]: 'm2',
          'x-ably-parent': 'm1',
        },
        'serial-2',
      );
      tree.upsert(
        'm3',
        { id: '3', content: 'v2' },
        {
          [HEADER_MSG_ID]: 'm3',
          'x-ably-parent': 'm1',
          'x-ably-fork-of': 'm2',
        },
        'serial-3',
      );

      // Select m2 (index 0), so m3 and its descendants are not visible
      view.select('m2', 0);

      const handler = vi.fn();
      view.on('run', handler);

      // Run whose parent is m3 (on the non-selected branch)
      const event: RunLifecycleEvent = {
        type: 'x-ably-run-start',
        runId: 'run-hidden',
        clientId: 'remote',
        parent: 'm3',
      };
      tree.emitRun(event);

      expect(handler).not.toHaveBeenCalled();
    });

    it('forwards run-start for root run (no parent)', () => {
      const handler = vi.fn();
      view.on('run', handler);

      const event: RunLifecycleEvent = {
        type: 'x-ably-run-start',
        runId: 'run-root',
        clientId: 'client-a',
      };
      tree.emitRun(event);

      expect(handler).toHaveBeenCalledOnce();
    });

    it('does not forward run-end for runs without visible messages', () => {
      tree.trackRun('run-99', 'client-x');

      const handler = vi.fn();
      view.on('run', handler);

      const event: RunLifecycleEvent = {
        type: 'x-ably-run-end',
        runId: 'run-99',
        clientId: 'client-x',
        reason: 'complete',
      };
      tree.emitRun(event);

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // getActiveRunIds (scoped)
  // -------------------------------------------------------------------------

  describe('getActiveRunIds', () => {
    it('returns all runs when nothing is withheld and all have visible messages', () => {
      tree.upsert('m1', { id: '1', content: 'hi' }, makeHeaders('m1', 'run-1'));
      tree.upsert('m2', { id: '2', content: 'hi' }, makeHeaders('m2', 'run-2'));
      tree.trackRun('run-1', 'client-a');
      tree.trackRun('run-2', 'client-a');

      const active = view.getActiveRunIds();
      expect(active.get('client-a')).toEqual(new Set(['run-1', 'run-2']));
    });
  });

  // -------------------------------------------------------------------------
  // hasOlder / loadOlder
  // -------------------------------------------------------------------------

  describe('hasOlder', () => {
    it('returns false initially', () => {
      expect(view.hasOlder()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // loadOlder
  // -------------------------------------------------------------------------

  describe('loadOlder', () => {
    it('loads first page and reveals messages', async () => {
      const page = makePage(
        [
          { id: '1', content: 'old1' },
          { id: '2', content: 'old2' },
          { id: '3', content: 'old3' },
        ],
        [makeHeaders('h1'), makeHeaders('h2'), makeHeaders('h3')],
        ['serial-1', 'serial-2', 'serial-3'],
      );
      vi.mocked(decodeHistory).mockResolvedValue(page);

      await view.loadOlder(10);

      const nodes = view.flattenNodes();
      expect(nodes).toHaveLength(3);
      expect(nodes[0]?.msgId).toBe('h1');
      expect(view.hasOlder()).toBe(false);
    });

    it('withholds excess messages and reveals on subsequent calls', async () => {
      const page = makePage(
        [
          { id: '1', content: 'a' },
          { id: '2', content: 'b' },
          { id: '3', content: 'c' },
          { id: '4', content: 'd' },
          { id: '5', content: 'e' },
        ],
        [makeHeaders('h1'), makeHeaders('h2'), makeHeaders('h3'), makeHeaders('h4'), makeHeaders('h5')],
        ['serial-1', 'serial-2', 'serial-3', 'serial-4', 'serial-5'],
      );
      vi.mocked(decodeHistory).mockResolvedValue(page);

      // Load with limit 2 — reveals newest 2, withholds 3
      await view.loadOlder(2);

      expect(view.flattenNodes()).toHaveLength(2);
      expect(view.hasOlder()).toBe(true);

      // Second call reveals from withheld buffer
      await view.loadOlder(2);

      expect(view.flattenNodes()).toHaveLength(4);
      expect(view.hasOlder()).toBe(true);
      // decodeHistory should only be called once (buffer drain, no new fetch)
      expect(vi.mocked(decodeHistory)).toHaveBeenCalledOnce();
    });

    it('loads more history when withheld buffer is exhausted', async () => {
      const page2 = makePage(
        [
          { id: '10', content: 'oldest' },
          { id: '11', content: 'older' },
        ],
        [makeHeaders('h10'), makeHeaders('h11')],
        ['serial-10', 'serial-11'],
      );

      const page1 = makePage(
        [
          { id: '1', content: 'a' },
          { id: '2', content: 'b' },
          { id: '3', content: 'c' },
        ],
        [makeHeaders('h1'), makeHeaders('h2'), makeHeaders('h3')],
        ['serial-1', 'serial-2', 'serial-3'],
        true,
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise directly
        () => Promise.resolve(page2),
      );
      vi.mocked(decodeHistory).mockResolvedValue(page1);

      // First load with limit 2 — page1 has 3 items, reveals 2, withholds 1
      await view.loadOlder(2);
      expect(view.flattenNodes()).toHaveLength(2);
      expect(view.hasOlder()).toBe(true);

      // Second load — drains withheld buffer (1 item)
      await view.loadOlder(2);
      expect(view.flattenNodes()).toHaveLength(3);

      // Third load — buffer empty, fetches next page from page1.next()
      await view.loadOlder(10);
      expect(view.flattenNodes()).toHaveLength(5);
    });

    it('ignores concurrent loadOlder calls', async () => {
      let resolveFirst: ((page: HistoryPage<TestMessage>) => void) | undefined;
      const firstPromise = new Promise<HistoryPage<TestMessage>>((r) => {
        resolveFirst = r;
      });
      vi.mocked(decodeHistory).mockReturnValue(firstPromise);

      const page = makePage(
        [
          { id: '1', content: 'a' },
          { id: '2', content: 'b' },
        ],
        [makeHeaders('h1'), makeHeaders('h2')],
        ['serial-1', 'serial-2'],
      );

      // Start two concurrent loadOlder calls
      const first = view.loadOlder(10);
      const second = view.loadOlder(10);

      // Resolve the first — the second should have been a no-op
      if (resolveFirst) resolveFirst(page);
      await first;
      await second;

      // decodeHistory should only be called once
      expect(vi.mocked(decodeHistory)).toHaveBeenCalledOnce();
      expect(view.flattenNodes()).toHaveLength(2);
    });

    it('suppresses ably-message events for withheld nodes', async () => {
      const page = makePage(
        [
          { id: '1', content: 'a' },
          { id: '2', content: 'b' },
          { id: '3', content: 'c' },
        ],
        [makeHeaders('h1'), makeHeaders('h2'), makeHeaders('h3')],
        ['serial-1', 'serial-2', 'serial-3'],
      );
      vi.mocked(decodeHistory).mockResolvedValue(page);

      // Reveal only 1, withhold 2
      await view.loadOlder(1);

      const handler = vi.fn();
      view.on('ably-message', handler);

      // Emit for a withheld node — should be suppressed
      const withheldMsg = { extras: { headers: { [HEADER_MSG_ID]: 'h1' } } } as unknown as Ably.InboundMessage;
      tree.emitAblyMessage(withheldMsg);
      expect(handler).not.toHaveBeenCalled();

      // Emit for a visible node — should be forwarded
      const visibleMsg = { extras: { headers: { [HEADER_MSG_ID]: 'h3' } } } as unknown as Ably.InboundMessage;
      tree.emitAblyMessage(visibleMsg);
      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(visibleMsg);
    });
  });

  // -------------------------------------------------------------------------
  // Branch navigation (view-local selections)
  // -------------------------------------------------------------------------

  describe('branch navigation', () => {
    beforeEach(() => {
      tree.upsert('m1', { id: '1', content: 'user' }, makeHeaders('m1'), 'serial-1');
      tree.upsert(
        'm2',
        { id: '2', content: 'v1' },
        {
          [HEADER_MSG_ID]: 'm2',
          'x-ably-parent': 'm1',
        },
        'serial-2',
      );
      tree.upsert(
        'm3',
        { id: '3', content: 'v2' },
        {
          [HEADER_MSG_ID]: 'm3',
          'x-ably-parent': 'm1',
          'x-ably-fork-of': 'm2',
        },
        'serial-3',
      );
    });

    it('select changes which branch flattenNodes follows', () => {
      // Pinned to m2 (was visible when m3 forked it)
      expect(view.flattenNodes().map((n) => n.message.content)).toEqual(['user', 'v1']);

      view.select('m2', 1);
      expect(view.flattenNodes().map((n) => n.message.content)).toEqual(['user', 'v2']);
    });

    it('getSelectedIndex returns view-local selection', () => {
      // Pinned to m2 (index 0) when m3 appeared
      expect(view.getSelectedIndex('m2')).toBe(0);
      view.select('m2', 1);
      expect(view.getSelectedIndex('m2')).toBe(1);
    });

    it('getSelectedIndex returns 0 for non-forked nodes', () => {
      expect(view.getSelectedIndex('m1')).toBe(0);
    });

    it('select clamps out-of-range index', () => {
      view.select('m2', 999);
      expect(view.getSelectedIndex('m2')).toBe(1);

      view.select('m2', -5);
      expect(view.getSelectedIndex('m2')).toBe(0);
    });

    it('select is a no-op for non-forked nodes', () => {
      view.select('m1', 5);
      expect(view.getSelectedIndex('m1')).toBe(0);
    });

    it('getSiblings delegates to tree', () => {
      const siblings = view.getSiblings('m2');
      expect(siblings).toHaveLength(2);
    });

    it('hasSiblings delegates to tree', () => {
      expect(view.hasSiblings('m2')).toBe(true);
      expect(view.hasSiblings('m1')).toBe(false);
    });

    it('getNode delegates to tree', () => {
      expect(view.getNode('m1')?.msgId).toBe('m1');
      expect(view.getNode('unknown')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Multi-view
  // -------------------------------------------------------------------------

  describe('multi-view', () => {
    it('two views over the same tree have independent selections', () => {
      tree.upsert('m1', { id: '1', content: 'user' }, makeHeaders('m1'), 'serial-1');
      tree.upsert(
        'm2',
        { id: '2', content: 'v1' },
        {
          [HEADER_MSG_ID]: 'm2',
          'x-ably-parent': 'm1',
        },
        'serial-2',
      );
      tree.upsert(
        'm3',
        { id: '3', content: 'v2' },
        {
          [HEADER_MSG_ID]: 'm3',
          'x-ably-parent': 'm1',
          'x-ably-fork-of': 'm2',
        },
        'serial-3',
      );

      const view2 = new DefaultView<TestEvent, TestProjection, TestMessage>({
        tree,
        channel: createMockChannel(),
        codec: createMockCodec(),
        sendDelegate: createMockSendDelegate(),
        logger: silentLogger,
      });

      // view pinned to m2 (was visible when m3 forked); view2 created after fork, defaults to latest (m3)
      expect(view.flattenNodes().map((n) => n.message.content)).toEqual(['user', 'v1']);
      expect(view2.flattenNodes().map((n) => n.message.content)).toEqual(['user', 'v2']);

      // Select different branches — view navigates to m3, view2 navigates to m2
      view.select('m2', 1);
      expect(view.flattenNodes().map((n) => n.message.content)).toEqual(['user', 'v2']);
      expect(view2.flattenNodes().map((n) => n.message.content)).toEqual(['user', 'v2']);

      view2.select('m2', 0);
      expect(view2.flattenNodes().map((n) => n.message.content)).toEqual(['user', 'v1']);

      view2.close();
    });

    it('tree mutation propagates to both views', () => {
      tree.upsert('m1', { id: '1', content: 'hi' }, makeHeaders('m1'));

      const view2 = new DefaultView<TestEvent, TestProjection, TestMessage>({
        tree,
        channel: createMockChannel(),
        codec: createMockCodec(),
        sendDelegate: createMockSendDelegate(),
        logger: silentLogger,
      });

      const handler1 = vi.fn();
      const handler2 = vi.fn();
      view.on('update', handler1);
      view2.on('update', handler2);

      tree.upsert('m2', { id: '2', content: 'hello' }, { [HEADER_MSG_ID]: 'm2', 'x-ably-parent': 'm1' });

      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).toHaveBeenCalledOnce();

      view2.close();
    });

    it('fork from one view does not shift the other view', () => {
      tree.upsert('m1', { id: '1', content: 'user' }, makeHeaders('m1'), 'serial-1');
      tree.upsert(
        'm2',
        { id: '2', content: 'asst' },
        {
          [HEADER_MSG_ID]: 'm2',
          'x-ably-parent': 'm1',
        },
        'serial-2',
      );

      const view2 = new DefaultView<TestEvent, TestProjection, TestMessage>({
        tree,
        channel: createMockChannel(),
        codec: createMockCodec(),
        sendDelegate: createMockSendDelegate(),
        logger: silentLogger,
      });

      // Both show [m1, m2]
      expect(view.flattenNodes().map((n) => n.msgId)).toEqual(['m1', 'm2']);
      expect(view2.flattenNodes().map((n) => n.msgId)).toEqual(['m1', 'm2']);

      // Fork m2 — simulates an edit/regenerate from view2
      tree.upsert(
        'm3',
        { id: '3', content: 'fork' },
        {
          [HEADER_MSG_ID]: 'm3',
          'x-ably-parent': 'm1',
          'x-ably-fork-of': 'm2',
        },
        'serial-3',
      );

      // view stays on m2 (pinned), view2 also pinned to m2
      expect(view.flattenNodes().map((n) => n.msgId)).toEqual(['m1', 'm2']);
      expect(view2.flattenNodes().map((n) => n.msgId)).toEqual(['m1', 'm2']);

      // view2 navigates to the fork
      view2.select('m2', 1);
      expect(view2.flattenNodes().map((n) => n.msgId)).toEqual(['m1', 'm3']);
      // view unaffected
      expect(view.flattenNodes().map((n) => n.msgId)).toEqual(['m1', 'm2']);

      view2.close();
    });

    it('send with forkOf auto-selects new fork in calling view', async () => {
      // Create a delegate that inserts a fork when called (simulates optimistic insert)
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
      const forkDelegate: SendDelegate<TestEvent, TestMessage> = vi.fn(() => {
        tree.upsert(
          'm3',
          { id: '3', content: 'fork' },
          {
            [HEADER_MSG_ID]: 'm3',
            'x-ably-parent': 'm1',
            'x-ably-fork-of': 'm2',
          },
          'serial-3',
        );
        return Promise.resolve({
          stream: new ReadableStream(),
          runId: 'run-1',
          invocationId: 'inv-1',
          cancel: vi.fn(),
          optimisticMsgIds: ['m3'],
        });
      });

      const forkView = new DefaultView<TestEvent, TestProjection, TestMessage>({
        tree,
        channel: createMockChannel(),
        codec: createMockCodec(),
        sendDelegate: forkDelegate,
        logger: silentLogger,
      });

      tree.upsert('m1', { id: '1', content: 'user' }, makeHeaders('m1'), 'serial-1');
      tree.upsert(
        'm2',
        { id: '2', content: 'asst' },
        {
          [HEADER_MSG_ID]: 'm2',
          'x-ably-parent': 'm1',
        },
        'serial-2',
      );

      await forkView.send([], { forkOf: 'm2', parent: 'm1' });

      // forkView auto-selected the new fork (m3, latest sibling)
      expect(forkView.flattenNodes().map((n) => n.msgId)).toEqual(['m1', 'm3']);

      forkView.close();
    });

    it('send with forkOf defers auto-select when no optimistic sibling exists (regenerate)', async () => {
      // Delegate does NOT insert any sibling — simulates regenerate where
      // the server creates the fork later.
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
      const noopDelegate: SendDelegate<TestEvent, TestMessage> = vi.fn(() =>
        Promise.resolve({
          stream: new ReadableStream(),
          runId: 'run-1',
          invocationId: 'inv-1',
          cancel: vi.fn(),
          optimisticMsgIds: [],
        }),
      );

      const forkView = new DefaultView<TestEvent, TestProjection, TestMessage>({
        tree,
        channel: createMockChannel(),
        codec: createMockCodec(),
        sendDelegate: noopDelegate,
        logger: silentLogger,
      });

      tree.upsert('m1', { id: '1', content: 'user' }, makeHeaders('m1'), 'serial-1');
      tree.upsert(
        'm2',
        { id: '2', content: 'asst' },
        {
          [HEADER_MSG_ID]: 'm2',
          'x-ably-parent': 'm1',
        },
        'serial-2',
      );

      // Regenerate: send with forkOf but no optimistic insert
      await forkView.send([], { forkOf: 'm2', parent: 'm1' });

      // Still on original branch — no sibling yet
      expect(forkView.flattenNodes().map((n) => n.msgId)).toEqual(['m1', 'm2']);

      const handler = vi.fn();
      forkView.on('update', handler);

      // Server response arrives, creating the fork (stamped with the pending run's ID)
      tree.upsert(
        'm3',
        { id: '3', content: 'regenerated' },
        {
          [HEADER_MSG_ID]: 'm3',
          'x-ably-parent': 'm1',
          'x-ably-fork-of': 'm2',
          'x-ably-run-id': 'run-1',
        },
        'serial-3',
      );

      // forkView auto-selected the new fork (m3, latest sibling)
      expect(forkView.flattenNodes().map((n) => n.msgId)).toEqual(['m1', 'm3']);
      expect(handler).toHaveBeenCalled();

      // Pending state was consumed — a second fork from a different run doesn't force re-selection
      handler.mockClear();
      tree.upsert(
        'm4',
        { id: '4', content: 'another fork' },
        {
          [HEADER_MSG_ID]: 'm4',
          'x-ably-parent': 'm1',
          'x-ably-fork-of': 'm2',
          'x-ably-run-id': 'run-other',
        },
        'serial-4',
      );

      // View stays pinned on m3, does not jump to m4
      expect(forkView.flattenNodes().map((n) => n.msgId)).toEqual(['m1', 'm3']);

      forkView.close();
    });

    it('send with forkOf defers auto-select even when siblings already exist', async () => {
      // Regression: when forkOf already has siblings (e.g. regenerating for the 2nd+ time),
      // siblings.length > 1 before the delegate, but no NEW sibling was optimistically
      // inserted. The view must still defer selection until the server response arrives.
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
      const noopDelegate: SendDelegate<TestEvent, TestMessage> = vi.fn(() =>
        Promise.resolve({
          stream: new ReadableStream(),
          runId: 'run-1',
          invocationId: 'inv-1',
          cancel: vi.fn(),
          optimisticMsgIds: [],
        }),
      );

      const forkView = new DefaultView<TestEvent, TestProjection, TestMessage>({
        tree,
        channel: createMockChannel(),
        codec: createMockCodec(),
        sendDelegate: noopDelegate,
        logger: silentLogger,
      });

      // Set up: m1 → m2 (original) and m3 (first regeneration, already a sibling of m2)
      tree.upsert('m1', { id: '1', content: 'user' }, makeHeaders('m1'), 'serial-1');
      tree.upsert(
        'm2',
        { id: '2', content: 'asst v1' },
        {
          [HEADER_MSG_ID]: 'm2',
          'x-ably-parent': 'm1',
        },
        'serial-2',
      );
      tree.upsert(
        'm3',
        { id: '3', content: 'asst v2' },
        {
          [HEADER_MSG_ID]: 'm3',
          'x-ably-parent': 'm1',
          'x-ably-fork-of': 'm2',
        },
        'serial-3',
      );

      // View is showing m3 (latest sibling, index 1)
      forkView.select('m2', 1);
      expect(forkView.flattenNodes().map((n) => n.msgId)).toEqual(['m1', 'm3']);

      // Regenerate again: forkOf m2, no optimistic insert
      await forkView.send([], { forkOf: 'm2', parent: 'm1' });

      // Still showing m3 — no new sibling yet
      expect(forkView.flattenNodes().map((n) => n.msgId)).toEqual(['m1', 'm3']);

      // Server response arrives, creating a third sibling (stamped with the pending run's ID)
      tree.upsert(
        'm4',
        { id: '4', content: 'asst v3' },
        {
          [HEADER_MSG_ID]: 'm4',
          'x-ably-parent': 'm1',
          'x-ably-fork-of': 'm2',
          'x-ably-run-id': 'run-1',
        },
        'serial-4',
      );

      // forkView auto-selected the newest sibling (m4, index 2)
      expect(forkView.flattenNodes().map((n) => n.msgId)).toEqual(['m1', 'm4']);

      forkView.close();
    });

    it('regenerate on a non-root sibling defers auto-select correctly', async () => {
      // Regression: regenerating while viewing a non-root sibling (e.g. m3 with
      // forkOf m2) must store the group root in _branchSelections so that
      // _pinVisibleSelections can match it via groupRoot.
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
      const noopDelegate: SendDelegate<TestEvent, TestMessage> = vi.fn(() =>
        Promise.resolve({
          stream: new ReadableStream(),
          runId: 'run-1',
          invocationId: 'inv-1',
          cancel: vi.fn(),
          optimisticMsgIds: [],
        }),
      );

      const forkView = new DefaultView<TestEvent, TestProjection, TestMessage>({
        tree,
        channel: createMockChannel(),
        codec: createMockCodec(),
        sendDelegate: noopDelegate,
        logger: silentLogger,
      });

      tree.upsert('m1', { id: '1', content: 'user' }, makeHeaders('m1'), 'serial-1');
      tree.upsert(
        'm2',
        { id: '2', content: 'asst v1' },
        {
          [HEADER_MSG_ID]: 'm2',
          'x-ably-parent': 'm1',
        },
        'serial-2',
      );
      tree.upsert(
        'm3',
        { id: '3', content: 'asst v2' },
        {
          [HEADER_MSG_ID]: 'm3',
          'x-ably-parent': 'm1',
          'x-ably-fork-of': 'm2',
        },
        'serial-3',
      );

      // Navigate to original (m2) then back to m3
      forkView.select('m2', 0);
      forkView.select('m2', 1);
      expect(forkView.flattenNodes().map((n) => n.msgId)).toEqual(['m1', 'm3']);

      // Regenerate while viewing m3 — forkOf is m3, not the group root m2
      await forkView.send([], { forkOf: 'm3', parent: 'm1' });

      // Server response creates a new sibling (forks from m2 via m3's group, stamped with pending run)
      tree.upsert(
        'm4',
        { id: '4', content: 'asst v3' },
        {
          [HEADER_MSG_ID]: 'm4',
          'x-ably-parent': 'm1',
          'x-ably-fork-of': 'm3',
          'x-ably-run-id': 'run-1',
        },
        'serial-4',
      );

      // Auto-selected the newest sibling
      expect(forkView.flattenNodes().map((n) => n.msgId)).toEqual(['m1', 'm4']);

      forkView.close();
    });

    it('pending fork selection is cleaned up on run-end if server never creates sibling', async () => {
      // Regression: pending entries must not leak if the server never creates
      // a fork (e.g. the run ends without producing any messages for this group).
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
      const noopDelegate: SendDelegate<TestEvent, TestMessage> = vi.fn(() =>
        Promise.resolve({
          stream: new ReadableStream(),
          runId: 'run-cleanup',
          invocationId: 'inv-cleanup',
          cancel: vi.fn(),
          optimisticMsgIds: [],
        }),
      );

      const forkView = new DefaultView<TestEvent, TestProjection, TestMessage>({
        tree,
        channel: createMockChannel(),
        codec: createMockCodec(),
        sendDelegate: noopDelegate,
        logger: silentLogger,
      });

      tree.upsert('m1', { id: '1', content: 'user' }, makeHeaders('m1'), 'serial-1');
      tree.upsert(
        'm2',
        { id: '2', content: 'asst' },
        {
          [HEADER_MSG_ID]: 'm2',
          'x-ably-parent': 'm1',
        },
        'serial-2',
      );

      // Regenerate: deferred auto-select (pending)
      await forkView.send([], { forkOf: 'm2', parent: 'm1' });

      // Run ends without creating a sibling — pending entry should be cleaned up
      tree.emitRun({ type: 'x-ably-run-end', runId: 'run-cleanup', clientId: 'client-a', reason: 'complete' });

      // A later unrelated fork should NOT be auto-selected (pending was cleaned up)
      tree.upsert(
        'm3',
        { id: '3', content: 'external fork' },
        {
          [HEADER_MSG_ID]: 'm3',
          'x-ably-parent': 'm1',
          'x-ably-fork-of': 'm2',
        },
        'serial-3',
      );

      // View pins to m2 (external fork), does NOT jump to m3
      expect(forkView.flattenNodes().map((n) => n.msgId)).toEqual(['m1', 'm2']);

      forkView.close();
    });

    it('closing one view does not affect the other', () => {
      tree.upsert('m1', { id: '1', content: 'hi' }, makeHeaders('m1'));

      const view2 = new DefaultView<TestEvent, TestProjection, TestMessage>({
        tree,
        channel: createMockChannel(),
        codec: createMockCodec(),
        sendDelegate: createMockSendDelegate(),
        logger: silentLogger,
      });

      view2.close();

      // view still works
      const handler = vi.fn();
      view.on('update', handler);
      tree.upsert('m2', { id: '2', content: 'hello' }, { [HEADER_MSG_ID]: 'm2', 'x-ably-parent': 'm1' });
      expect(handler).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Write operations (send / regenerate / edit)
  // -------------------------------------------------------------------------

  describe('write operations', () => {
    let mockDelegate: SendDelegate<TestEvent, TestMessage>;

    beforeEach(() => {
      mockDelegate = createMockSendDelegate();
      view = new DefaultView({
        tree,
        channel: createMockChannel(),
        codec: createMockCodec(),
        sendDelegate: mockDelegate,
        logger: silentLogger,
      });
      // Seed a linear chain: m1 -> m2 -> m3
      tree.upsert('m1', { id: '1', content: 'user' }, makeHeaders('m1'), 'serial-1');
      tree.upsert(
        'm2',
        { id: '2', content: 'assistant' },
        {
          [HEADER_MSG_ID]: 'm2',
          'x-ably-parent': 'm1',
        },
        'serial-2',
      );
      tree.upsert(
        'm3',
        { id: '3', content: 'follow-up' },
        {
          [HEADER_MSG_ID]: 'm3',
          'x-ably-parent': 'm2',
        },
        'serial-3',
      );
    });

    it('send passes pre-computed history to delegate', async () => {
      await view.send({ id: '4', content: 'new msg' });
      expect(mockDelegate).toHaveBeenCalledOnce();
      const call = (mockDelegate as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
      const history = call[2] as MessageNode<TestMessage>[];
      expect(history.map((n) => n.msgId)).toEqual(['m1', 'm2', 'm3']);
    });

    it('send forwards options to delegate', async () => {
      await view.send({ id: '4', content: 'msg' }, { parent: 'm1', body: { extra: true } });
      const call = (mockDelegate as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
      expect(call[0]).toEqual({ id: '4', content: 'msg' });
      expect(call[1]).toEqual({ parent: 'm1', body: { extra: true } });
    });

    it('regenerate republishes the parent user message and sets forkOf to the target', async () => {
      await view.regenerate('m2');
      const call = (mockDelegate as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
      const input = call[0] as TestMessage[];
      const options = call[1] as SendOptions;
      const republishMsgId = call[3] as string | undefined;
      // The delegate receives the parent user message (m1) as the message to republish.
      expect(input).toHaveLength(1);
      expect(input[0]?.id).toBe('1');
      expect(republishMsgId).toBe('m1');
      // forkOf still targets the assistant message being regenerated.
      expect(options.forkOf).toBe('m2');
      // parent is m1's tree parentId (m1 is root → undefined).
      expect(options.parent).toBeUndefined();
    });

    it('regenerate passes history truncated before the republished user message', async () => {
      await view.regenerate('m2');
      const call = (mockDelegate as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
      const options = call[1] as { body: { history: MessageNode<TestMessage>[] } };
      // m1 is the republished user message — excluded from history. No
      // earlier messages exist.
      expect(options.body.history).toEqual([]);
    });

    it('edit computes forkOf and parent from target node', async () => {
      await view.edit('m3', { id: 'edited', content: 'revised' });
      const call = (mockDelegate as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
      const options = call[1] as SendOptions;
      expect(call[0]).toEqual({ id: 'edited', content: 'revised' });
      expect(options.forkOf).toBe('m3');
      expect(options.parent).toBe('m2'); // parent of m3
    });

    it('edit passes truncated history (before target)', async () => {
      await view.edit('m3', { id: 'edited', content: 'revised' });
      const call = (mockDelegate as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
      const options = call[1] as { body: { history: MessageNode<TestMessage>[] } };
      expect(options.body.history).toHaveLength(2); // m1 and m2
    });

    it('regenerate throws for unknown messageId', async () => {
      await expect(view.regenerate('nonexistent')).rejects.toThrow('message not found in tree');
    });

    it('edit throws for unknown messageId', async () => {
      await expect(view.edit('nonexistent', { id: 'x', content: 'y' })).rejects.toThrow('message not found in tree');
    });

    it('send uses view-local branch selections for context', async () => {
      // Fork m2
      tree.upsert(
        'm4',
        { id: '4', content: 'v2' },
        {
          [HEADER_MSG_ID]: 'm4',
          'x-ably-parent': 'm1',
          'x-ably-fork-of': 'm2',
        },
        'serial-4',
      );

      // Select original branch (m2, not m4)
      view.select('m2', 0);

      await view.send({ id: '5', content: 'msg' });
      const call = (mockDelegate as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
      const history = call[2] as MessageNode<TestMessage>[];
      // Should follow m1 -> m2 -> m3 (selected branch), not m1 -> m4
      expect(history.map((n) => n.msgId)).toEqual(['m1', 'm2', 'm3']);
    });
  });

  // -------------------------------------------------------------------------
  // close
  // -------------------------------------------------------------------------

  describe('close', () => {
    it('stops forwarding events after close', () => {
      const handler = vi.fn();
      view.on('update', handler);

      view.close();

      tree.upsert('m1', { id: '1', content: 'hi' }, makeHeaders('m1'));
      expect(handler).not.toHaveBeenCalled();
    });

    it('loadOlder is a no-op after close', async () => {
      view.close();
      // Should not throw or load anything
      await view.loadOlder();
      expect(view.flattenNodes()).toEqual([]);
    });

    it('clears selections on close', () => {
      tree.upsert('m1', { id: '1', content: 'user' }, makeHeaders('m1'), 'serial-1');
      tree.upsert(
        'm2',
        { id: '2', content: 'v1' },
        {
          [HEADER_MSG_ID]: 'm2',
          'x-ably-parent': 'm1',
        },
        'serial-2',
      );
      tree.upsert(
        'm3',
        { id: '3', content: 'v2' },
        {
          [HEADER_MSG_ID]: 'm3',
          'x-ably-parent': 'm1',
          'x-ably-fork-of': 'm2',
        },
        'serial-3',
      );

      view.select('m2', 0);
      expect(view.getSelectedIndex('m2')).toBe(0);

      view.close();

      // After close, getSelectedIndex returns default (latest)
      expect(view.getSelectedIndex('m2')).toBe(1);
    });

    it('clears all emitter listeners on close', () => {
      const updateHandler = vi.fn();
      const ablyHandler = vi.fn();
      const runHandler = vi.fn();
      view.on('update', updateHandler);
      view.on('ably-message', ablyHandler);
      view.on('run', runHandler);

      view.close();

      // Trigger tree events — view handlers should not fire
      tree.upsert('m1', { id: '1', content: 'hi' }, makeHeaders('m1', 'run-1'), 'serial-1');
      tree.emitAblyMessage({ name: 'test', extras: { headers: { [HEADER_MSG_ID]: 'm1' } } } as Ably.InboundMessage);
      tree.emitRun({ type: 'x-ably-run-end', runId: 'run-1', clientId: 'c1', reason: 'complete' });

      expect(updateHandler).not.toHaveBeenCalled();
      expect(ablyHandler).not.toHaveBeenCalled();
      expect(runHandler).not.toHaveBeenCalled();
    });

    it('is idempotent — double close does not throw', () => {
      view.close();
      expect(() => {
        view.close();
      }).not.toThrow();
    });

    it('send rejects after close', async () => {
      view.close();
      await expect(view.send({ id: '1', content: 'hi' })).rejects.toThrow('view is closed');
    });

    it('regenerate rejects after close', async () => {
      tree.upsert('m1', { id: '1', content: 'hi' }, makeHeaders('m1'), 'serial-1');
      view.close();
      await expect(view.regenerate('m1')).rejects.toThrow('view is closed');
    });

    it('edit rejects after close', async () => {
      tree.upsert('m1', { id: '1', content: 'hi' }, makeHeaders('m1'), 'serial-1');
      view.close();
      await expect(view.edit('m1', { id: '2', content: 'revised' })).rejects.toThrow('view is closed');
    });
  });

  // -------------------------------------------------------------------------
  // flattenNodes caching and reference stability
  // -------------------------------------------------------------------------

  describe('flattenNodes caching and reference stability', () => {
    it('returns the same array reference on consecutive calls without intervening changes', () => {
      tree.upsert('m1', { id: '1', content: 'hi' }, makeHeaders('m1'), 'serial-1');

      const ref1 = view.flattenNodes();
      const ref2 = view.flattenNodes();

      // flattenNodes() should return a cached result - the same array
      // reference - when nothing has changed between calls.
      expect(ref2).toBe(ref1);
    });

    it('does not re-walk the tree during a content-only message update', () => {
      tree.upsert('m1', { id: '1', content: 'first' }, makeHeaders('m1'), 'serial-1');
      tree.upsert('m2', { id: '2', content: 'second' }, makeHeaders('m2', 'run-1'), 'serial-2');

      // Capture the current cached state so the view has a baseline
      view.flattenNodes();

      const spy = vi.spyOn(tree, 'flattenNodes');
      spy.mockClear();

      // Content-only update: same msgId, different message content, no serial change
      tree.upsert('m2', { id: '2', content: 'streaming token' }, makeHeaders('m2', 'run-1'), 'serial-2');

      // The view should detect this is a content-only update and skip the
      // full tree walk - using the cached node list instead.
      expect(spy).not.toHaveBeenCalled();

      spy.mockRestore();
    });

    it('preserves unchanged message references after a content-only update', () => {
      const msg1 = { id: '1', content: 'stable' };
      const msg2 = { id: '2', content: 'will-change' };
      tree.upsert('m1', msg1, makeHeaders('m1'), 'serial-1');
      tree.upsert('m2', msg2, makeHeaders('m2'), 'serial-2');

      const before = view.flattenNodes();
      const msg1RefBefore = before[0]?.message;

      // Content-only update to m2 only
      tree.upsert('m2', { id: '2', content: 'changed' }, makeHeaders('m2'), 'serial-2');

      const after = view.flattenNodes();

      // m1's message reference should be preserved (identical object)
      expect(after[0]?.message).toBe(msg1RefBefore);
      // m2's message reference should differ (content changed)
      expect(after[1]?.message).not.toBe(msg2);
      expect(after[1]?.message).toEqual({ id: '2', content: 'changed' });
    });

    it('returns a new array reference after a content-only update so React detects the change', () => {
      tree.upsert('m1', { id: '1', content: 'hi' }, makeHeaders('m1'), 'serial-1');

      const before = view.flattenNodes();

      tree.upsert('m1', { id: '1', content: 'updated' }, makeHeaders('m1'), 'serial-1');

      const after = view.flattenNodes();
      // The array itself must be a new reference (so React state updates trigger),
      // even though the tree structure hasn't changed.
      expect(after).not.toBe(before);
    });

    it('simulated streaming: only the active message reference changes per token', () => {
      // Set up a conversation with 3 messages, then simulate token-by-token
      // streaming updates to the last message (m3). Only m3's message
      // reference should change; m1 and m2 should remain stable.
      const msg1 = { id: '1', content: 'user msg' };
      const msg2 = { id: '2', content: 'assistant msg' };
      tree.upsert('m1', msg1, makeHeaders('m1'), 'serial-1');
      tree.upsert('m2', msg2, { [HEADER_MSG_ID]: 'm2', 'x-ably-parent': 'm1' }, 'serial-2');
      tree.upsert('m3', { id: '3', content: '' }, { [HEADER_MSG_ID]: 'm3', 'x-ably-parent': 'm2' }, 'serial-3');

      const snap0 = view.flattenNodes();
      const m1Ref0 = snap0[0]?.message;
      const m2Ref0 = snap0[1]?.message;

      // Simulate 3 streaming tokens updating m3
      const tokens = ['Hello', 'Hello world', 'Hello world!'];
      for (const token of tokens) {
        tree.upsert('m3', { id: '3', content: token }, {}, 'serial-3');

        const snap = view.flattenNodes();
        // m1 and m2 references must remain the same object
        expect(snap[0]?.message).toBe(m1Ref0);
        expect(snap[1]?.message).toBe(m2Ref0);
        // m3 content must reflect the latest token
        expect(snap[2]?.message.content).toBe(token);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Latest-serial-wins filter
  // -------------------------------------------------------------------------

  describe('latest-serial-wins invocation filter', () => {
    /**
     * Build user-message headers carrying run-id and invocation-id.
     * @param msgId - Message identifier stamped in `x-ably-msg-id`.
     * @param runId - Run identifier stamped in `x-ably-run-id`.
     * @param invocationId - Invocation identifier stamped in `x-ably-invocation-id`.
     * @returns A headers record with role=user and the three identifiers populated.
     */
    // eslint-disable-next-line unicorn/consistent-function-scoping -- describe-local helper
    const userH = (msgId: string, runId: string, invocationId: string): Record<string, string> => ({
      [HEADER_MSG_ID]: msgId,
      [HEADER_ROLE]: 'user',
      [HEADER_RUN_ID]: runId,
      [HEADER_INVOCATION_ID]: invocationId,
    });

    /**
     * Build assistant-message headers (no invocation-id by design).
     * @param msgId - Message identifier stamped in `x-ably-msg-id`.
     * @param runId - Run identifier stamped in `x-ably-run-id`.
     * @returns A headers record with role=assistant and the two identifiers populated.
     */
    // eslint-disable-next-line unicorn/consistent-function-scoping -- describe-local helper
    const assistantH = (msgId: string, runId: string): Record<string, string> => ({
      [HEADER_MSG_ID]: msgId,
      [HEADER_ROLE]: 'assistant',
      [HEADER_RUN_ID]: runId,
    });

    it('shows the winning invocation and hides the loser', () => {
      // Two invocations under run-1: inv-2 wins by serial.
      tree.upsert('m1', { id: '1', content: 'first' }, userH('m1', 'run-1', 'inv-1'), 'serial-005');
      tree.upsert('m1a', { id: '1a', content: 'asst-1' }, assistantH('m1a', 'run-1'), 'serial-006');
      tree.upsert('m2', { id: '2', content: 'retry' }, userH('m2', 'run-1', 'inv-2'), 'serial-010');
      tree.upsert('m2a', { id: '2a', content: 'asst-2' }, assistantH('m2a', 'run-1'), 'serial-011');

      const visibleIds = view.flattenNodes().map((n) => n.msgId);
      expect(visibleIds).toEqual(['m2', 'm2a']);
    });

    it('keeps optimistic (null-serial) inserts visible until they ack', () => {
      // Existing winning invocation under run-1.
      tree.upsert('m1', { id: '1', content: 'first' }, userH('m1', 'run-1', 'inv-1'), 'serial-005');
      // Optimistic retry — null serial.
      tree.upsert('m2', { id: '2', content: 'retry' }, userH('m2', 'run-1', 'inv-2'));

      const visibleIds = view.flattenNodes().map((n) => n.msgId);
      // Both visible: m1 is current winner, m2 is optimistic.
      expect(visibleIds).toContain('m1');
      expect(visibleIds).toContain('m2');
    });

    it('emits update and re-filters when the winner changes', () => {
      tree.upsert('m1', { id: '1', content: 'first' }, userH('m1', 'run-1', 'inv-1'), 'serial-005');
      const handler = vi.fn();
      view.on('update', handler);

      // Higher-serial retry arrives — winner switches.
      tree.upsert('m2', { id: '2', content: 'retry' }, userH('m2', 'run-1', 'inv-2'), 'serial-010');

      expect(handler).toHaveBeenCalled();
      const visibleIds = view.flattenNodes().map((n) => n.msgId);
      expect(visibleIds).toEqual(['m2']);
    });

    it('keeps separate runs independent', () => {
      // run-1 has a clear winner; run-2 is a different run.
      tree.upsert('m1', { id: '1', content: 'first' }, userH('m1', 'run-1', 'inv-1'), 'serial-005');
      tree.upsert('m2', { id: '2', content: 'second' }, userH('m2', 'run-2', 'inv-2'), 'serial-010');

      const visibleIds = view.flattenNodes().map((n) => n.msgId);
      expect(visibleIds).toContain('m1');
      expect(visibleIds).toContain('m2');
    });
  });
});
