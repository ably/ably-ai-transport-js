import type * as Ably from 'ably';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EVENT_RUN_START,
  HEADER_CODEC_MESSAGE_ID,
  HEADER_FORK_OF,
  HEADER_INVOCATION_ID,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_RUN_CONTINUE,
  HEADER_RUN_ID,
} from '../../../src/constants.js';
import type { Codec } from '../../../src/core/codec/types.js';
// Vitest hoists vi.mock above imports, so this static import gets the mock.
import { decodeHistory } from '../../../src/core/transport/decode-history.js';
import type { DefaultTree } from '../../../src/core/transport/tree.js';
import { createTree } from '../../../src/core/transport/tree.js';
import type { HistoryPage, RunLifecycleEvent } from '../../../src/core/transport/types.js';
import type { SendDelegate } from '../../../src/core/transport/view.js';
import { DefaultView } from '../../../src/core/transport/view.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';

vi.mock('../../../src/core/transport/decode-history.js', () => ({
  decodeHistory: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Test codec
// ---------------------------------------------------------------------------

interface TestMessage {
  id: string;
  content: string;
}

type TestEvent =
  | { type: 'user-message'; message: TestMessage }
  | { type: 'append-message'; message: TestMessage }
  | { type: 'regenerate'; forkOf: string; parent: string };

interface TestProjection {
  messages: TestMessage[];
}

const makeTestCodec = (): Codec<TestEvent, TestProjection, TestMessage> => ({
  init: () => ({ messages: [] }),
  fold: (state, event, meta) => {
    if (event.type === 'append-message' || event.type === 'user-message') {
      // Codec convention: TMessage.id == wire codec-message-id from meta.messageId.
      // The View's getRunByCodecMessageId / regenerate / edit rely on this.
      const msg = meta.messageId ? { ...event.message, id: meta.messageId } : event.message;
      return { messages: [...state.messages, msg] };
    }
    return state;
  },
  getMessages: (projection) => projection.messages,
  createEncoder: () => {
    throw new Error('not used in view tests');
  },
  createDecoder: () => ({ decode: () => [] }),
  userMessageEvent: (message) => ({ type: 'user-message', message }),
  createRegenerateEvent: (regenerates, parent) => ({ type: 'regenerate', forkOf: regenerates, parent }),
  classifyEvent: (event) => {
    if (event.type === 'user-message') return { kind: 'user-message' };
    if (event.type === 'regenerate') return { kind: 'regenerate', parent: event.parent, regenerates: event.forkOf };
    return { kind: 'other' };
  },
  // eslint-disable-next-line unicorn/no-useless-undefined -- the Codec contract requires returning undefined when no target is resolved
  resolveToolTarget: () => undefined,
  isTerminal: () => false,
});

const silentLogger = makeLogger({ logLevel: LogLevel.Silent });

// ---------------------------------------------------------------------------
// Mock channel and helpers
// ---------------------------------------------------------------------------

const createMockChannel = (): Ably.RealtimeChannel =>
  // CAST: Tests only call history()/attach() — the full RealtimeChannel surface isn't needed.
  ({
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    history: vi.fn(() => Promise.resolve({ items: [], hasNext: () => false, next: () => Promise.resolve() })),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
    attach: vi.fn(() => Promise.resolve()),
  }) as unknown as Ably.RealtimeChannel;

const createMockSendDelegate = (): SendDelegate<TestEvent, TestMessage> =>
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
  vi.fn(() =>
    Promise.resolve({
      stream: new ReadableStream(),
      runId: 'mock-run',
      invocationId: 'mock-inv',
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock returns Promise.resolve directly
      cancel: () => Promise.resolve(),
      optimisticCodecMessageIds: [],
      eventIds: [],
    }),
  );

interface ApplyOpts {
  runId: string;
  codecMessageId?: string;
  parent?: string;
  forkOf?: string;
  regenerates?: string;
  role?: string;
  invocationId?: string;
  runContinue?: boolean;
  serial?: string;
  message?: TestMessage;
}

const apply = (tree: DefaultTree<TestEvent, TestProjection>, opts: ApplyOpts): void => {
  const h: Record<string, string> = { [HEADER_RUN_ID]: opts.runId };
  if (opts.codecMessageId) h[HEADER_CODEC_MESSAGE_ID] = opts.codecMessageId;
  if (opts.parent) h[HEADER_PARENT] = opts.parent;
  if (opts.forkOf) h[HEADER_FORK_OF] = opts.forkOf;
  if (opts.regenerates) h['x-ably-msg-regenerate'] = opts.regenerates;
  if (opts.role) h[HEADER_ROLE] = opts.role;
  if (opts.invocationId) h[HEADER_INVOCATION_ID] = opts.invocationId;
  if (opts.runContinue) h[HEADER_RUN_CONTINUE] = 'true';
  const events: TestEvent[] = opts.message ? [{ type: 'append-message', message: opts.message }] : [];
  tree.applyMessage(events, h, opts.serial);
};

const makePage = (
  items: { message: TestMessage; headers: Record<string, string>; serial: string }[],
  rawMessages: Ably.InboundMessage[] = [],
  hasNextPage = false,
  nextPageFn?: () => Promise<HistoryPage<TestMessage> | undefined>,
): HistoryPage<TestMessage> => ({
  items,
  rawMessages,
  hasNext: () => hasNextPage,
  // eslint-disable-next-line @typescript-eslint/promise-function-async, unicorn/no-useless-undefined -- mock needs explicit undefined return for HistoryPage shape
  next: nextPageFn ?? (() => Promise.resolve(undefined)),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DefaultView', () => {
  let tree: DefaultTree<TestEvent, TestProjection>;
  let view: DefaultView<TestEvent, TestProjection, TestMessage>;
  let sendDelegate: SendDelegate<TestEvent, TestMessage>;
  let codec: Codec<TestEvent, TestProjection, TestMessage>;

  beforeEach(() => {
    vi.mocked(decodeHistory).mockReset();
    codec = makeTestCodec();
    tree = createTree(codec, silentLogger);
    sendDelegate = createMockSendDelegate();
    view = new DefaultView({
      tree,
      channel: createMockChannel(),
      codec,
      sendDelegate,
      logger: silentLogger,
    });
  });

  // -------------------------------------------------------------------------
  // flattenNodes and getMessages
  // -------------------------------------------------------------------------

  describe('flattenNodes and getMessages', () => {
    it('returns RunNode[] along the visible chain', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'first' }, serial: 's1' });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'm2',
        parent: 'm1',
        message: { id: 'b', content: 'second' },
        serial: 's2',
      });

      const nodes = view.flattenNodes();
      expect(nodes.map((n) => n.runId)).toEqual(['R1', 'R2']);
    });

    it("getMessages concatenates each Run's codec.getMessages output", () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'q1' }, serial: 's1' });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm2',
        parent: 'm1',
        message: { id: 'b', content: 'a1' },
        serial: 's2',
      });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'm3',
        parent: 'm2',
        message: { id: 'c', content: 'q2' },
        serial: 's3',
      });

      // The codec convention rebinds each TMessage.id to the wire codecMessageId.
      expect(view.getMessages()).toEqual([
        { id: 'm1', content: 'q1' },
        { id: 'm2', content: 'a1' },
        { id: 'm3', content: 'q2' },
      ]);
    });

    it('returns an empty list for an empty tree', () => {
      expect(view.flattenNodes()).toEqual([]);
      expect(view.getMessages()).toEqual([]);
    });

    // -----------------------------------------------------------------------
    // Cross-Run concat edge cases (AIT-773 §2.3)
    // -----------------------------------------------------------------------

    it('includes a Run that has zero messages in flattenNodes but contributes no messages to getMessages', () => {
      // A "zero-message" Run can exist transiently: the agent's
      // `ai-run-start` lifecycle created the Run but no codec events
      // have folded in yet (regenerate Runs spend their first
      // microseconds in this state).
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'u1',
        message: { id: 'u1', content: 'q' },
        serial: 's1',
      });
      tree.applyRunLifecycle(
        { type: 'ai-run-start', runId: 'R_empty', clientId: '', invocationId: '', parent: 'u1' },
        's2',
      );

      // Both Runs flatten; only R1 has messages so getMessages reflects
      // R1's content with no gap or undefined entry for R_empty.
      expect(view.flattenNodes().map((n) => n.runId)).toEqual(['R1', 'R_empty']);
      expect(view.getMessages().map((m) => m.id)).toEqual(['u1']);
    });

    it('preserves per-Run order across many-message Runs', () => {
      // A Run can carry several messages (e.g. user + assistant text
      // + tool call + tool result + continuation assistant text). The
      // codec folds them in publish order; the View must concatenate
      // each Run's messages in that order, then concatenate across
      // Runs by parentRunId chain.
      apply(tree, { runId: 'R1', codecMessageId: 'a', message: { id: 'a', content: 'a-1' }, serial: 's1' });
      apply(tree, { runId: 'R1', codecMessageId: 'b', message: { id: 'b', content: 'a-2' }, serial: 's2' });
      apply(tree, { runId: 'R1', codecMessageId: 'c', message: { id: 'c', content: 'a-3' }, serial: 's3' });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'd',
        parent: 'c',
        message: { id: 'd', content: 'b-1' },
        serial: 's4',
      });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'e',
        parent: 'd',
        message: { id: 'e', content: 'b-2' },
        serial: 's5',
      });

      expect(view.getMessages().map((m) => m.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('flattens a five-turn linear conversation in publish order', () => {
      // Multi-turn baseline: five user+assistant turns.
      apply(tree, { runId: 'R1', codecMessageId: 'u1', message: { id: 'u1', content: 'q1' }, serial: 's01' });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'a1',
        parent: 'u1',
        message: { id: 'a1', content: 'r1' },
        serial: 's02',
      });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'u2',
        parent: 'a1',
        message: { id: 'u2', content: 'q2' },
        serial: 's03',
      });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'a2',
        parent: 'u2',
        message: { id: 'a2', content: 'r2' },
        serial: 's04',
      });
      apply(tree, {
        runId: 'R3',
        codecMessageId: 'u3',
        parent: 'a2',
        message: { id: 'u3', content: 'q3' },
        serial: 's05',
      });
      apply(tree, {
        runId: 'R3',
        codecMessageId: 'a3',
        parent: 'u3',
        message: { id: 'a3', content: 'r3' },
        serial: 's06',
      });
      apply(tree, {
        runId: 'R4',
        codecMessageId: 'u4',
        parent: 'a3',
        message: { id: 'u4', content: 'q4' },
        serial: 's07',
      });
      apply(tree, {
        runId: 'R4',
        codecMessageId: 'a4',
        parent: 'u4',
        message: { id: 'a4', content: 'r4' },
        serial: 's08',
      });
      apply(tree, {
        runId: 'R5',
        codecMessageId: 'u5',
        parent: 'a4',
        message: { id: 'u5', content: 'q5' },
        serial: 's09',
      });
      apply(tree, {
        runId: 'R5',
        codecMessageId: 'a5',
        parent: 'u5',
        message: { id: 'a5', content: 'r5' },
        serial: 's10',
      });

      expect(view.flattenNodes().map((n) => n.runId)).toEqual(['R1', 'R2', 'R3', 'R4', 'R5']);
      expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4', 'u5', 'a5']);
    });
  });

  // -------------------------------------------------------------------------
  // Query methods
  // -------------------------------------------------------------------------

  describe('query methods', () => {
    beforeEach(() => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'q' }, serial: 's1' });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'm2',
        parent: 'm1',
        message: { id: 'b', content: 'a' },
        serial: 's2',
      });
    });

    it('getRunNode returns the Run by runId', () => {
      expect(view.getRunNode('R1')?.runId).toBe('R1');
      expect(view.getRunNode('R-unknown')).toBeUndefined();
    });

    it('getMessageMetadata resolves the owning Run', () => {
      expect(view.getMessageMetadata('m1')?.runId).toBe('R1');
      expect(view.getMessageMetadata('m2')?.runId).toBe('R2');
      expect(view.getMessageMetadata('m-unknown')).toBeUndefined();
    });

    it('getActiveRunIds returns active runs', () => {
      tree.trackRun('R1', 'client-a');
      expect(view.getActiveRunIds().get('client-a')).toEqual(new Set(['R1']));
    });
  });

  // -------------------------------------------------------------------------
  // Branch selection
  // -------------------------------------------------------------------------

  describe('branch selection', () => {
    // eslint-disable-next-line unicorn/consistent-function-scoping -- closure captures `tree` from outer beforeEach
    const seedFork = (): void => {
      // role omitted so the user-content wire keeps routing at wire-runId
      // (the role-based sub-Run split is verified elsewhere). These tests
      // focus on parent/forkOf sibling-selection semantics.
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'u1',
        message: { id: 'a', content: 'user-q' },
        serial: 's1',
      });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'a1',
        parent: 'u1',
        message: { id: 'b', content: 'v1' },
        serial: 's2',
      });
      apply(tree, {
        runId: 'R2alt',
        codecMessageId: 'a2',
        parent: 'u1',
        forkOf: 'a1',
        message: { id: 'c', content: 'v2' },
        serial: 's3',
      });
    };

    /**
     * Create a fresh view AFTER seeding so the View walks an already-populated
     * tree (no pin-on-external-fork behavior).
     * @returns A new DefaultView observing the already-seeded tree.
     */
    const freshViewAfterSeed = (): DefaultView<TestEvent, TestProjection, TestMessage> => {
      seedFork();
      return new DefaultView({
        tree,
        channel: createMockChannel(),
        codec,
        sendDelegate,
        logger: silentLogger,
      });
    };

    it('default selection picks the latest sibling Run (fresh view after fork)', () => {
      const v = freshViewAfterSeed();
      expect(v.flattenNodes().map((r) => r.runId)).toEqual(['R1', 'R2alt']);
    });

    it('pins selection to the currently-visible sibling when a fork appears (live view)', () => {
      // View constructed before any data; watches as R1, R2, R2alt arrive.
      // When R2alt appears, R2 is already visible → pin to R2.
      seedFork();
      expect(view.flattenNodes().map((r) => r.runId)).toEqual(['R1', 'R2']);
    });

    it('select switches to the chosen sibling Run', () => {
      const v = freshViewAfterSeed();
      v.select('R2', 0); // R2 is the older sibling at index 0
      expect(v.flattenNodes().map((r) => r.runId)).toEqual(['R1', 'R2']);
    });

    it('getSelectedIndex returns the chosen index', () => {
      const v = freshViewAfterSeed();
      v.select('R2', 0);
      expect(v.getSelectedIndex('R2')).toBe(0);
      v.select('R2alt', 1);
      expect(v.getSelectedIndex('R2alt')).toBe(1);
    });

    it('getSelectedIndex returns 0 for an unforked Run', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'x' }, serial: 's1' });
      expect(view.getSelectedIndex('R1')).toBe(0);
    });

    it('select clamps the index to the sibling-group bounds', () => {
      const v = freshViewAfterSeed();
      v.select('R2', 999);
      expect(v.getSelectedIndex('R2')).toBe(1);
      v.select('R2', -5);
      expect(v.getSelectedIndex('R2')).toBe(0);
    });

    it('select is a no-op when the Run has no siblings', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'x' }, serial: 's1' });
      const handler = vi.fn();
      view.on('update', handler);
      view.select('R1', 0);
      expect(handler).not.toHaveBeenCalled();
    });

    it('emits update when select changes the visible chain', () => {
      const v = freshViewAfterSeed();
      const handler = vi.fn();
      v.on('update', handler);
      v.select('R2', 0);
      expect(handler).toHaveBeenCalled();
    });

    it('descendants of the non-selected sibling are hidden', () => {
      const v = freshViewAfterSeed();
      // Descendant of R2 (original branch)
      apply(tree, {
        runId: 'R3orig',
        codecMessageId: 'm-d1',
        parent: 'a1',
        message: { id: 'd', content: 'after-v1' },
        serial: 's4',
      });
      // Descendant of R2alt (the latest branch)
      apply(tree, {
        runId: 'R3alt',
        codecMessageId: 'm-d2',
        parent: 'a2',
        message: { id: 'e', content: 'after-v2' },
        serial: 's5',
      });

      // Default: R2alt is selected (fresh view, no pin yet).
      expect(v.flattenNodes().map((r) => r.runId)).toEqual(['R1', 'R2alt', 'R3alt']);
      // Select R2: R3orig becomes visible, R3alt hidden.
      v.select('R2', 0);
      expect(v.flattenNodes().map((r) => r.runId)).toEqual(['R1', 'R2', 'R3orig']);
    });
  });

  // -------------------------------------------------------------------------
  // Write operations (send delegate forwarding)
  // -------------------------------------------------------------------------

  describe('write operations', () => {
    it('sendMessage wraps each TMessage via codec.userMessageEvent and forwards to delegate', async () => {
      await view.sendMessage({ id: 'a', content: 'hello' });
      expect(sendDelegate).toHaveBeenCalledTimes(1);
      const call = vi.mocked(sendDelegate).mock.calls[0];
      if (!call) throw new Error('expected delegate call');
      const events = call[0];
      expect(events).toHaveLength(1);
      expect(events[0]?.event).toEqual({ type: 'user-message', message: { id: 'a', content: 'hello' } });
    });

    it('sendMessage forwards history (TMessage[]) and parentCodecMessageId', async () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'first' }, serial: 's1' });
      await view.sendMessage({ id: 'b', content: 'second' });

      const call = vi.mocked(sendDelegate).mock.calls[0];
      if (!call) throw new Error('expected delegate call');
      // The codec convention rebinds TMessage.id to the wire codecMessageId.
      expect(call[2]).toEqual([{ id: 'm1', content: 'first' }]); // history
      expect(call[3]).toBe('m1'); // parentCodecMessageId = last visible message's id (= wire codecMessageId)
    });

    it('sendMessage with empty visible chain passes undefined parentCodecMessageId', async () => {
      await view.sendMessage({ id: 'a', content: 'hi' });
      const call = vi.mocked(sendDelegate).mock.calls[0];
      if (!call) throw new Error('expected delegate call');
      expect(call[3]).toBeUndefined();
    });

    it('sendMessage forwards options through to the delegate', async () => {
      const opts = { runId: 'R-explicit', clientId: 'c-explicit' };
      await view.sendMessage({ id: 'a', content: 'hi' }, opts);
      const call = vi.mocked(sendDelegate).mock.calls[0];
      if (!call) throw new Error('expected delegate call');
      expect(call[1]).toBe(opts);
    });

    it('sendMessage uses view-local branch selection as history context', async () => {
      // Build R1 (user) → R2 (assistant) with sibling R2alt at the assistant level.
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'u1',
        role: 'user',
        message: { id: 'a', content: 'q' },
        serial: 's1',
      });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'a1',
        parent: 'u1',
        message: { id: 'b', content: 'v1' },
        serial: 's2',
      });
      // Prime the view so the next fork is pinned to R2.
      view.flattenNodes();
      apply(tree, {
        runId: 'R2alt',
        codecMessageId: 'a2',
        parent: 'u1',
        forkOf: 'a1',
        message: { id: 'c', content: 'v2' },
        serial: 's3',
      });

      // Default visible branch is R2 (pin-on-external-fork). Switch view A
      // to R2alt and verify the delegate sees R2alt's projection in history.
      view.select('R2', 1);
      await view.sendMessage({ id: 'd', content: 'next' });

      const call = vi.mocked(sendDelegate).mock.calls[0];
      if (!call) throw new Error('expected delegate call');
      // History should include u1 (user) and a2 (R2alt's reply), NOT a1
      // (R2's reply, which is not on the selected branch).
      expect(call[2].map((m) => m.id)).toEqual(['u1', 'a2']);
    });

    it('sendEvent normalises a single TEvent input', async () => {
      await view.sendEvent({ type: 'user-message', message: { id: 'a', content: 'hi' } });
      const events = vi.mocked(sendDelegate).mock.calls[0]?.[0];
      expect(events).toEqual([{ event: { type: 'user-message', message: { id: 'a', content: 'hi' } } }]);
    });

    it('sendEvent normalises a TEvent[] input', async () => {
      await view.sendEvent([
        { type: 'user-message', message: { id: 'a', content: 'hi' } },
        { type: 'user-message', message: { id: 'b', content: 'bye' } },
      ]);
      const events = vi.mocked(sendDelegate).mock.calls[0]?.[0];
      expect(events).toEqual([
        { event: { type: 'user-message', message: { id: 'a', content: 'hi' } } },
        { event: { type: 'user-message', message: { id: 'b', content: 'bye' } } },
      ]);
    });

    it('sendEvent passes the richer per-entry shape through', async () => {
      const input = [
        { event: { type: 'user-message' as const, message: { id: 'a', content: 'hi' } }, domainMessageId: 'override' },
      ];
      await view.sendEvent(input);
      const events = vi.mocked(sendDelegate).mock.calls[0]?.[0];
      expect(events).toEqual(input);
    });

    it('regenerate produces a regenerate event keyed on the resolved parent and target codec-message-ids; sendOptions carry parent (no forkOf)', async () => {
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'u1',
        role: 'user',
        message: { id: 'a', content: 'q' },
        serial: 's1',
      });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'a1',
        parent: 'u1',
        message: { id: 'b', content: 'reply' },
        serial: 's2',
      });

      // Codec convention: TMessage.id is set to the wire codec-message-id at fold time.
      await view.regenerate('a1');

      expect(sendDelegate).toHaveBeenCalledTimes(1);
      const call = vi.mocked(sendDelegate).mock.calls[0];
      if (!call) throw new Error('expected delegate call');
      const event = call[0][0]?.event;
      // The test codec's createRegenerateEvent stores the regen target in
      // its local `forkOf` field for symmetry with the legacy event shape;
      // the codec contract surfaces it as `regenerates` on classification.
      expect(event).toEqual({ type: 'regenerate', forkOf: 'a1', parent: 'u1' });
      // Regenerate sets parent only — the Run-level fork relationship is
      // intentionally absent. The replacement happens at projection
      // extraction time, not via a sibling Run.
      expect(call[1]?.forkOf).toBeUndefined();
      expect(call[1]?.parent).toBe('u1');
    });

    it('regenerate throws when the target message is unknown', async () => {
      await expect(view.regenerate('unknown')).rejects.toThrow(/message not found/);
    });

    it('edit of an already-edited user prompt resolves parent correctly (P1 -> P2 -> P3 chain)', async () => {
      // R1 = [u1, a1] (original).
      // R_edit1 = [u2, a2] (forkOf=u1, the first edit).
      // Now editing u2 should produce a Run that forks u2 (the latest
      // edited prompt). _findParentMsgId for u2 in the visible chain
      // resolves to undefined (u2 is the first visible msg), so the new
      // edit Run is root-level too.
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'u1',
        role: 'user',
        message: { id: 'u1', content: 'alpha' },
        serial: 's1',
      });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'a1',
        role: 'assistant',
        message: { id: 'a1', content: 'reply-alpha' },
        serial: 's2',
      });
      apply(tree, {
        runId: 'R_edit1',
        codecMessageId: 'u2',
        forkOf: 'u1',
        role: 'user',
        message: { id: 'u2', content: 'bravo' },
        serial: 's3',
      });
      apply(tree, {
        runId: 'R_edit1',
        codecMessageId: 'a2',
        role: 'assistant',
        parent: 'u2',
        message: { id: 'a2', content: 'reply-bravo' },
        serial: 's4',
      });

      // R_edit1 is the latest auto-selected (per existing pinning rules,
      // but the View pins to the previously-visible R1 unless the caller
      // ran view.edit). To exercise editing u2, select R_edit1 first.
      view.select('R1', 1);
      expect(view.getMessages().map((m) => m.id)).toEqual(['u2', 'a2']);

      await view.edit('u2', { type: 'user-message', message: { id: 'u3', content: 'charlie' } });

      const call = vi.mocked(sendDelegate).mock.calls[0];
      if (!call) throw new Error('expected delegate call');
      const [, sendOptions] = call;
      // For an edit of the root-level prompt, parent is undefined.
      expect(sendOptions?.parent).toBeUndefined();
      expect(sendOptions?.forkOf).toBe('u2');
      // History sent to the LLM (overridden via body.history) excludes
      // the edited prompt — the LLM doesn't see the prompt it's
      // replacing.
      const bodyHistory = (sendOptions?.body as { history?: TestMessage[] } | undefined)?.history;
      expect(bodyHistory?.map((m) => m.id)).toEqual([]);
    });

    it('regenerate of an already-regenerated assistant resolves parent to the user prompt, not the hidden original assistant', async () => {
      // Setup: R1 = [user u1, asst a1]. Then a regenerate creates R_regen
      // (continuation of R1, regeneratesCodecMessageId=a1, owns a1p). The visible
      // chain after regen = [u1, a1p] (a1 is hidden by message-level
      // replacement).
      //
      // Bug: regenerating a1p (the regenerator's content) used to walk
      // R_regen's projection (idx=0), fall back to the parent Run's tail
      // — which is a1 (the hidden assistant). The history then ended
      // with an assistant message, breaking Anthropic prefill semantics.
      //
      // Expected: parent resolves to u1 (the user prompt the regen is
      // responding to). History sent on send = [u1].
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'u1',
        role: 'user',
        message: { id: 'u1', content: 'q' },
        serial: 's1',
      });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'a1',
        role: 'assistant',
        message: { id: 'a1', content: 'first reply' },
        serial: 's2',
      });
      apply(tree, {
        runId: 'R_regen',
        codecMessageId: 'a1p',
        parent: 'a1',
        regenerates: 'a1',
        role: 'assistant',
        message: { id: 'a1p', content: 'regen reply' },
        serial: 's3',
      });

      // Sanity: visible chain after the first regen is [u1, a1p].
      expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1p']);

      await view.regenerate('a1p');

      const call = vi.mocked(sendDelegate).mock.calls[0];
      if (!call) throw new Error('expected delegate call');
      const [events, sendOptions, history, parentCodecMessageId] = call;
      // The wire's `x-ably-parent` must be u1 (the user prompt), NOT a1
      // (the hidden original assistant).
      expect(sendOptions?.parent).toBe('u1');
      expect(parentCodecMessageId).toBe('u1');
      // History must end with the user prompt — the LLM is supposed to
      // re-answer it; ending with an assistant breaks Anthropic prefill.
      expect(history.map((m) => m.id)).toEqual(['u1']);
      // The regenerate event's anchor codec-message-id must be the CANONICAL
      // anchor (a1), not the clicked-on regen content (a1p). Anchoring
      // every regen at the same canonical codec-message-id grows a single group
      // of alternatives — clicking Regenerate N times produces N+1
      // members at the same branch point.
      const event = events[0]?.event as { type: string; forkOf?: string; parent?: string } | undefined;
      expect(event?.type).toBe('regenerate');
      expect(event?.forkOf).toBe('a1');
    });

    it('regenerate throws when the target has no predecessor', async () => {
      apply(tree, { runId: 'R1', codecMessageId: 'only', message: { id: 'x', content: 'x' }, serial: 's1' });
      await expect(view.regenerate('only')).rejects.toThrow(/parent user message not found/);
    });

    it('edit forwards forkOf and parent for a user-message edit', async () => {
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'u1',
        role: 'user',
        message: { id: 'a', content: 'q' },
        serial: 's1',
      });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'a1',
        parent: 'u1',
        message: { id: 'b', content: 'reply' },
        serial: 's2',
      });
      apply(tree, {
        runId: 'R3',
        codecMessageId: 'u2',
        parent: 'a1',
        role: 'user',
        message: { id: 'c', content: 'follow' },
        serial: 's3',
      });

      await view.edit('u2', { type: 'user-message', message: { id: 'c', content: 'edited' } });
      const call = vi.mocked(sendDelegate).mock.calls[0];
      if (!call) throw new Error('expected delegate call');
      expect(call[1]?.forkOf).toBe('u2');
      expect(call[1]?.parent).toBe('a1'); // predecessor of u2 in flat list
    });

    it('edit throws when the target message is unknown', async () => {
      await expect(view.edit('unknown', { type: 'user-message', message: { id: 'u', content: 'x' } })).rejects.toThrow(
        /message not found/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Events (scoped to visible)
  // -------------------------------------------------------------------------

  describe('event scoping', () => {
    it('forwards update on tree structural change', () => {
      const handler = vi.fn();
      view.on('update', handler);
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      expect(handler).toHaveBeenCalled();
    });

    it('forwards run-projection-updated as update when the run is on the visible chain', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      const handler = vi.fn();
      view.on('update', handler);
      // Folding another message into R1 fires run-projection-updated for a
      // visible run.
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm2',
        parent: 'm1',
        message: { id: 'b', content: 'follow' },
        serial: 's2',
      });
      expect(handler).toHaveBeenCalled();
    });

    it('forwards ably-message for a message whose runId is visible', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      const handler = vi.fn();
      view.on('ably-message', handler);
      // CAST: tests don't need a fully-typed Ably.InboundMessage.
      const fakeMsg = {
        name: 'fake',
        data: 'x',
        extras: { headers: { [HEADER_RUN_ID]: 'R1' } },
      } as unknown as Ably.InboundMessage;
      tree.emitAblyMessage(fakeMsg);
      expect(handler).toHaveBeenCalledWith(fakeMsg);
    });

    it('drops ably-message for a message whose runId is NOT visible', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      const handler = vi.fn();
      view.on('ably-message', handler);
      const fakeMsg = {
        name: 'fake',
        extras: { headers: { [HEADER_RUN_ID]: 'R-other' } },
      } as unknown as Ably.InboundMessage;
      tree.emitAblyMessage(fakeMsg);
      expect(handler).not.toHaveBeenCalled();
    });

    it('forwards lifecycle / control ably-messages without a runId or codecMessageId', () => {
      const handler = vi.fn();
      view.on('ably-message', handler);
      const fakeMsg = { name: 'cancel', extras: { headers: {} } } as unknown as Ably.InboundMessage;
      tree.emitAblyMessage(fakeMsg);
      expect(handler).toHaveBeenCalledWith(fakeMsg);
    });

    it('forwards run lifecycle events for visible runs', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      const handler = vi.fn();
      view.on('run', handler);
      tree.applyRunLifecycle({ type: 'ai-run-start', runId: 'R1', clientId: 'c', invocationId: '' }, 's2');
      expect(handler).toHaveBeenCalled();
    });

    it('forwards run-start when parent metadata indicates a visible branch', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      const handler = vi.fn();
      view.on('run', handler);
      // Run-start for an unknown new run, but parent points at a visible msg.
      const evt: RunLifecycleEvent = {
        type: 'ai-run-start',
        runId: 'R2',
        clientId: 'c',
        invocationId: '',
        parent: 'm1',
      };
      // tree.applyRunLifecycle creates R2 with parentRunId resolved from m1 → R1.
      tree.applyRunLifecycle(evt, 's2');
      expect(handler).toHaveBeenCalled();
    });

    it('unsubscribe stops forwarding', () => {
      const handler = vi.fn();
      const unsub = view.on('update', handler);
      unsub();
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      expect(handler).not.toHaveBeenCalled();
    });

    it("messages are recomputed when a visible Run's projection updates", () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'q' }, serial: 's1' });
      const handler = vi.fn();
      view.on('update', handler);
      // Fold something into R1.
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm2',
        parent: 'm1',
        message: { id: 'b', content: 'follow' },
        serial: 's2',
      });
      expect(view.getMessages()).toEqual([
        { id: 'm1', content: 'q' },
        { id: 'm2', content: 'follow' },
      ]);
      expect(handler).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Reference stability — React change-detection invariant
  // -------------------------------------------------------------------------

  describe('reference stability', () => {
    beforeEach(() => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'q' }, serial: 's1' });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'm2',
        parent: 'm1',
        message: { id: 'b', content: 'reply' },
        serial: 's2',
      });
    });

    it('getMessages returns the same array reference across consecutive no-op calls', () => {
      const a = view.getMessages();
      const b = view.getMessages();
      expect(a).toBe(b);
    });

    it('flattenNodes returns the same array reference across consecutive no-op calls', () => {
      const a = view.flattenNodes();
      const b = view.flattenNodes();
      expect(a).toBe(b);
    });

    it('getMessages returns a fresh array reference after a visible Run projection update', () => {
      const before = view.getMessages();
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'm3',
        parent: 'm2',
        message: { id: 'c', content: 'follow' },
        serial: 's3',
      });
      const after = view.getMessages();
      expect(after).not.toBe(before);
      // React change-detection: unchanged TMessages keep their reference so
      // memoised components don't re-render.
      expect(after[0]).toBe(before[0]);
      expect(after[1]).toBe(before[1]);
    });

    it('flattenNodes keeps its array reference when only a visible projection updated (no structural change)', () => {
      // Streaming-token / continuation: tree fires 'run-projection-updated'
      // but the Run identity list is unchanged. The View keeps _cachedNodes
      // reference-stable; getMessages() returns a fresh array.
      const beforeNodes = view.flattenNodes();
      const beforeMessages = view.getMessages();
      apply(tree, {
        runId: 'R2',
        runContinue: true,
        codecMessageId: 'm3',
        parent: 'm2',
        message: { id: 'c', content: 'follow' },
        serial: 's3',
      });
      const afterNodes = view.flattenNodes();
      const afterMessages = view.getMessages();
      expect(afterNodes).toBe(beforeNodes);
      expect(afterMessages).not.toBe(beforeMessages);
    });

    it('flattenNodes returns a fresh array reference on structural change (new Run)', () => {
      const before = view.flattenNodes();
      apply(tree, {
        runId: 'R3',
        codecMessageId: 'm3',
        parent: 'm2',
        message: { id: 'c', content: 'next-turn' },
        serial: 's3',
      });
      const after = view.flattenNodes();
      expect(after).not.toBe(before);
    });

    it("suppresses 'update' when projection-updated arrives but projection and messages are unchanged", () => {
      // Custom codec whose fold returns the same projection reference and
      // the same messages array when given a no-op event. This simulates a
      // reducer past its high-water-mark serial (idempotent re-fold).
      const noopCodec = makeTestCodec();
      const sharedMessages = [{ id: 'm1', content: 'q' }];
      const sharedProjection = { messages: sharedMessages };
      noopCodec.fold = (state) => state;
      noopCodec.init = () => sharedProjection;
      noopCodec.getMessages = (p) => p.messages;

      const noopTree = createTree(noopCodec, silentLogger);
      const noopView = new DefaultView({
        tree: noopTree,
        channel: createMockChannel(),
        codec: noopCodec,
        sendDelegate,
        logger: silentLogger,
      });

      apply(noopTree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'q' }, serial: 's1' });
      noopView.flattenNodes(); // prime the cache

      const handler = vi.fn();
      noopView.on('update', handler);
      const beforeCalls = handler.mock.calls.length;

      // Trigger a fold that returns the same projection + same messages.
      noopTree.applyMessage([{ type: 'append-message', message: { id: 'x', content: 'noop' } }], {
        [HEADER_RUN_ID]: 'R1',
        [HEADER_CODEC_MESSAGE_ID]: 'm-noop',
      });

      // structural emit on the new codecMessageId index entry is allowed; the
      // run-projection-updated path must not double-emit.
      const afterCalls = handler.mock.calls.length;
      // At most one emit (the structural one). The reference-equality
      // short-circuit in _onTreeProjectionUpdated suppresses the second.
      expect(afterCalls - beforeCalls).toBeLessThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // Multi-view co-existence — two views over the same tree
  // -------------------------------------------------------------------------

  describe('multi-view', () => {
    let viewB: DefaultView<TestEvent, TestProjection, TestMessage>;

    beforeEach(() => {
      viewB = new DefaultView({
        tree,
        channel: createMockChannel(),
        codec,
        sendDelegate,
        logger: silentLogger,
      });
    });

    it('both views receive update when the shared tree changes', () => {
      const aHandler = vi.fn();
      const bHandler = vi.fn();
      view.on('update', aHandler);
      viewB.on('update', bHandler);
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      expect(aHandler).toHaveBeenCalled();
      expect(bHandler).toHaveBeenCalled();
    });

    it('branch selection is per-view (selecting in one does not affect the other)', () => {
      // Build R1 (user) → R2 (assistant) with a sibling R2alt. Both views
      // pin to R2 on the external fork (pin-on-external-fork preserves the
      // currently-visible sibling). role omitted so the user-content wire
      // routes at wire-runId (the role-based sub-Run split is exercised
      // elsewhere).
      apply(tree, { runId: 'R1', codecMessageId: 'u1', message: { id: 'a', content: 'q' }, serial: 's1' });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'a1',
        parent: 'u1',
        message: { id: 'b', content: 'v1' },
        serial: 's2',
      });
      // Prime both views so they see R2 before the fork appears.
      view.flattenNodes();
      viewB.flattenNodes();
      apply(tree, {
        runId: 'R2alt',
        codecMessageId: 'a2',
        parent: 'u1',
        forkOf: 'a1',
        message: { id: 'c', content: 'v2' },
        serial: 's3',
      });
      expect(view.flattenNodes().map((r) => r.runId)).toEqual(['R1', 'R2']);
      expect(viewB.flattenNodes().map((r) => r.runId)).toEqual(['R1', 'R2']);

      // Select R2alt in view A; view B's selection is unchanged.
      view.select('R2', 1);
      expect(view.flattenNodes().map((r) => r.runId)).toEqual(['R1', 'R2alt']);
      expect(viewB.flattenNodes().map((r) => r.runId)).toEqual(['R1', 'R2']);
    });

    it('closing one view does not affect the other', () => {
      const aHandler = vi.fn();
      const bHandler = vi.fn();
      view.on('update', aHandler);
      viewB.on('update', bHandler);

      view.close();
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });

      expect(aHandler).not.toHaveBeenCalled();
      expect(bHandler).toHaveBeenCalled();
      // The other view is still functional.
      expect(viewB.flattenNodes().map((r) => r.runId)).toEqual(['R1']);
    });
  });

  // -------------------------------------------------------------------------
  // Pagination (loadOlder / hasOlder)
  // -------------------------------------------------------------------------

  describe('loadOlder / hasOlder', () => {
    it('hasOlder is false initially with empty history', async () => {
      vi.mocked(decodeHistory).mockResolvedValueOnce(makePage([]));
      expect(view.hasOlder()).toBe(false);
      await view.loadOlder();
      expect(view.hasOlder()).toBe(false);
    });

    it('loadOlder reveals Runs from history and bumps visible chain', async () => {
      // History returns a single message that creates Run R0.
      const items = [
        {
          message: { id: 'h1', content: 'old' },
          headers: { [HEADER_RUN_ID]: 'R0', [HEADER_CODEC_MESSAGE_ID]: 'mh1' },
          serial: 's0',
        },
      ];
      const rawMsg = {
        name: 'fake',
        serial: 's0',
        extras: { headers: { [HEADER_RUN_ID]: 'R0', [HEADER_CODEC_MESSAGE_ID]: 'mh1' } },
      } as unknown as Ably.InboundMessage;

      // The View's _processHistoryPage uses page.rawMessages and decodes
      // them through a fresh codec.createDecoder(). Since our test codec's
      // decoder returns [], we need to override decode to produce events.
      const decodeSpy = vi.fn(() => [{ type: 'append-message' as const, message: { id: 'h1', content: 'old' } }]);
      codec.createDecoder = vi.fn(() => ({ decode: decodeSpy }));

      vi.mocked(decodeHistory).mockResolvedValueOnce(makePage(items, [rawMsg]));

      await view.loadOlder(10);
      expect(view.flattenNodes().map((r) => r.runId)).toContain('R0');
    });

    it('hasOlder becomes true when history page reports hasNext', async () => {
      const items = [
        {
          message: { id: 'h1', content: 'old' },
          headers: { [HEADER_RUN_ID]: 'R0', [HEADER_CODEC_MESSAGE_ID]: 'mh1' },
          serial: 's0',
        },
      ];
      const rawMsg = {
        name: 'fake',
        serial: 's0',
        extras: { headers: { [HEADER_RUN_ID]: 'R0', [HEADER_CODEC_MESSAGE_ID]: 'mh1' } },
      } as unknown as Ably.InboundMessage;
      const decodeSpy = vi.fn(() => [{ type: 'append-message' as const, message: { id: 'h1', content: 'old' } }]);
      codec.createDecoder = vi.fn(() => ({ decode: decodeSpy }));

      vi.mocked(decodeHistory).mockResolvedValueOnce(makePage(items, [rawMsg], true));

      await view.loadOlder(10);
      expect(view.hasOlder()).toBe(true);
    });

    it('is a no-op when called while already loading', async () => {
      let resolveFirst: ((page: HistoryPage<TestMessage>) => void) | undefined;
      vi.mocked(decodeHistory).mockReturnValueOnce(
        new Promise<HistoryPage<TestMessage>>((resolve) => {
          resolveFirst = resolve;
        }),
      );

      const p1 = view.loadOlder(10);
      const p2 = view.loadOlder(10);
      // Second call should immediately resolve as no-op.
      await p2;
      // decodeHistory called only once.
      expect(vi.mocked(decodeHistory)).toHaveBeenCalledTimes(1);
      resolveFirst?.(makePage([]));
      await p1;
    });

    it('withholds excess Runs and drains them on subsequent loadOlder calls without re-fetching', async () => {
      // First page reveals 3 Runs (R0, R1, R2). With limit=2 the View
      // reveals the newest 2 and withholds the oldest in the buffer.
      const items = [0, 1, 2].map((i) => ({
        message: { id: `h${String(i)}`, content: `old-${String(i)}` },
        headers: { [HEADER_RUN_ID]: `R${String(i)}`, [HEADER_CODEC_MESSAGE_ID]: `mh${String(i)}` },
        serial: `s${String(i)}`,
      }));
      const rawMessages = [0, 1, 2].map(
        (i) =>
          ({
            name: 'fake',
            serial: `s${String(i)}`,
            extras: { headers: { [HEADER_RUN_ID]: `R${String(i)}`, [HEADER_CODEC_MESSAGE_ID]: `mh${String(i)}` } },
          }) as unknown as Ably.InboundMessage,
      );
      codec.createDecoder = vi.fn(() => ({
        decode: (msg: Ably.InboundMessage) => {
          const id = (msg.extras as { headers: Record<string, string> }).headers[HEADER_CODEC_MESSAGE_ID] ?? 'unknown';
          return [{ type: 'append-message' as const, message: { id, content: 'x' } }];
        },
      }));

      vi.mocked(decodeHistory).mockResolvedValueOnce(makePage(items, rawMessages));

      await view.loadOlder(2);
      // The newest 2 by startSerial (R1, R2) are revealed; R0 is withheld.
      expect(
        view
          .flattenNodes()
          .map((r) => r.runId)
          .toSorted(),
      ).toEqual(['R1', 'R2']);
      expect(view.hasOlder()).toBe(true);

      // Second loadOlder drains the withheld buffer (R0). decodeHistory is
      // NOT called again — the buffer drain path returns without fetching.
      await view.loadOlder(2);
      expect(
        view
          .flattenNodes()
          .map((r) => r.runId)
          .toSorted(),
      ).toEqual(['R0', 'R1', 'R2']);
      expect(vi.mocked(decodeHistory)).toHaveBeenCalledTimes(1);
    });

    it('suppresses ably-message events for withheld Runs', async () => {
      const items = [0, 1, 2].map((i) => ({
        message: { id: `h${String(i)}`, content: `old-${String(i)}` },
        headers: { [HEADER_RUN_ID]: `R${String(i)}`, [HEADER_CODEC_MESSAGE_ID]: `mh${String(i)}` },
        serial: `s${String(i)}`,
      }));
      const rawMessages = items.map(
        (it) =>
          ({
            name: 'fake',
            serial: it.serial,
            extras: { headers: it.headers },
          }) as unknown as Ably.InboundMessage,
      );
      codec.createDecoder = vi.fn(() => ({
        decode: (msg: Ably.InboundMessage) => {
          const id = (msg.extras as { headers: Record<string, string> }).headers[HEADER_CODEC_MESSAGE_ID] ?? 'unknown';
          return [{ type: 'append-message' as const, message: { id, content: 'x' } }];
        },
      }));

      vi.mocked(decodeHistory).mockResolvedValueOnce(makePage(items, rawMessages));
      await view.loadOlder(2);

      // R0 is withheld at this point. An ably-message for R0 must be
      // suppressed; an ably-message for R1 (visible) must pass through.
      const handler = vi.fn();
      view.on('ably-message', handler);

      const withheldMsg = {
        name: 'fake',
        extras: { headers: { [HEADER_RUN_ID]: 'R0' } },
      } as unknown as Ably.InboundMessage;
      tree.emitAblyMessage(withheldMsg);
      expect(handler).not.toHaveBeenCalled();

      const visibleMsg = {
        name: 'fake',
        extras: { headers: { [HEADER_RUN_ID]: 'R1' } },
      } as unknown as Ably.InboundMessage;
      tree.emitAblyMessage(visibleMsg);
      expect(handler).toHaveBeenCalledWith(visibleMsg);
    });

    // ---------------------------------------------------------------------
    // Pagination edge cases (AIT-773 §7.6)
    // ---------------------------------------------------------------------

    it('handles a Run that spans multiple channel pages by carrying state across decodeHistory.next()', async () => {
      // Simulate a Run R-multi whose messages appear across two channel
      // pages: page1 has the first wire, page2 (via .next()) has the
      // second wire. The Tree folds both into the same RunNode.
      const headersA = { [HEADER_RUN_ID]: 'R-multi', [HEADER_CODEC_MESSAGE_ID]: 'm-multi-a' };
      const headersB = { [HEADER_RUN_ID]: 'R-multi', [HEADER_CODEC_MESSAGE_ID]: 'm-multi-b' };
      const rawA = {
        name: 'fake',
        serial: 's01',
        extras: { headers: headersA },
      } as unknown as Ably.InboundMessage;
      const rawB = {
        name: 'fake',
        serial: 's02',
        extras: { headers: headersB },
      } as unknown as Ably.InboundMessage;

      codec.createDecoder = vi.fn(() => ({
        decode: (msg: Ably.InboundMessage) => {
          const id = (msg.extras as { headers: Record<string, string> }).headers[HEADER_CODEC_MESSAGE_ID] ?? '?';
          return [{ type: 'append-message' as const, message: { id, content: id } }];
        },
      }));

      const page2 = makePage(
        [{ message: { id: 'm-multi-b', content: 'multi-b' }, headers: headersB, serial: 's02' }],
        [rawB],
      );
      const page1 = makePage(
        [{ message: { id: 'm-multi-a', content: 'multi-a' }, headers: headersA, serial: 's01' }],
        [rawA],
        true,
        // eslint-disable-next-line @typescript-eslint/require-await -- mock
        async () => page2,
      );
      vi.mocked(decodeHistory).mockResolvedValueOnce(page1);

      await view.loadOlder(2);

      // The single Run R-multi materialised from both pages; both messages
      // belong to one RunNode.
      const nodes = view.flattenNodes();
      expect(nodes.map((n) => n.runId)).toEqual(['R-multi']);
      expect(view.getMessages().map((m) => m.id)).toEqual(['m-multi-a', 'm-multi-b']);
    });

    it('includes a Run with zero codec-fold output in the visible chain but contributes no messages to getMessages', async () => {
      // History contains an ai-run-start with no subsequent content wires
      // (rare; can happen if the agent crashed before publishing any chunk).
      // The View flattens the Run but getMessages produces nothing for it.
      const runStartMsg = {
        name: EVENT_RUN_START,
        serial: 's01',
        extras: {
          headers: {
            [HEADER_RUN_ID]: 'R-empty',
            'x-ably-run-client-id': '',
          },
        },
      } as unknown as Ably.InboundMessage;

      vi.mocked(decodeHistory).mockResolvedValueOnce(makePage([], [runStartMsg]));

      await view.loadOlder(1);

      const nodes = view.flattenNodes();
      expect(nodes.map((n) => n.runId)).toEqual(['R-empty']);
      expect(view.getMessages()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Close
  // -------------------------------------------------------------------------

  describe('close', () => {
    it('stops forwarding events after close', () => {
      const handler = vi.fn();
      view.on('update', handler);
      view.close();
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      expect(handler).not.toHaveBeenCalled();
    });

    it('invokes onClose hook', () => {
      const onClose = vi.fn();
      const v = new DefaultView({
        tree,
        channel: createMockChannel(),
        codec,
        sendDelegate,
        logger: silentLogger,
        onClose,
      });
      v.close();
      expect(onClose).toHaveBeenCalled();
    });

    it('makes sendEvent reject with InvalidArgument after close', async () => {
      view.close();
      await expect(view.sendEvent({ type: 'user-message', message: { id: 'a', content: 'hi' } })).rejects.toThrow(
        /view is closed/,
      );
    });

    it('makes regenerate reject after close', async () => {
      view.close();
      await expect(view.regenerate('any')).rejects.toThrow(/view is closed/);
    });

    it('makes edit reject after close', async () => {
      view.close();
      await expect(view.edit('any', { type: 'user-message', message: { id: 'a', content: 'x' } })).rejects.toThrow(
        /view is closed/,
      );
    });

    it('is idempotent: double close does not throw and onClose fires once', () => {
      const onClose = vi.fn();
      const v = new DefaultView({
        tree,
        channel: createMockChannel(),
        codec,
        sendDelegate,
        logger: silentLogger,
        onClose,
      });
      v.close();
      expect(() => {
        v.close();
      }).not.toThrow();
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('loadOlder after close is a no-op (no decodeHistory call)', async () => {
      view.close();
      await view.loadOlder(10);
      expect(vi.mocked(decodeHistory)).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Branch auto-select / pending after fork operations
  // -------------------------------------------------------------------------

  describe('branch auto-select after fork', () => {
    beforeEach(() => {
      // role omitted so the user-content wire keeps routing at wire-runId
      // (the role-based sub-Run split is exercised elsewhere). These tests
      // focus on pending / auto-select sibling state after fork operations.
      apply(tree, { runId: 'R1', codecMessageId: 'u1', message: { id: 'a', content: 'q' }, serial: 's1' });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'a1',
        parent: 'u1',
        message: { id: 'b', content: 'reply' },
        serial: 's2',
      });
    });

    it('regenerate sets a pending regenerate selection that resolves when the new Run arrives', async () => {
      vi.mocked(sendDelegate).mockResolvedValueOnce({
        stream: new ReadableStream(),
        runId: 'R2new',
        invocationId: 'inv-new',
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
        cancel: () => Promise.resolve(),
        optimisticCodecMessageIds: [],
        eventIds: [],
      });

      await view.regenerate('a1');
      // Pending selection is recorded but the new Run hasn't arrived yet;
      // the chain is unchanged (R1 + R2).
      expect(view.flattenNodes().map((r) => r.runId)).toEqual(['R1', 'R2']);

      // Now the new continuation Run arrives — regenerates the assistant
      // in R2 (anchored at codec-message-id a1), parented under R2 (the prior Run).
      apply(tree, {
        runId: 'R2new',
        codecMessageId: 'a2',
        parent: 'a1',
        regenerates: 'a1',
        message: { id: 'c', content: 'new-reply' },
        serial: 's3',
      });

      // Pending selection promotes to `auto`. The visible chain now
      // includes R2new (the regenerator) and the message-level replacement
      // hides the original assistant 'a1' from R2 at extraction time.
      expect(view.flattenNodes().map((r) => r.runId)).toEqual(['R1', 'R2', 'R2new']);
    });

    it('pending selection is cleared on run-end when the server never creates the sibling Run', async () => {
      vi.mocked(sendDelegate).mockResolvedValueOnce({
        stream: new ReadableStream(),
        runId: 'R2new',
        invocationId: 'inv-new',
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
        cancel: () => Promise.resolve(),
        optimisticCodecMessageIds: [],
        eventIds: [],
      });

      await view.regenerate('a1');
      // Pending selection is in place; visible chain still shows R2 (only sibling).
      expect(view.flattenNodes().map((r) => r.runId)).toEqual(['R1', 'R2']);

      // Server errors out: run-end arrives for the original prompt's runId
      // without a sibling Run being created.
      tree.applyRunLifecycle({ type: 'ai-run-end', runId: 'R2new', clientId: 'c', reason: 'error' }, 's3');

      // Now an external fork appears. With the pending selection NOT cleaned
      // up, pin-on-external-fork would still pin to R2; with cleanup it
      // adopts the default-latest (R2-late) like any other external fork.
      apply(tree, {
        runId: 'R2-late',
        codecMessageId: 'a-late',
        parent: 'u1',
        forkOf: 'a1',
        message: { id: 'c', content: 'late' },
        serial: 's4',
      });

      // The View pins to the currently-visible sibling (R2) — that's
      // pin-on-external-fork. The key invariant we're testing is that the
      // earlier pending state did not survive and incorrectly latch.
      expect(view.flattenNodes().map((r) => r.runId)).toEqual(['R1', 'R2']);
    });

    it('preserves an explicit `user` branch selection when an external fork lands later', () => {
      // The outer beforeEach already seeded R1 + R2. Add a first external
      // fork (R2alt) so the user has a sibling group to choose in, then
      // assert their explicit selection survives a second external fork.
      apply(tree, {
        runId: 'R2alt',
        codecMessageId: 'a-alt-1',
        parent: 'u1',
        forkOf: 'a1',
        message: { id: 'c', content: 'alt-1' },
        serial: 's3',
      });
      // User explicitly selects R2 (the original).
      view.select('R2', 0);
      expect(view.flattenNodes().map((n) => n.runId)).toEqual(['R1', 'R2']);

      // Another external fork lands.
      apply(tree, {
        runId: 'R2alt-2',
        codecMessageId: 'a-alt-2',
        parent: 'u1',
        forkOf: 'a1',
        message: { id: 'd', content: 'alt-2' },
        serial: 's4',
      });

      // The user's `kind: 'user'` selection survives the external-fork
      // pinning pass; we should still see R2, not the newer sibling.
      expect(view.flattenNodes().map((n) => n.runId)).toEqual(['R1', 'R2']);
    });

    it('keeps an explicit regen selection when another external regen lands afterwards', () => {
      // R1 + R2 already exist (the assistant a1 is in R2 per the
      // describe-block beforeEach). Add a regenerator targeting a1, then
      // verify a user selection back to the original survives a second
      // external regen.
      apply(tree, {
        runId: 'R_regen1',
        codecMessageId: 'a1p',
        parent: 'a1',
        regenerates: 'a1',
        message: { id: 'a1p', content: 'regen' },
        serial: 's3',
      });
      // User explicitly switches to the ORIGINAL alternative (a1 in R2).
      // The codec rebinds TMessage.id to the wire codec-message-id, so the visible
      // ids match the apply()'d codecMessageIds.
      view.selectMessageSibling('a1p', 0);
      expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1']);

      // Another participant publishes a second regenerator at the same
      // canonical anchor.
      apply(tree, {
        runId: 'R_regen2',
        codecMessageId: 'a1pp',
        parent: 'a1',
        regenerates: 'a1',
        message: { id: 'a1pp', content: 'regen-2' },
        serial: 's4',
      });

      // The user's explicit choice survives: visible content is still the
      // original assistant, not either regenerator.
      expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1']);
    });

    it('edit auto-selects the new sibling Run from optimisticCodecMessageIds', async () => {
      vi.mocked(sendDelegate).mockResolvedValueOnce({
        stream: new ReadableStream(),
        runId: 'R2edit',
        invocationId: 'inv-edit',
        // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
        cancel: () => Promise.resolve(),
        optimisticCodecMessageIds: ['u-new'],
        eventIds: [],
      });
      // For the auto-select to land, the new Run needs to exist in the tree.
      // role omitted so the new user-content wire routes at wire-runId.
      apply(tree, {
        runId: 'R2edit',
        codecMessageId: 'u-new',
        parent: 'u1',
        forkOf: 'a1',
        message: { id: 'c', content: 'edited' },
        serial: 's3',
      });
      await view.edit('a1', { type: 'user-message', message: { id: 'c', content: 'edited' } });

      // Auto-select kicks in immediately after the delegate returns.
      expect(view.flattenNodes().map((r) => r.runId)).toEqual(['R1', 'R2edit']);
    });
  });

  // -------------------------------------------------------------------------
  // Regenerate-as-continuation: message-level replacement and branch nav
  // -------------------------------------------------------------------------

  describe('regenerate-as-continuation', () => {
    // R1 holds user1 + asst1 together (one Run per user-visible turn).
    // The regenerator R2 continues R1 (parentRunId=R1) and regenerates
    // asst1's codec-message-id; the View replaces asst1 with R2's content at
    // projection extraction time.
    beforeEach(() => {
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'u1',
        role: 'user',
        message: { id: 'u1', content: 'first' },
        serial: 's1',
      });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'a1',
        role: 'assistant',
        message: { id: 'a1', content: 'reply' },
        serial: 's2',
      });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'a2',
        parent: 'a1',
        regenerates: 'a1',
        role: 'assistant',
        message: { id: 'a2', content: 'regen' },
        serial: 's3',
      });
    });

    it('default visible chain hides the regenerated message and shows the regenerator content', () => {
      // Visible Runs include the owner and the regenerator; the
      // regenerated message-id (a1) is dropped from extraction.
      expect(view.flattenNodes().map((r) => r.runId)).toEqual(['R1', 'R2']);
      expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a2']);
    });

    it('getSelectedIndex defaults to the latest regenerator', () => {
      expect(view.getSelectedIndex('R1')).toBe(1);
      expect(view.getSelectedIndex('R2')).toBe(1);
    });

    it('select(runId, 0) switches the regenerate group to the original — projection extraction shows the original assistant', () => {
      view.select('R2', 0);
      expect(view.flattenNodes().map((r) => r.runId)).toEqual(['R1']);
      expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1']);
      expect(view.getSelectedIndex('R1')).toBe(0);
    });

    it('select(runId, 1) restores the regenerator selection', () => {
      view.select('R2', 0);
      view.select('R1', 1);
      expect(view.flattenNodes().map((r) => r.runId)).toEqual(['R1', 'R2']);
      expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a2']);
    });
  });

  // -------------------------------------------------------------------------
  // Msg-anchored branch-point API (AITRFC-014 — branch points are anchored
  // at codec-message-ids; the View surfaces per-bubble nav rather than per-Run nav so
  // arrows attach only to the actual anchor message).
  // -------------------------------------------------------------------------

  describe('msg-anchored branch nav', () => {
    describe('regenerate', () => {
      beforeEach(() => {
        apply(tree, {
          runId: 'R1',
          codecMessageId: 'u1',
          role: 'user',
          message: { id: 'u1', content: 'first' },
          serial: 's1',
        });
        apply(tree, {
          runId: 'R1',
          codecMessageId: 'a1',
          role: 'assistant',
          message: { id: 'a1', content: 'reply' },
          serial: 's2',
        });
        apply(tree, {
          runId: 'R2',
          codecMessageId: 'a2',
          parent: 'a1',
          regenerates: 'a1',
          role: 'assistant',
          message: { id: 'a2', content: 'regen' },
          serial: 's3',
        });
      });

      it('hasMessageSiblings is false for the user prompt codec-message-id (not an anchor)', () => {
        expect(view.hasMessageSiblings('u1')).toBe(false);
      });

      it('hasMessageSiblings is true for the regen anchor codec-message-id', () => {
        expect(view.hasMessageSiblings('a1')).toBe(true);
      });

      it('hasMessageSiblings is true for a regenerator Run content codec-message-id', () => {
        expect(view.hasMessageSiblings('a2')).toBe(true);
      });

      it('getMessageSiblings returns the resolved regen variants at an anchor codec-message-id', () => {
        expect(view.getMessageSiblings('a1').map((m) => m.id)).toEqual(['a1', 'a2']);
        expect(view.getMessageSiblings('a2').map((m) => m.id)).toEqual(['a1', 'a2']);
      });

      it('getMessageSiblings returns [] for a non-anchor codec-message-id', () => {
        expect(view.getMessageSiblings('u1')).toEqual([]);
      });

      it('selectMessageSibling on the anchor codec-message-id switches the regen selection', () => {
        view.selectMessageSibling('a2', 0);
        expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1']);
        view.selectMessageSibling('a1', 1);
        expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a2']);
      });

      it('selectMessageSibling on a non-anchor codec-message-id is a no-op', () => {
        const before = view.getMessages().map((m) => m.id);
        view.selectMessageSibling('u1', 0);
        expect(view.getMessages().map((m) => m.id)).toEqual(before);
      });
    });

    describe('edit', () => {
      beforeEach(() => {
        // Original Run R1: user prompt + assistant.
        apply(tree, {
          runId: 'R1',
          codecMessageId: 'u1',
          role: 'user',
          message: { id: 'u1', content: 'alpha' },
          serial: 's1',
        });
        apply(tree, {
          runId: 'R1',
          codecMessageId: 'a1',
          role: 'assistant',
          message: { id: 'a1', content: 'reply-alpha' },
          serial: 's2',
        });
        // Edited Run R2: forkOf the original user prompt, new user msg + asst.
        apply(tree, {
          runId: 'R2',
          codecMessageId: 'u2',
          forkOf: 'u1',
          role: 'user',
          message: { id: 'u2', content: 'bravo' },
          serial: 's3',
        });
        apply(tree, {
          runId: 'R2',
          codecMessageId: 'a2',
          role: 'assistant',
          parent: 'u2',
          message: { id: 'a2', content: 'reply-bravo' },
          serial: 's4',
        });
      });

      it('hasMessageSiblings is true for the user prompt codec-message-id (edit anchor)', () => {
        expect(view.hasMessageSiblings('u2')).toBe(true);
      });

      it('hasMessageSiblings is false for the assistant codec-message-id (not an edit anchor)', () => {
        expect(view.hasMessageSiblings('a2')).toBe(false);
      });

      it('getMessageSiblings returns each sibling user-prompt at the edit anchor', () => {
        expect(view.getMessageSiblings('u2').map((m) => m.id)).toEqual(['u1', 'u2']);
      });

      it('selectMessageSibling on the user-prompt anchor swaps the whole Run', () => {
        // Explicitly select R2 first (the edited branch) so the swap to
        // R1 via the anchor is observable independent of the default
        // pinning behaviour.
        view.select('R2', 1);
        view.selectMessageSibling('u2', 0);
        expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1']);
      });

      it('selectMessageSibling on the assistant codec-message-id is a no-op (assistant is not the edit anchor)', () => {
        const before = view.getMessages().map((m) => m.id);
        view.selectMessageSibling('a2', 0);
        expect(view.getMessages().map((m) => m.id)).toEqual(before);
      });
    });

    // ---------------------------------------------------------------------
    // Coexisting edit fork-of AND regenerate groups on the same Run
    // ---------------------------------------------------------------------
    //
    // Scenario: a Run R1 owns both a user prompt (which got edited into a
    // sibling Run R_edit) and an assistant message (which got regenerated
    // into a continuation Run R_regen). R1 is simultaneously in a
    // fork-of sibling group (vs R_edit at the parent's children level)
    // AND in a regenerate sibling group (vs R_regen at the assistant
    // codec-message-id level).
    //
    // Branch nav on R1's assistant must navigate the REGEN group; nav on
    // R1's user prompt must navigate the FORK-OF group. The runId alone
    // is ambiguous — the codec-message-id is the disambiguator.

    describe('regenerate then edit (R1 in both groups)', () => {
      beforeEach(() => {
        // R1 original turn: user1 + asst1.
        apply(tree, {
          runId: 'R1',
          codecMessageId: 'u1',
          role: 'user',
          message: { id: 'u1', content: 'first' },
          serial: 's1',
        });
        apply(tree, {
          runId: 'R1',
          codecMessageId: 'a1',
          role: 'assistant',
          message: { id: 'a1', content: 'reply' },
          serial: 's2',
        });
        // Regenerate produces R_regen — continuation of R1 anchored at a1.
        apply(tree, {
          runId: 'R_regen',
          codecMessageId: 'a1p',
          parent: 'a1',
          regenerates: 'a1',
          role: 'assistant',
          message: { id: 'a1p', content: 'reply-prime' },
          serial: 's3',
        });
        // Edit produces R_edit — Run-level fork of R1 (anchored at u1).
        apply(tree, {
          runId: 'R_edit',
          codecMessageId: 'u2',
          forkOf: 'u1',
          role: 'user',
          message: { id: 'u2', content: 'edited' },
          serial: 's4',
        });
        apply(tree, {
          runId: 'R_edit',
          codecMessageId: 'a2',
          role: 'assistant',
          parent: 'u2',
          message: { id: 'a2', content: 'reply-edited' },
          serial: 's5',
        });
        // Pin to R1 in the fork-of group so the regen nav is exercisable
        // on the visible chain.
        view.select('R1', 0);
      });

      it('hasMessageSiblings disambiguates by codec-message-id: user prompt anchors fork-of, assistant anchors regen', () => {
        // user prompt u1 is the fork-of anchor (first msg of R1).
        expect(view.hasMessageSiblings('u1')).toBe(true);
        // assistant a1 is the regen anchor.
        expect(view.hasMessageSiblings('a1')).toBe(true);
      });

      it('selectMessageSibling on the assistant codec-message-id navigates the REGEN group, not the fork-of group', () => {
        // Start: visible chain shows [P1, R1'] (R1 selected, regen R_regen latest).
        expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1p']);

        // Click `<` on the asst bubble — go to the original R1's asst.
        view.selectMessageSibling('a1p', 0);
        expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1']);

        // Click `>` on the asst bubble — should return to R1' (the regen).
        // BUG: this currently switches the fork-of selection to R_edit
        // and ends up on [u2, a2] instead of [u1, a1p].
        view.selectMessageSibling('a1', 1);
        expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1p']);
      });

      it('selectMessageSibling on the user-prompt codec-message-id navigates the FORK-OF group', () => {
        expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1p']);

        // Click `>` on the user bubble — switch to the edited branch.
        view.selectMessageSibling('u1', 1);
        expect(view.getMessages().map((m) => m.id)).toEqual(['u2', 'a2']);

        // Click `<` to come back.
        view.selectMessageSibling('u2', 0);
        expect(view.getMessages().map((m) => m.id)).toEqual(['u1', 'a1p']);
      });

      it('getSelectedMessageSiblingIndex reports the correct group selection for each codec-message-id', () => {
        // Initial state: fork-of selection = R1 (index 0); regen selection
        // = R_regen (auto, no explicit selection → defaults to latest, index 1).
        expect(view.getSelectedMessageSiblingIndex('u1')).toBe(0);
        expect(view.getSelectedMessageSiblingIndex('a1p')).toBe(1);
      });
    });
  });
});
