import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HEADER_CODEC_MESSAGE_ID,
  HEADER_FORK_OF,
  HEADER_INVOCATION_ID,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_CONTINUE,
  HEADER_RUN_ID,
} from '../../../src/constants.js';
import type { Codec } from '../../../src/core/codec/types.js';
import type { TreeInternal } from '../../../src/core/transport/tree.js';
import { createTree } from '../../../src/core/transport/tree.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';

// ---------------------------------------------------------------------------
// Test codec — minimal projection that appends messages on fold
// ---------------------------------------------------------------------------

interface TestMessage {
  id: string;
  content: string;
}

type TestEvent = { type: 'append-message'; message: TestMessage } | { type: 'noop' } | { type: 'throw' };

interface TestProjection {
  messages: TestMessage[];
}

const testCodec: Codec<TestEvent, TestProjection, TestMessage> = {
  init: () => ({ messages: [] }),
  fold: (state, event, meta) => {
    if (event.type === 'append-message') {
      // Mirror the real codec convention (see _readMessageId in view.ts): a
      // message's `id` is the wire codec-message-id (meta.messageId), so the
      // session projection can be filtered back into per-Run buckets by id.
      const message = meta.messageId === undefined ? event.message : { ...event.message, id: meta.messageId };
      return { messages: [...state.messages, message] };
    }
    if (event.type === 'throw') {
      throw new Error('test fold failure');
    }
    return state;
  },
  getMessages: (projection) => projection.messages,
  dropMessages: (projection, codecMessageIds) => {
    const drop = new Set(codecMessageIds);
    return { messages: projection.messages.filter((m) => !drop.has(m.id)) };
  },
  createEncoder: () => {
    throw new Error('not used in tree tests');
  },
  createDecoder: () => ({ decode: () => [] }),
  userMessageEvent: (message) => ({ type: 'append-message', message }),
  createRegenerateEvent: () => ({ type: 'noop' }),
  classifyEvent: () => ({ kind: 'other' }),
  // eslint-disable-next-line unicorn/no-useless-undefined -- the Codec contract requires returning undefined when no target is resolved
  resolveToolTarget: () => undefined,
  isTerminal: () => false,
};

const silentLogger = makeLogger({ logLevel: LogLevel.Silent });

/** Empty selections — always picks the latest sibling at every fork. */
const NO_SELECTIONS = new Map<string, string>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ApplyOpts {
  runId: string;
  codecMessageId?: string;
  parent?: string;
  forkOf?: string;
  regenerates?: string;
  role?: string;
  invocationId?: string;
  clientId?: string;
  runContinue?: boolean;
  serial?: string;
  message?: TestMessage;
  /** Override events entirely. When set, `message` is ignored. */
  events?: TestEvent[];
}

const apply = (tree: TreeInternal<TestEvent, TestProjection>, opts: ApplyOpts): void => {
  const h: Record<string, string> = { [HEADER_RUN_ID]: opts.runId };
  if (opts.codecMessageId) h[HEADER_CODEC_MESSAGE_ID] = opts.codecMessageId;
  if (opts.parent) h[HEADER_PARENT] = opts.parent;
  if (opts.forkOf) h[HEADER_FORK_OF] = opts.forkOf;
  if (opts.regenerates) h['x-ably-msg-regenerate'] = opts.regenerates;
  if (opts.role) h[HEADER_ROLE] = opts.role;
  if (opts.invocationId) h[HEADER_INVOCATION_ID] = opts.invocationId;
  if (opts.clientId) h[HEADER_RUN_CLIENT_ID] = opts.clientId;
  if (opts.runContinue) h[HEADER_RUN_CONTINUE] = 'true';

  const events: TestEvent[] = opts.events ?? (opts.message ? [{ type: 'append-message', message: opts.message }] : []);
  tree.applyMessage(events, h, opts.serial);
};

/**
 * Bucket the Tree's session-wide projection back into per-Run message lists,
 * mirroring how the View recovers a Run's messages: iterate
 * `getMessages(getProjection())` and group by the owning runId resolved from
 * each message's id (the codec-message-id) via the Tree's index.
 * @param tree - The tree whose session projection to bucket.
 * @returns A map of runId to that Run's messages, in publication order.
 */
const bucketByRun = (tree: TreeInternal<TestEvent, TestProjection>): Map<string, TestMessage[]> => {
  const byRun = new Map<string, TestMessage[]>();
  for (const m of testCodec.getMessages(tree.getProjection())) {
    const runId = tree.getRunByCodecMessageId(m.id)?.runId;
    if (runId === undefined) continue;
    let bucket = byRun.get(runId);
    if (!bucket) {
      bucket = [];
      byRun.set(runId, bucket);
    }
    bucket.push(m);
  }
  return byRun;
};

const messagesOf = (tree: TreeInternal<TestEvent, TestProjection>, runId: string): TestMessage[] =>
  bucketByRun(tree).get(runId) ?? [];

const flatMessages = (
  tree: TreeInternal<TestEvent, TestProjection>,
  selections: Map<string, string> = NO_SELECTIONS,
): TestMessage[] => {
  const byRun = bucketByRun(tree);
  return tree.flattenNodes(selections).flatMap((r) => byRun.get(r.runId) ?? []);
};

const flatRunIds = (
  tree: TreeInternal<TestEvent, TestProjection>,
  selections: Map<string, string> = NO_SELECTIONS,
): string[] => tree.flattenNodes(selections).map((r) => r.runId);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Tree', () => {
  let tree: TreeInternal<TestEvent, TestProjection>;

  beforeEach(() => {
    tree = createTree(testCodec, silentLogger);
  });

  // -------------------------------------------------------------------------
  // Linear conversation
  // -------------------------------------------------------------------------

  describe('linear conversation', () => {
    it('creates a single Run from one message', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      expect(flatRunIds(tree)).toEqual(['R1']);
      // The codec aligns each message's id to the wire codec-message-id, so the
      // session projection buckets back to R1.
      expect(flatMessages(tree)).toEqual([{ id: 'm1', content: 'hi' }]);
    });

    it('creates a chain of Runs in startSerial order', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'first' }, serial: 's1' });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'm2',
        parent: 'm1',
        message: { id: 'b', content: 'second' },
        serial: 's2',
      });
      apply(tree, {
        runId: 'R3',
        codecMessageId: 'm3',
        parent: 'm2',
        message: { id: 'c', content: 'third' },
        serial: 's3',
      });

      expect(flatRunIds(tree)).toEqual(['R1', 'R2', 'R3']);
      expect(flatMessages(tree)).toEqual([
        { id: 'm1', content: 'first' },
        { id: 'm2', content: 'second' },
        { id: 'm3', content: 'third' },
      ]);
    });

    it('resolves parentRunId from parent codec-message-id via codecMessageIdToRunId index', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'q' }, serial: 's1' });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'm2',
        parent: 'm1',
        message: { id: 'b', content: 'a' },
        serial: 's2',
      });
      expect(tree.getRunNode('R2')?.parentRunId).toBe('R1');
    });

    it('returns RunNode via getRunNode', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      const run = tree.getRunNode('R1');
      expect(run).toBeDefined();
      expect(run?.runId).toBe('R1');
      // RunNode is metadata-only now; the Run's messages live in the
      // session-wide projection and are recovered by bucketing on codec-message-id.
      expect(messagesOf(tree, 'R1')).toEqual([{ id: 'm1', content: 'hi' }]);
    });

    it('returns undefined for an unknown runId', () => {
      expect(tree.getRunNode('R-unknown')).toBeUndefined();
    });

    it('returns owning Run via getRunByCodecMessageId', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      expect(tree.getRunByCodecMessageId('m1')?.runId).toBe('R1');
      expect(tree.getRunByCodecMessageId('m-unknown')).toBeUndefined();
    });

    it('drops messages without an x-ably-run-id header', () => {
      tree.applyMessage([{ type: 'append-message', message: { id: 'a', content: 'orphan' } }], {}, 's1');
      expect(tree.flattenNodes(NO_SELECTIONS)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // applyMessage updates
  // -------------------------------------------------------------------------

  describe('applyMessage updates', () => {
    it('folds additional events into an existing Run projection', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'first' }, serial: 's1' });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm2',
        parent: 'm1',
        message: { id: 'b', content: 'second' },
        serial: 's2',
      });

      expect(messagesOf(tree, 'R1')).toEqual([
        { id: 'm1', content: 'first' },
        { id: 'm2', content: 'second' },
      ]);
    });

    it('routes events to the owning Run by codecMessageId (continuation amend)', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'first' }, serial: 's1' });
      // Continuation message stamped under R1 with prior codec-message-id; folds into R1's projection.
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        role: 'user',
        runContinue: true,
        message: { id: 'a', content: 'amended' },
        serial: 's2',
      });

      // Both wires carry codec-message-id m1, so both fold under m1 and bucket to R1.
      expect(messagesOf(tree, 'R1')).toEqual([
        { id: 'm1', content: 'first' },
        { id: 'm1', content: 'amended' },
      ]);
    });

    it('catches fold errors without aborting the apply', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'ok' }, serial: 's1' });
      // Folding a throwing event should not crash applyMessage.
      expect(() => {
        apply(tree, { runId: 'R1', codecMessageId: 'm2', parent: 'm1', events: [{ type: 'throw' }], serial: 's2' });
      }).not.toThrow();
      // Earlier message survives.
      expect(messagesOf(tree, 'R1')).toEqual([{ id: 'm1', content: 'ok' }]);
    });
  });

  // -------------------------------------------------------------------------
  // Session-wide projection
  // -------------------------------------------------------------------------

  describe('session projection', () => {
    it('getProjection folds every Run into one session-wide projection', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'm1', content: 'a' }, serial: 's1' });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'm2',
        parent: 'm1',
        message: { id: 'm2', content: 'b' },
        serial: 's2',
      });
      // A single projection carries both Runs' messages, in publication order.
      expect(testCodec.getMessages(tree.getProjection()).map((m) => m.content)).toEqual(['a', 'b']);
    });

    it('getProjection starts empty', () => {
      expect(testCodec.getMessages(tree.getProjection())).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // startSerial promotion
  // -------------------------------------------------------------------------

  describe('startSerial promotion', () => {
    it('promotes null startSerial to server-assigned serial', () => {
      // Optimistic insert (no serial)
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'optimistic' } });
      expect(tree.getRunNode('R1')?.startSerial).toBeUndefined();

      // Server relay with serial
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        message: { id: 'a', content: 'confirmed' },
        serial: 's10',
      });
      expect(tree.getRunNode('R1')?.startSerial).toBe('s10');
    });

    it('re-sorts after startSerial promotion', () => {
      // R2 arrives first with a serial.
      apply(tree, { runId: 'R2', codecMessageId: 'm2', message: { id: 'b', content: 'second' }, serial: 's2' });
      // R1 optimistic (no serial) — sorts after R2 initially.
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'first' } });
      expect(flatRunIds(tree)).toEqual(['R2', 'R1']);

      // R1 gets its real serial — moves before R2.
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'first' }, serial: 's1' });
      expect(flatRunIds(tree)).toEqual(['R1', 'R2']);
    });

    it('does not demote an existing startSerial when subsequent applyMessage omits it', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'v1' }, serial: 's1' });
      apply(tree, { runId: 'R1', codecMessageId: 'm2', parent: 'm1', message: { id: 'b', content: 'v2' } });
      expect(tree.getRunNode('R1')?.startSerial).toBe('s1');
    });
  });

  // -------------------------------------------------------------------------
  // Out-of-order inserts
  // -------------------------------------------------------------------------

  describe('out-of-order inserts', () => {
    it('produces correct flatten regardless of Run insertion order', () => {
      // Apply in reverse startSerial order.
      apply(tree, {
        runId: 'R3',
        codecMessageId: 'm3',
        parent: 'm2',
        message: { id: 'c', content: 'third' },
        serial: 's3',
      });
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'first' }, serial: 's1' });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'm2',
        parent: 'm1',
        message: { id: 'b', content: 'second' },
        serial: 's2',
      });

      // R3 arrived first with parent=m2, but m2 (R2) hadn't been observed yet,
      // so R3.parentRunId was undefined at create time. The tree resolves
      // parentRunId at creation, not lazily. This is documented behaviour —
      // out-of-order inserts may produce disconnected Run forests when
      // parents arrive late. The fix for that is decode-history's
      // re-ingestion pass; for live channels parents always arrive first.
      // For this test we assert the flatten still includes every Run in
      // startSerial order; reachability is derived from whatever
      // parentRunIds were resolved.
      expect(flatRunIds(tree)).toContain('R1');
      expect(flatRunIds(tree)).toContain('R2');
      expect(flatRunIds(tree)).toContain('R3');
    });

    it('null-startSerial Runs sort after serial-bearing Runs', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'first' }, serial: 's1' });
      // R2 is optimistic.
      apply(tree, { runId: 'R2', codecMessageId: 'm2', parent: 'm1', message: { id: 'b', content: 'second' } });
      expect(flatRunIds(tree)).toEqual(['R1', 'R2']);
    });

    it('null-startSerial Runs sort among themselves by insertion order', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'first' } });
      apply(tree, { runId: 'R2', codecMessageId: 'm2', parent: 'm1', message: { id: 'b', content: 'second' } });
      apply(tree, { runId: 'R3', codecMessageId: 'm3', parent: 'm2', message: { id: 'c', content: 'third' } });
      expect(flatRunIds(tree)).toEqual(['R1', 'R2', 'R3']);
    });
  });

  // -------------------------------------------------------------------------
  // Fork / regeneration
  // -------------------------------------------------------------------------

  describe('fork and regeneration', () => {
    beforeEach(() => {
      // Base chain: R1 (root) → R2 (child of R1).
      // role omitted so the user-content wire keeps routing at wire-runId
      // (the tree's role-based sub-Run split is verified in dedicated tests
      // below). These tests focus on parent/forkOf sibling semantics.
      apply(tree, { runId: 'R1', codecMessageId: 'u1', message: { id: 'a', content: 'user-q' }, serial: 's1' });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'a1',
        parent: 'u1',
        message: { id: 'b', content: 'assistant-v1' },
        serial: 's2',
      });
    });

    it('forkOf creates a sibling Run group sharing parentRunId', () => {
      // Edit: new Run R2' with forkOf pointing at R2's user msg, same parentRunId.
      apply(tree, {
        runId: 'R2alt',
        codecMessageId: 'a2',
        parent: 'u1',
        forkOf: 'a1',
        message: { id: 'c', content: 'assistant-v2' },
        serial: 's3',
      });

      expect(tree.hasSiblingRuns('R2')).toBe(true);
      expect(tree.hasSiblingRuns('R2alt')).toBe(true);

      const siblings = tree.getSiblingRuns('R2');
      expect(siblings).toHaveLength(2);
      expect(siblings.map((s) => s.runId)).toEqual(['R2', 'R2alt']);
    });

    it('default selection picks the latest sibling Run', () => {
      apply(tree, {
        runId: 'R2alt',
        codecMessageId: 'a2',
        parent: 'u1',
        forkOf: 'a1',
        message: { id: 'c', content: 'assistant-v2' },
        serial: 's3',
      });

      // Latest sibling = R2alt → R2 is hidden.
      expect(flatRunIds(tree)).toEqual(['R1', 'R2alt']);
    });

    it('selections map controls which sibling Run is followed', () => {
      apply(tree, {
        runId: 'R2alt',
        codecMessageId: 'a2',
        parent: 'u1',
        forkOf: 'a1',
        message: { id: 'c', content: 'assistant-v2' },
        serial: 's3',
      });

      const groupRoot = tree.getGroupRoot('R2');
      const selections = new Map([[groupRoot, 'R2']]);
      expect(flatRunIds(tree, selections)).toEqual(['R1', 'R2']);
    });

    it('stale selection runId falls back to latest sibling', () => {
      apply(tree, {
        runId: 'R2alt',
        codecMessageId: 'a2',
        parent: 'u1',
        forkOf: 'a1',
        message: { id: 'c', content: 'v2' },
        serial: 's3',
      });

      const groupRoot = tree.getGroupRoot('R2');
      const stale = new Map([[groupRoot, 'R-nonexistent']]);
      expect(flatRunIds(tree, stale)).toEqual(['R1', 'R2alt']);
    });

    it('multiple forks create a larger sibling group', () => {
      apply(tree, {
        runId: 'R2alt',
        codecMessageId: 'a2',
        parent: 'u1',
        forkOf: 'a1',
        message: { id: 'c', content: 'v2' },
        serial: 's3',
      });
      apply(tree, {
        runId: 'R2alt2',
        codecMessageId: 'a3',
        parent: 'u1',
        forkOf: 'a1',
        message: { id: 'd', content: 'v3' },
        serial: 's4',
      });

      const siblings = tree.getSiblingRuns('R2');
      expect(siblings.map((s) => s.runId)).toEqual(['R2', 'R2alt', 'R2alt2']);
    });

    it('transitive forkOf chain: alt2 forks alt1 which forks the original', () => {
      // Sibling group at R1's children, built as a chain:
      //   R2alt forks R2 (the original assistant a1)
      //   R2alt2 forks R2alt's assistant message (a2)
      // Group root is R2 (R2alt's forkOf is R2; R2alt2's forkOf is R2alt
      // which transitively roots at R2).
      apply(tree, {
        runId: 'R2alt',
        codecMessageId: 'a2',
        parent: 'u1',
        forkOf: 'a1',
        message: { id: 'c', content: 'v2' },
        serial: 's3',
      });
      apply(tree, {
        runId: 'R2alt2',
        codecMessageId: 'a3',
        parent: 'u1',
        forkOf: 'a2',
        message: { id: 'd', content: 'v3' },
        serial: 's4',
      });

      expect(tree.getRunNode('R2alt')?.forkOf).toBe('R2');
      expect(tree.getRunNode('R2alt2')?.forkOf).toBe('R2alt');
      expect(tree.getGroupRoot('R2alt2')).toBe('R2');
      expect(tree.getSiblingRuns('R2alt2').map((s) => s.runId)).toEqual(['R2', 'R2alt', 'R2alt2']);
    });

    it('cycle in forkOf chain is detected and does not infinite-loop', () => {
      // Construct a malformed pair where Ra and Rb forkOf each other's
      // codec-message-id. The Tree's sibling walk must terminate.
      apply(tree, {
        runId: 'Ra',
        codecMessageId: 'ma',
        parent: 'u1',
        forkOf: 'mb',
        message: { id: 'c', content: 'va' },
        serial: 's3',
      });
      apply(tree, {
        runId: 'Rb',
        codecMessageId: 'mb',
        parent: 'u1',
        forkOf: 'ma',
        message: { id: 'd', content: 'vb' },
        serial: 's4',
      });

      // Both calls return without hanging; the exact membership depends on
      // walk-order, but the call terminates and includes both.
      const siblings = tree.getSiblingRuns('Ra').map((s) => s.runId);
      expect(siblings).toContain('Ra');
      expect(siblings.length).toBeGreaterThan(0);
    });

    it('descendants of non-selected sibling Run are excluded from flatten', () => {
      apply(tree, {
        runId: 'R2alt',
        codecMessageId: 'a2',
        parent: 'u1',
        forkOf: 'a1',
        message: { id: 'c', content: 'v2' },
        serial: 's3',
      });
      // Descendant of R2alt
      apply(tree, {
        runId: 'R3alt',
        codecMessageId: 'a3',
        parent: 'a2',
        message: { id: 'd', content: 'after-v2' },
        serial: 's4',
      });
      // Descendant of R2 (original)
      apply(tree, {
        runId: 'R3',
        codecMessageId: 'a4',
        parent: 'a1',
        message: { id: 'e', content: 'after-v1' },
        serial: 's5',
      });

      // Default: latest sibling R2alt is selected, R3alt is its descendant.
      expect(flatRunIds(tree)).toEqual(['R1', 'R2alt', 'R3alt']);

      // Select original R2 → R3 (its descendant) becomes visible, R3alt hidden.
      const groupRoot = tree.getGroupRoot('R2');
      const selections = new Map([[groupRoot, 'R2']]);
      expect(flatRunIds(tree, selections)).toEqual(['R1', 'R2', 'R3']);
    });

    it('getGroupRoot returns the original Run in a fork chain', () => {
      apply(tree, {
        runId: 'R2alt',
        codecMessageId: 'a2',
        parent: 'u1',
        forkOf: 'a1',
        message: { id: 'c', content: 'v2' },
        serial: 's3',
      });
      expect(tree.getGroupRoot('R2')).toBe('R2');
      expect(tree.getGroupRoot('R2alt')).toBe('R2');
    });

    it('getGroupRoot returns the runId itself for non-forked Runs', () => {
      expect(tree.getGroupRoot('R1')).toBe('R1');
    });

    it('getSiblingRuns returns empty for an unknown runId', () => {
      expect(tree.getSiblingRuns('R-unknown')).toEqual([]);
    });

    it('hasSiblingRuns is false for a Run with no forks', () => {
      expect(tree.hasSiblingRuns('R1')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Regenerate groups (message-level)
  // -------------------------------------------------------------------------

  describe('regenerate groups', () => {
    it('records regeneratesCodecMessageId from the wire header', () => {
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'a1',
        role: 'assistant',
        message: { id: 'asst1', content: 'reply' },
        serial: 's1',
      });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'a2',
        parent: 'a1',
        regenerates: 'a1',
        role: 'assistant',
        message: { id: 'asst2', content: 'reply-2' },
        serial: 's2',
      });
      expect(tree.getRunNode('R2')?.regeneratesCodecMessageId).toBe('a1');
    });

    it('getRegenerateGroupByMsgId returns owner first, then regenerators by serial', () => {
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'a1',
        role: 'assistant',
        message: { id: 'asst1', content: 'reply' },
        serial: 's1',
      });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'a2',
        parent: 'a1',
        regenerates: 'a1',
        role: 'assistant',
        message: { id: 'asst2', content: 'reply-2' },
        serial: 's3',
      });
      apply(tree, {
        runId: 'R3',
        codecMessageId: 'a3',
        parent: 'a1',
        regenerates: 'a1',
        role: 'assistant',
        message: { id: 'asst3', content: 'reply-3' },
        serial: 's5',
      });
      const group = tree.getRegenerateGroupByMsgId('a1');
      expect(group.map((r) => r.runId)).toEqual(['R1', 'R2', 'R3']);
    });

    it('getRegenerateGroup(runId) resolves the group for a regenerator', () => {
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'a1',
        role: 'assistant',
        message: { id: 'asst1', content: 'reply' },
        serial: 's1',
      });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'a2',
        parent: 'a1',
        regenerates: 'a1',
        role: 'assistant',
        message: { id: 'asst2', content: 'reply-2' },
        serial: 's2',
      });
      const result = tree.getRegenerateGroup('R2');
      expect(result?.anchorCodecMessageId).toBe('a1');
      expect(result?.runs.map((r) => r.runId)).toEqual(['R1', 'R2']);
    });

    it('getRegenerateGroup(runId) resolves the group for the owner Run', () => {
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'a1',
        role: 'assistant',
        message: { id: 'asst1', content: 'reply' },
        serial: 's1',
      });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'a2',
        parent: 'a1',
        regenerates: 'a1',
        role: 'assistant',
        message: { id: 'asst2', content: 'reply-2' },
        serial: 's2',
      });
      const result = tree.getRegenerateGroup('R1');
      expect(result?.anchorCodecMessageId).toBe('a1');
      expect(result?.runs.map((r) => r.runId)).toEqual(['R1', 'R2']);
    });

    it('getRegenerateGroup(runId) returns undefined when neither end of the group is present', () => {
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'a1',
        message: { id: 'asst1', content: 'reply' },
        serial: 's1',
      });
      expect(tree.getRegenerateGroup('R1')).toBeUndefined();
    });

    it('delete(runId) on a regenerator removes it from the regenerate index', () => {
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'a1',
        role: 'assistant',
        message: { id: 'asst1', content: 'reply' },
        serial: 's1',
      });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'a2',
        parent: 'a1',
        regenerates: 'a1',
        role: 'assistant',
        message: { id: 'asst2', content: 'reply-2' },
        serial: 's2',
      });
      tree.delete('R2');
      expect(tree.getRegenerateGroupByMsgId('a1').map((r) => r.runId)).toEqual(['R1']);
      expect(tree.getRegenerateGroup('R1')).toBeUndefined();
    });

    it('records regenerates field from run-start lifecycle when no prior wire arrived', () => {
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'a1',
        role: 'assistant',
        message: { id: 'asst1', content: 'reply' },
        serial: 's1',
      });
      tree.applyRunLifecycle(
        { type: 'ai-run-start', runId: 'R2', clientId: 'c1', invocationId: '', parent: 'a1', regenerates: 'a1' },
        's2',
      );
      expect(tree.getRunNode('R2')?.regeneratesCodecMessageId).toBe('a1');
      expect(tree.getRegenerateGroupByMsgId('a1').map((r) => r.runId)).toEqual(['R1', 'R2']);
    });

    it('backfills regenerates from run-start when the assistant wire raced ahead without the header', () => {
      // Race scenario: the assistant wire for R2 arrives BEFORE run-start
      // (e.g. history pagination boundary or out-of-order delivery), so
      // _createRunFromHeaders creates R2 without the regenerate metadata.
      // applyRunLifecycle must backfill the missing field once run-start
      // arrives — the alternative is the Run permanently lacking its
      // regenerate anchor.
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'a1',
        role: 'assistant',
        message: { id: 'asst1', content: 'reply' },
        serial: 's1',
      });
      // R2's assistant wire arrives WITHOUT x-ably-msg-regenerate.
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'a2',
        role: 'assistant',
        message: { id: 'asst2', content: 'regen' },
        serial: 's2',
      });
      expect(tree.getRunNode('R2')?.regeneratesCodecMessageId).toBeUndefined();
      // run-start arrives later with the canonical metadata.
      tree.applyRunLifecycle(
        { type: 'ai-run-start', runId: 'R2', clientId: 'c1', invocationId: '', parent: 'a1', regenerates: 'a1' },
        's3',
      );
      expect(tree.getRunNode('R2')?.regeneratesCodecMessageId).toBe('a1');
      // The regenerate index now reflects the backfilled anchor too.
      expect(tree.getRegenerateGroupByMsgId('a1').map((r) => r.runId)).toEqual(['R1', 'R2']);
    });

    it('backfills parentRunId from run-start when the assistant wire raced ahead of run-start', () => {
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'u1',
        role: 'user',
        message: { id: 'user1', content: 'q' },
        serial: 's1',
      });
      // R2's first wire (assistant) arrives WITHOUT x-ably-parent.
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'a2',
        role: 'assistant',
        message: { id: 'asst2', content: 'reply' },
        serial: 's2',
      });
      expect(tree.getRunNode('R2')?.parentRunId).toBeUndefined();
      // run-start carries the parent header pointing at u1.
      tree.applyRunLifecycle(
        { type: 'ai-run-start', runId: 'R2', clientId: 'c1', invocationId: '', parent: 'u1' },
        's3',
      );
      expect(tree.getRunNode('R2')?.parentRunId).toBe('R1');
    });

    it('backfills parent and forkOf the same way for edit runs that raced ahead of run-start', () => {
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'u1',
        role: 'user',
        message: { id: 'user1', content: 'q' },
        serial: 's1',
      });
      // R2's user wire arrives WITHOUT x-ably-parent / x-ably-fork-of.
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'u2',
        role: 'user',
        message: { id: 'user2', content: 'q-edit' },
        serial: 's2',
      });
      expect(tree.getRunNode('R2')?.parentRunId).toBeUndefined();
      expect(tree.getRunNode('R2')?.forkOf).toBeUndefined();
      // run-start carries the canonical edit metadata.
      tree.applyRunLifecycle(
        { type: 'ai-run-start', runId: 'R2', clientId: 'c1', invocationId: '', forkOf: 'u1' },
        's3',
      );
      expect(tree.getRunNode('R2')?.forkOf).toBe('R1');
    });

    it('continuation run-starts do not backfill parent into a self-cycle when the parent msg-id belongs to the same Run', () => {
      // Repro for the user-reported regression where a client-side tool
      // resolution (or approval) made both the user prompt and the
      // assistant bubble disappear:
      //   1. User sends u1 -> R1 created, R1.parentRunId = undefined (root run).
      //   2. Agent streams a1 inside R1.
      //   3. Client publishes a tool-resolution continuation wire stamped
      //      with x-ably-msg-id=a1, x-ably-parent=a1, x-ably-run-continue=true.
      //   4. Agent's continuation run-start arrives carrying parent=a1
      //      (read from the matched continuation wire's headers).
      //   5. Pre-fix the backfill resolved msgIdToRunId[a1] = R1 and set
      //      R1.parentRunId = R1 — a self-parent cycle — so flattenNodes()
      //      filtered R1 out as unreachable and the View showed nothing.
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
        message: { id: 'a1', content: 'calling tool' },
        serial: 's2',
      });
      expect(tree.getRunNode('R1')?.parentRunId).toBeUndefined();

      tree.applyRunLifecycle(
        {
          type: 'ai-run-start',
          runId: 'R1',
          clientId: 'c1',
          invocationId: 'inv-2',
          parent: 'a1',
          isContinuation: true,
        },
        's3',
      );

      expect(tree.getRunNode('R1')?.parentRunId).toBeUndefined();
      const flat = tree.flattenNodes(new Map());
      expect(flat.map((n) => n.runId)).toEqual(['R1']);
    });
  });

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  describe('delete', () => {
    it('removes a Run from flatten', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'first' }, serial: 's1' });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'm2',
        parent: 'm1',
        message: { id: 'b', content: 'second' },
        serial: 's2',
      });

      tree.delete('R2');
      expect(flatRunIds(tree)).toEqual(['R1']);
    });

    it('removes the Run from getRunNode', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      tree.delete('R1');
      expect(tree.getRunNode('R1')).toBeUndefined();
    });

    it('getRunByCodecMessageId returns undefined after the owning Run is deleted', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      expect(tree.getRunByCodecMessageId('m1')?.runId).toBe('R1');
      tree.delete('R1');
      // delete() clears the deleted Run's codec-message-id index entries as
      // part of evicting its messages from the session projection, so the
      // lookup returns undefined now that the owning Run is gone.
      expect(tree.getRunByCodecMessageId('m1')).toBeUndefined();
    });

    it('descendants become unreachable after parent Run delete', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'root' }, serial: 's1' });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'm2',
        parent: 'm1',
        message: { id: 'b', content: 'child' },
        serial: 's2',
      });
      apply(tree, {
        runId: 'R3',
        codecMessageId: 'm3',
        parent: 'm2',
        message: { id: 'c', content: 'grandchild' },
        serial: 's3',
      });

      tree.delete('R1');
      // Children still exist but are unreachable via flatten.
      expect(flatRunIds(tree)).toEqual([]);
      expect(tree.getRunNode('R2')).toBeDefined();
      expect(tree.getRunNode('R3')).toBeDefined();
    });

    it('is a no-op for an unknown runId', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      tree.delete('R-unknown');
      expect(flatRunIds(tree)).toEqual(['R1']);
    });

    it('shrinks the sibling group after deleting a sibling', () => {
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
      apply(tree, {
        runId: 'R2alt',
        codecMessageId: 'a2',
        parent: 'u1',
        forkOf: 'a1',
        message: { id: 'c', content: 'v2' },
        serial: 's3',
      });

      expect(tree.getSiblingRuns('R2')).toHaveLength(2);
      tree.delete('R2alt');
      expect(tree.getSiblingRuns('R2')).toHaveLength(1);
      expect(tree.hasSiblingRuns('R2')).toBe(false);
    });

    it('evicts the deleted Run from the session projection, leaving other Runs intact', () => {
      // With one shared projection a deleted Run's messages would otherwise
      // linger in getProjection() (previously the Run's own projection was
      // discarded with the node). delete() must drop them via
      // codec.dropMessages while leaving every other Run untouched.
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'm1', content: 'keep' }, serial: 's1' });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'm2',
        parent: 'm1',
        message: { id: 'm2', content: 'drop' },
        serial: 's2',
      });
      expect(testCodec.getMessages(tree.getProjection()).map((m) => m.content)).toEqual(['keep', 'drop']);

      tree.delete('R2');

      expect(testCodec.getMessages(tree.getProjection()).map((m) => m.content)).toEqual(['keep']);
      expect(messagesOf(tree, 'R2')).toEqual([]);
      expect(messagesOf(tree, 'R1').map((m) => m.content)).toEqual(['keep']);
    });
  });

  // -------------------------------------------------------------------------
  // Run lifecycle (applyRunLifecycle)
  // -------------------------------------------------------------------------

  describe('run lifecycle', () => {
    it('run-start creates a Run with status active when none exists', () => {
      tree.applyRunLifecycle({ type: 'ai-run-start', runId: 'R1', clientId: 'client-a', invocationId: '' }, 's1');
      const run = tree.getRunNode('R1');
      expect(run?.status).toBe('active');
      expect(run?.startSerial).toBe('s1');
      // clientId is set on the RunNode itself, sourced from event.clientId.
      expect(run?.clientId).toBe('client-a');
    });

    it('run-start activates an existing Run created from message headers', () => {
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        clientId: 'client-a',
        message: { id: 'a', content: 'hi' },
        serial: 's1',
      });

      // RunNode.clientId was populated from the x-ably-run-client-id header
      // on Run creation; run-start does not overwrite it.
      expect(tree.getRunNode('R1')?.clientId).toBe('client-a');

      tree.applyRunLifecycle({ type: 'ai-run-start', runId: 'R1', clientId: 'client-a', invocationId: '' }, 's2');
      expect(tree.getRunNode('R1')?.status).toBe('active');
      expect(tree.getRunNode('R1')?.clientId).toBe('client-a');
    });

    it('run-end sets RunNode status and endSerial', () => {
      tree.applyRunLifecycle({ type: 'ai-run-start', runId: 'R1', clientId: 'client-a', invocationId: '' }, 's1');
      tree.applyRunLifecycle({ type: 'ai-run-end', runId: 'R1', clientId: 'client-a', reason: 'complete' }, 's10');
      const run = tree.getRunNode('R1');
      expect(run?.status).toBe('complete');
      expect(run?.endSerial).toBe('s10');
    });

    it('emits a run event on both start and end', () => {
      const handler = vi.fn();
      tree.on('run', handler);
      tree.applyRunLifecycle({ type: 'ai-run-start', runId: 'R1', clientId: 'client-a', invocationId: '' }, 's1');
      tree.applyRunLifecycle({ type: 'ai-run-end', runId: 'R1', clientId: 'client-a', reason: 'complete' }, 's2');
      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: 'ai-run-start', runId: 'R1' }));
      expect(handler).toHaveBeenNthCalledWith(2, expect.objectContaining({ type: 'ai-run-end', runId: 'R1' }));
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('empty tree returns empty flatten', () => {
      expect(flatRunIds(tree)).toEqual([]);
    });

    it('handles Runs with the same startSerial by insertion order', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'first' }, serial: 's1' });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'm2',
        parent: 'm1',
        message: { id: 'b', content: 'second' },
        serial: 's1',
      });
      expect(flatRunIds(tree)).toEqual(['R1', 'R2']);
    });

    it('applyMessage with an empty events array does not create a phantom Run (skipped)', () => {
      // Wire-only metadata-carrier messages (e.g. `ait-regenerate` whose
      // decoder produces zero events) must not create empty Runs in the
      // tree. The eventual assistant Run is created by run-start; if a
      // phantom Run lingered, it would inflate sibling-group counts.
      apply(tree, { runId: 'R1', codecMessageId: 'm1', events: [], serial: 's1' });
      expect(tree.getRunNode('R1')).toBeUndefined();
    });

    it('applyMessage with empty events folds into an existing Run if present', () => {
      // Existing Run case: subsequent empty-events apply is a no-op but
      // the Run is unaffected (still in the tree, projection unchanged).
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      const before = messagesOf(tree, 'R1');
      apply(tree, { runId: 'R1', codecMessageId: 'm2', events: [], serial: 's2' });
      expect(tree.getRunNode('R1')).toBeDefined();
      expect(messagesOf(tree, 'R1')).toEqual(before);
    });
  });

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  describe('events', () => {
    it('emits update when applyMessage creates a new Run', () => {
      const handler = vi.fn();
      tree.on('update', handler);
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      expect(handler).toHaveBeenCalled();
    });

    it('emits projection-updated after a successful fold', () => {
      const handler = vi.fn();
      tree.on('projection-updated', handler);
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      expect(handler).toHaveBeenCalledWith({ runId: 'R1' });
    });

    it('emits update on delete', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      const handler = vi.fn();
      tree.on('update', handler);
      tree.delete('R1');
      expect(handler).toHaveBeenCalled();
    });

    it('emits update on run-start / run-end', () => {
      const handler = vi.fn();
      tree.on('update', handler);
      tree.applyRunLifecycle({ type: 'ai-run-start', runId: 'R1', clientId: 'c', invocationId: '' }, 's1');
      tree.applyRunLifecycle({ type: 'ai-run-end', runId: 'R1', clientId: 'c', reason: 'complete' }, 's2');
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('unsubscribe stops delivery', () => {
      const handler = vi.fn();
      const unsub = tree.on('update', handler);
      unsub();
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      expect(handler).not.toHaveBeenCalled();
    });

    it('emitAblyMessage forwards raw messages to ably-message subscribers', () => {
      const handler = vi.fn();
      tree.on('ably-message', handler);
      // Cast: the test doesn't need a fully-typed Ably.InboundMessage.
      const fakeMsg = { name: 'fake', data: 'x' } as unknown as Parameters<typeof tree.emitAblyMessage>[0];
      tree.emitAblyMessage(fakeMsg);
      expect(handler).toHaveBeenCalledWith(fakeMsg);
    });
  });

  // -------------------------------------------------------------------------
  // Winning invocation map
  // -------------------------------------------------------------------------

  describe('winning invocation map', () => {
    it('records the first user-message as the winner', () => {
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        role: 'user',
        invocationId: 'inv-1',
        message: { id: 'a', content: 'hi' },
        serial: 's1',
      });
      expect(tree.getWinningInvocation('R1')).toEqual({ invocationId: 'inv-1', serial: 's1' });
    });

    it('returns undefined for an unknown runId', () => {
      expect(tree.getWinningInvocation('R-unknown')).toBeUndefined();
    });

    it('replaces the winner when a higher-serial user-message arrives', () => {
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        role: 'user',
        invocationId: 'inv-1',
        message: { id: 'a', content: 'q' },
        serial: 's5',
      });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm2',
        role: 'user',
        invocationId: 'inv-2',
        message: { id: 'b', content: 'q' },
        serial: 's7',
      });
      expect(tree.getWinningInvocation('R1')).toEqual({ invocationId: 'inv-2', serial: 's7' });
    });

    it('keeps the existing winner when a lower-serial user-message arrives later', () => {
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm2',
        role: 'user',
        invocationId: 'inv-2',
        message: { id: 'b', content: 'q' },
        serial: 's7',
      });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        role: 'user',
        invocationId: 'inv-1',
        message: { id: 'a', content: 'q' },
        serial: 's5',
      });
      expect(tree.getWinningInvocation('R1')).toEqual({ invocationId: 'inv-2', serial: 's7' });
    });

    it('ignores optimistic (null-serial) user-messages', () => {
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        role: 'user',
        invocationId: 'inv-1',
        message: { id: 'a', content: 'q' },
      });
      expect(tree.getWinningInvocation('R1')).toBeUndefined();
    });

    it('ignores assistant-role messages', () => {
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        role: 'assistant',
        invocationId: 'inv-x',
        message: { id: 'a', content: 'reply' },
        serial: 's1',
      });
      expect(tree.getWinningInvocation('R1')).toBeUndefined();
    });

    it('ignores continuation wires (x-ably-run-continue: true)', () => {
      // Original user prompt sets the winner at s1.
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        role: 'user',
        invocationId: 'inv-1',
        message: { id: 'a', content: 'q' },
        serial: 's1',
      });
      // Continuation tool-resolution wire at a higher serial should NOT
      // supersede the original prompt's invocation.
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        role: 'user',
        invocationId: 'inv-2',
        runContinue: true,
        message: { id: 'b', content: 'tool-result' },
        serial: 's5',
      });
      expect(tree.getWinningInvocation('R1')).toEqual({ invocationId: 'inv-1', serial: 's1' });
    });

    it('continuation wires still fold into the projection even though they skip the winner', () => {
      // Under "Run = user + assistant together", both the original prompt
      // and the continuation tool-resolution wire fold into the same Run.
      // The winner-rule keeps the original prompt as the canonical
      // invocation while still letting the continuation wire produce its
      // amend.
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        role: 'user',
        invocationId: 'inv-1',
        message: { id: 'a', content: 'q' },
        serial: 's1',
      });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        role: 'user',
        invocationId: 'inv-2',
        runContinue: true,
        message: { id: 'b', content: 'tool-result' },
        serial: 's5',
      });

      expect(messagesOf(tree, 'R1')).toEqual([
        { id: 'm1', content: 'q' },
        { id: 'm1', content: 'tool-result' },
      ]);
    });

    it('drops losing-invocation events under the session projection', () => {
      // The two user-prompt wires share the same Run. The first wire (inv-1)
      // arrives, becomes the provisional winner, and folds. A higher-serial
      // wire (inv-2) promotes a new winner; with one session-wide projection
      // the winner promotion evicts inv-1's already-folded messages via
      // codec.dropMessages before folding inv-2. The late assistant wire
      // belongs to the losing invocation (inv-1) and is filtered by the
      // loser-skip at fold time.
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        role: 'user',
        invocationId: 'inv-1',
        message: { id: 'a', content: 'first-prompt' },
        serial: 's1',
      });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm2',
        role: 'user',
        invocationId: 'inv-2',
        message: { id: 'b', content: 'second-prompt' },
        serial: 's5',
      });
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm3',
        role: 'assistant',
        invocationId: 'inv-1',
        message: { id: 'c', content: 'should-be-dropped' },
        serial: 's7',
      });

      // Only the winning invocation's user-prompt survives in R1; the
      // losing prompt was evicted from the session projection on winner
      // change, and the late losing assistant never folded.
      const folded = messagesOf(tree, 'R1');
      expect(folded.map((m) => m.content)).toEqual(['second-prompt']);
    });

    it('winner flip evicts only the deposed invocation, never another Run', () => {
      // R0 is an unrelated Run. Its message must survive a winner flip in R1
      // — the session-wide property a per-Run projection = init() reset could
      // not provide (it would wipe everything sharing the projection).
      apply(tree, {
        runId: 'R0',
        codecMessageId: 'm0',
        role: 'user',
        invocationId: 'inv-0',
        message: { id: 'm0', content: 'other-run' },
        serial: 's1',
      });
      // R1's loser invocation folds first.
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        parent: 'm0',
        role: 'user',
        invocationId: 'inv-1',
        message: { id: 'm1', content: 'loser' },
        serial: 's2',
      });
      expect(messagesOf(tree, 'R1').map((m) => m.content)).toEqual(['loser']);

      // A higher-serial winner arrives under the same runId, deposing inv-1.
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm2',
        parent: 'm0',
        role: 'user',
        invocationId: 'inv-2',
        message: { id: 'm2', content: 'winner' },
        serial: 's5',
      });

      // The loser's message is gone from R1; the winner's remains.
      expect(messagesOf(tree, 'R1').map((m) => m.content)).toEqual(['winner']);
      // The unrelated Run is untouched.
      expect(messagesOf(tree, 'R0').map((m) => m.content)).toEqual(['other-run']);
      // And the deposed message is gone from the session projection entirely.
      expect(testCodec.getMessages(tree.getProjection()).map((m) => m.content)).toEqual(['other-run', 'winner']);
    });

    it('tracks distinct runIds independently', () => {
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        role: 'user',
        invocationId: 'inv-1',
        message: { id: 'a', content: 'q' },
        serial: 's1',
      });
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'm2',
        parent: 'm1',
        role: 'user',
        invocationId: 'inv-2',
        message: { id: 'b', content: 'q' },
        serial: 's2',
      });
      expect(tree.getWinningInvocation('R1')).toEqual({ invocationId: 'inv-1', serial: 's1' });
      expect(tree.getWinningInvocation('R2')).toEqual({ invocationId: 'inv-2', serial: 's2' });
    });

    it('emits invocation-winner-changed when the winner is set or replaced', () => {
      const handler = vi.fn();
      tree.on('invocation-winner-changed', handler);
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        role: 'user',
        invocationId: 'inv-1',
        message: { id: 'a', content: 'q' },
        serial: 's5',
      });
      expect(handler).toHaveBeenCalledWith({ runId: 'R1', invocationId: 'inv-1', serial: 's5' });
      handler.mockClear();
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm2',
        role: 'user',
        invocationId: 'inv-2',
        message: { id: 'b', content: 'q' },
        serial: 's7',
      });
      expect(handler).toHaveBeenCalledWith({ runId: 'R1', invocationId: 'inv-2', serial: 's7' });
    });

    it('does not emit invocation-winner-changed for optimistic inserts', () => {
      const handler = vi.fn();
      tree.on('invocation-winner-changed', handler);
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        role: 'user',
        invocationId: 'inv-1',
        message: { id: 'a', content: 'q' },
      });
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
