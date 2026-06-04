import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HEADER_CODEC_MESSAGE_ID,
  HEADER_FORK_OF,
  HEADER_INPUT_CODEC_MESSAGE_ID,
  HEADER_INVOCATION_ID,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_RUN_CLIENT_ID,
  HEADER_RUN_CONTINUE,
  HEADER_RUN_ID,
} from '../../../src/constants.js';
import type { Codec, CodecInputEvent } from '../../../src/core/codec/types.js';
import type { TreeInternal } from '../../../src/core/transport/tree.js';
import { createTree } from '../../../src/core/transport/tree.js';
import type { ConversationNode, InputNode } from '../../../src/core/transport/types.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';

// ---------------------------------------------------------------------------
// Test codec — minimal projection that appends messages on fold
// ---------------------------------------------------------------------------

interface TestMessage {
  id: string;
  content: string;
}

interface TestInput extends CodecInputEvent {
  kind: 'append-input';
  message: TestMessage;
}

type TestOutput = { type: 'append-message'; message: TestMessage } | { type: 'noop' } | { type: 'throw' };

interface TestProjection {
  messages: TestMessage[];
}

const testCodec: Codec<TestInput, TestOutput, TestProjection, TestMessage> = {
  init: () => ({ messages: [] }),
  fold: (state: TestProjection, event: TestInput | TestOutput) => {
    if ('type' in event) {
      if (event.type === 'append-message') {
        return { messages: [...state.messages, event.message] };
      }
      if (event.type === 'throw') {
        throw new Error('test fold failure');
      }
      return state;
    }
    // TestInput has a single variant — `append-input` — so the narrow check
    // is sufficient; the fold appends the carried message to the projection.
    return { messages: [...state.messages, event.message] };
  },
  getMessages: (projection: TestProjection) => projection.messages,
  createEncoder: () => {
    throw new Error('not used in tree tests');
  },
  createDecoder: () => ({ decode: () => ({ inputs: [], outputs: [] }) }),
  createUserMessage: (message: TestMessage) => ({ kind: 'user-message', message }),
  createRegenerate: (target: string, parent: string) => ({ kind: 'regenerate', target, parent }),
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
  inputCodecMessageId?: string;
  serial?: string;
  message?: TestMessage;
  /** Override events entirely. When set, `message` is ignored. */
  events?: (TestInput | TestOutput)[];
}

type TreeEvent = TestInput | TestOutput;

const apply = (tree: TreeInternal<TestInput, TestOutput, TestProjection>, opts: ApplyOpts): void => {
  const h: Record<string, string> = { [HEADER_RUN_ID]: opts.runId };
  if (opts.codecMessageId) h[HEADER_CODEC_MESSAGE_ID] = opts.codecMessageId;
  if (opts.parent) h[HEADER_PARENT] = opts.parent;
  if (opts.forkOf) h[HEADER_FORK_OF] = opts.forkOf;
  if (opts.regenerates) h['msg-regenerate'] = opts.regenerates;
  if (opts.role) h[HEADER_ROLE] = opts.role;
  if (opts.invocationId) h[HEADER_INVOCATION_ID] = opts.invocationId;
  if (opts.clientId) h[HEADER_RUN_CLIENT_ID] = opts.clientId;
  if (opts.runContinue) h[HEADER_RUN_CONTINUE] = 'true';
  if (opts.inputCodecMessageId) h[HEADER_INPUT_CODEC_MESSAGE_ID] = opts.inputCodecMessageId;

  const events: TreeEvent[] = opts.events ?? (opts.message ? [{ type: 'append-message', message: opts.message }] : []);
  const inputs = events.filter((e): e is TestInput => 'kind' in e);
  const outputs = events.filter((e): e is TestOutput => 'type' in e);
  tree.applyMessage({ inputs, outputs }, h, opts.serial);
};

const messagesOf = (tree: TreeInternal<TestInput, TestOutput, TestProjection>, runId: string): TestMessage[] => {
  const run = tree.getRunNode(runId);
  return run ? testCodec.getMessages(run.projection) : [];
};

const flatMessages = (
  tree: TreeInternal<TestInput, TestOutput, TestProjection>,
  selections: Map<string, string> = NO_SELECTIONS,
): TestMessage[] => tree.runs(selections).flatMap((r) => testCodec.getMessages(r.projection));

const flatRunIds = (
  tree: TreeInternal<TestInput, TestOutput, TestProjection>,
  selections: Map<string, string> = NO_SELECTIONS,
): string[] => tree.runs(selections).map((r) => r.runId);

// Narrow a node union to its runId, or undefined for a non-run / absent node.
const runIdOf = (node: ConversationNode<TestProjection> | undefined): string | undefined =>
  node?.kind === 'run' ? node.runId : undefined;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Tree', () => {
  let tree: TreeInternal<TestInput, TestOutput, TestProjection>;

  beforeEach(() => {
    tree = createTree<TestInput, TestOutput, TestProjection>(testCodec, silentLogger);
  });

  // -------------------------------------------------------------------------
  // Linear conversation
  // -------------------------------------------------------------------------

  describe('linear conversation', () => {
    it('creates a single Run from one message', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      expect(flatRunIds(tree)).toEqual(['R1']);
      expect(flatMessages(tree)).toEqual([{ id: 'a', content: 'hi' }]);
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
        { id: 'a', content: 'first' },
        { id: 'b', content: 'second' },
        { id: 'c', content: 'third' },
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
      expect(run?.kind).toBe('run');
      expect(run?.runId).toBe('R1');
      const projection = run?.projection;
      if (!projection) throw new Error('expected projection');
      expect(testCodec.getMessages(projection)).toEqual([{ id: 'a', content: 'hi' }]);
    });

    it('returns undefined for an unknown runId', () => {
      expect(tree.getRunNode('R-unknown')).toBeUndefined();
    });

    it('narrows a ConversationNode union on its kind discriminator', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      const run = tree.getRunNode('R1');
      if (!run) throw new Error('expected run');

      const input: InputNode<TestProjection> = {
        kind: 'input',
        codecMessageId: 'm1',
        parentCodecMessageId: undefined,
        forkOf: undefined,
        projection: { messages: [{ id: 'u', content: 'prompt' }] },
        serial: 's0',
      };

      // The union narrows on `kind`; each arm exposes only its own key.
      const keyOf = (node: ConversationNode<TestProjection>): string =>
        node.kind === 'run' ? node.runId : node.codecMessageId;

      expect(keyOf(run)).toBe('R1');
      expect(keyOf(input)).toBe('m1');
    });

    it('returns owning node via getNodeByCodecMessageId', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      expect(runIdOf(tree.getNodeByCodecMessageId('m1'))).toBe('R1');
      expect(tree.getNodeByCodecMessageId('m-unknown')).toBeUndefined();
    });

    it('drops messages without an run-id header', () => {
      tree.applyMessage(
        { inputs: [], outputs: [{ type: 'append-message', message: { id: 'a', content: 'orphan' } }] },
        {},
        's1',
      );
      expect(tree.runs(NO_SELECTIONS)).toEqual([]);
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
        { id: 'a', content: 'first' },
        { id: 'b', content: 'second' },
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

      expect(messagesOf(tree, 'R1')).toEqual([
        { id: 'a', content: 'first' },
        { id: 'a', content: 'amended' },
      ]);
    });

    it('catches fold errors without aborting the apply', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'ok' }, serial: 's1' });
      // Folding a throwing event should not crash applyMessage.
      expect(() => {
        apply(tree, { runId: 'R1', codecMessageId: 'm2', parent: 'm1', events: [{ type: 'throw' }], serial: 's2' });
      }).not.toThrow();
      // Earlier message survives.
      expect(messagesOf(tree, 'R1')).toEqual([{ id: 'a', content: 'ok' }]);
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

    it('reconciles an echo to the optimistic node by codec-message-id even when the wire run-id differs', () => {
      // Optimistic insert under R1 (no serial).
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'optimistic' } });
      expect(tree.getRunNode('R1')?.startSerial).toBeUndefined();

      // The echo arrives with a DIVERGENT run-id but the same codec-message-id
      // and a serial. It must reconcile to the optimistic R1 (promote it), not
      // spawn a second Run under the divergent id — reconciliation is by
      // codec-message-id, not the wire run-id.
      apply(tree, {
        runId: 'R2-divergent',
        codecMessageId: 'm1',
        message: { id: 'a', content: 'confirmed' },
        serial: 's10',
      });

      expect(tree.getRunNode('R1')?.startSerial).toBe('s10');
      expect(tree.getRunNode('R2-divergent')).toBeUndefined();
      // The codec-message-id stays indexed against the owning (reconciled) Run.
      expect(runIdOf(tree.getNodeByCodecMessageId('m1'))).toBe('R1');
      // The echo's events fold into the reconciled Run, not a phantom one.
      expect(messagesOf(tree, 'R1').map((m) => m.id)).toContain('a');
      expect(messagesOf(tree, 'R2-divergent')).toHaveLength(0);
    });

    it('does not reconcile by codec-message-id when the indexed Run is already serialized', () => {
      // R1 is established and serialized; it owns codec-message-id m1.
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'v1' }, serial: 's1' });

      // A later message reuses m1 under a different run-id (the shape of a
      // continuation amend targeting a prior message). Because R1 is already
      // serialized — not an optimistic insert awaiting its echo — this routes
      // by the wire run-id and creates R2 rather than folding back into R1.
      apply(tree, { runId: 'R2', codecMessageId: 'm1', message: { id: 'b', content: 'amend' }, serial: 's2' });
      expect(tree.getRunNode('R2')).toBeDefined();
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
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R2',
        clientId: 'c1',
        invocationId: '',
        parent: 'a1',
        regenerates: 'a1',
        serial: 's2',
      });
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
      // R2's assistant wire arrives WITHOUT msg-regenerate.
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'a2',
        role: 'assistant',
        message: { id: 'asst2', content: 'regen' },
        serial: 's2',
      });
      expect(tree.getRunNode('R2')?.regeneratesCodecMessageId).toBeUndefined();
      // run-start arrives later with the canonical metadata.
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R2',
        clientId: 'c1',
        invocationId: '',
        parent: 'a1',
        regenerates: 'a1',
        serial: 's3',
      });
      expect(tree.getRunNode('R2')?.regeneratesCodecMessageId).toBe('a1');
      // The regenerate index now reflects the backfilled anchor too.
      expect(tree.getRegenerateGroupByMsgId('a1').map((r) => r.runId)).toEqual(['R1', 'R2']);
    });

    it('adopts the agent-minted invocation-id from run-start onto the optimistic node', () => {
      // The client no longer mints the invocation-id, so the optimistic
      // insert carries none — the Run starts with an empty invocationId. The
      // agent mints it and stamps it on run-start; applyRunLifecycle must
      // adopt it onto the existing node, otherwise the client-side
      // RunNode.invocationId would stay empty forever.
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'optimistic' } });
      expect(tree.getRunNode('R1')?.invocationId).toBe('');

      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R1',
        clientId: 'c1',
        invocationId: 'agent-inv-1',
        serial: 's1',
      });
      expect(tree.getRunNode('R1')?.invocationId).toBe('agent-inv-1');

      // A later lifecycle event under the same run does not reassign it.
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R1',
        clientId: 'c1',
        invocationId: 'agent-inv-2',
        serial: 's1',
      });
      expect(tree.getRunNode('R1')?.invocationId).toBe('agent-inv-1');
    });

    it('backfills parentRunId from run-start when the assistant wire raced ahead of run-start', () => {
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'u1',
        role: 'user',
        message: { id: 'user1', content: 'q' },
        serial: 's1',
      });
      // R2's first wire (assistant) arrives WITHOUT parent.
      apply(tree, {
        runId: 'R2',
        codecMessageId: 'a2',
        role: 'assistant',
        message: { id: 'asst2', content: 'reply' },
        serial: 's2',
      });
      expect(tree.getRunNode('R2')?.parentRunId).toBeUndefined();
      // run-start carries the parent header pointing at u1.
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R2',
        clientId: 'c1',
        invocationId: '',
        parent: 'u1',
        serial: 's3',
      });
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
      // R2's user wire arrives WITHOUT parent / fork-of.
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
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R2',
        clientId: 'c1',
        invocationId: '',
        forkOf: 'u1',
        serial: 's3',
      });
      expect(tree.getRunNode('R2')?.forkOf).toBe('R1');
    });

    it('a run-resume re-entry leaves an existing run a reachable root (no self-parent cycle)', () => {
      // Regression guard for the disappearing user prompt / assistant bubble:
      //   1. User sends u1 -> R1 created, R1.parentRunId = undefined (root run).
      //   2. Agent streams a1 inside R1.
      //   3. A client-side tool resolution / approval re-enters R1.
      // Continuations now arrive as ai-run-resume, which carries no parent, so
      // there is nothing to backfill — R1 stays a reachable root. (Previously
      // the continuation arrived as a run-start carrying parent=a1, which the
      // backfill turned into a self-parent cycle that filtered R1 out.)
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

      tree.applyRunLifecycle({
        type: 'resume',
        runId: 'R1',
        clientId: 'c1',
        invocationId: 'inv-2',
        serial: 's3',
      });

      expect(tree.getRunNode('R1')?.parentRunId).toBeUndefined();
      const flat = tree.runs(new Map());
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

    it('lingering codecMessageIdToRunId after delete returns undefined via getNodeByCodecMessageId', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      expect(runIdOf(tree.getNodeByCodecMessageId('m1'))).toBe('R1');
      tree.delete('R1');
      // The codecMessageIdToRunId entry intentionally lingers (cheap to overwrite on
      // re-creation, harmless otherwise) but the lookup must return
      // undefined now that the owning Run is gone.
      expect(tree.getNodeByCodecMessageId('m1')).toBeUndefined();
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
  });

  // -------------------------------------------------------------------------
  // Run lifecycle (applyRunLifecycle)
  // -------------------------------------------------------------------------

  describe('run lifecycle', () => {
    it('run-start creates a Run with status active when none exists', () => {
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: '',
        serial: 's1',
      });
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

      // RunNode.clientId was populated from the run-client-id header
      // on Run creation; run-start does not overwrite it.
      expect(tree.getRunNode('R1')?.clientId).toBe('client-a');

      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: '',
        serial: 's2',
      });
      expect(tree.getRunNode('R1')?.status).toBe('active');
      expect(tree.getRunNode('R1')?.clientId).toBe('client-a');
    });

    it('run-end sets RunNode status and endSerial', () => {
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: '',
        serial: 's1',
      });
      tree.applyRunLifecycle({
        type: 'end',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: '',
        reason: 'complete',
        serial: 's10',
      });
      const run = tree.getRunNode('R1');
      expect(run?.status).toBe('complete');
      expect(run?.endSerial).toBe('s10');
    });

    it('emits a run event on both start and end', () => {
      const handler = vi.fn();
      tree.on('run', handler);
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: '',
        serial: 's1',
      });
      tree.applyRunLifecycle({
        type: 'end',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: '',
        reason: 'complete',
        serial: 's2',
      });
      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: 'start', runId: 'R1' }));
      expect(handler).toHaveBeenNthCalledWith(2, expect.objectContaining({ type: 'end', runId: 'R1' }));
    });

    it('run-suspend sets RunNode status to "suspended" and records endSerial', () => {
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: '',
        serial: 's1',
      });
      tree.applyRunLifecycle({
        type: 'suspend',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: 'inv-1',
        serial: 's5',
      });
      const run = tree.getRunNode('R1');
      expect(run?.status).toBe('suspended');
      expect(run?.endSerial).toBe('s5');
    });

    it('run-suspend keeps the run live so a subsequent run-start re-activates it', () => {
      // A suspended run must remain resumable: the continuation re-entry (a
      // following run-start under the same runId) flips it back to active.
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: '',
        serial: 's1',
      });
      tree.applyRunLifecycle({
        type: 'suspend',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: 'inv-1',
        serial: 's5',
      });
      expect(tree.getRunNode('R1')?.status).toBe('suspended');
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: 'inv-2',
        serial: 's1',
      });
      expect(tree.getRunNode('R1')?.status).toBe('active');
    });

    it('emits a run event on suspend', () => {
      const handler = vi.fn();
      tree.on('run', handler);
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: '',
        serial: 's1',
      });
      tree.applyRunLifecycle({
        type: 'suspend',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: 'inv-1',
        serial: 's5',
      });
      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenNthCalledWith(2, expect.objectContaining({ type: 'suspend', runId: 'R1' }));
    });

    it('run-resume re-activates a suspended run without changing its startSerial', () => {
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: 'inv-1',
        serial: 's1',
      });
      tree.applyRunLifecycle({
        type: 'suspend',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: 'inv-1',
        serial: 's5',
      });
      expect(tree.getRunNode('R1')?.status).toBe('suspended');

      tree.applyRunLifecycle({
        type: 'resume',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: 'inv-2',
        serial: 's6',
      });
      const run = tree.getRunNode('R1');
      expect(run?.status).toBe('active');
      // Re-entry is not the start — the original startSerial is preserved.
      expect(run?.startSerial).toBe('s1');
    });

    it('run-resume for an unknown run is a no-op', () => {
      const handler = vi.fn();
      tree.on('run', handler);
      tree.applyRunLifecycle({
        type: 'resume',
        runId: 'R-unknown',
        clientId: 'client-a',
        invocationId: 'inv-2',
        serial: 's6',
      });
      // No Run is created; the event still fires for observers.
      expect(tree.getRunNode('R-unknown')).toBeUndefined();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: 'resume', runId: 'R-unknown' }));
    });

    it('run-resume for a terminal run does not resurrect it', () => {
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: 'inv-1',
        serial: 's1',
      });
      tree.applyRunLifecycle({
        type: 'end',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: 'inv-1',
        serial: 's5',
        reason: 'complete',
      });
      expect(tree.getRunNode('R1')?.status).toBe('complete');

      // A stray resume targeting an already-ended run must never flip it back
      // to active — only suspended runs resume.
      tree.applyRunLifecycle({
        type: 'resume',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: 'inv-2',
        serial: 's6',
      });
      expect(tree.getRunNode('R1')?.status).toBe('complete');
    });

    it('emits a run event on resume', () => {
      const handler = vi.fn();
      tree.applyRunLifecycle({
        type: 'start',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: '',
        serial: 's1',
      });
      tree.on('run', handler);
      tree.applyRunLifecycle({
        type: 'resume',
        runId: 'R1',
        clientId: 'client-a',
        invocationId: 'inv-2',
        serial: 's6',
      });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: 'resume', runId: 'R1' }));
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

    it('emits output with routing metadata and the folded output events', () => {
      const handler = vi.fn();
      tree.on('output', handler);
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      expect(handler).toHaveBeenCalledWith({
        runId: 'R1',
        inputCodecMessageId: undefined,
        codecMessageId: 'm1',
        serial: 's1',
        events: [{ type: 'append-message', message: { id: 'a', content: 'hi' } }],
      });
    });

    it('emits output carrying the triggering input-codec-message-id from the wire', () => {
      const handler = vi.fn();
      tree.on('output', handler);
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        inputCodecMessageId: 'u1',
        message: { id: 'a', content: 'hi' },
        serial: 's1',
      });
      expect(handler).toHaveBeenCalledWith({
        runId: 'R1',
        inputCodecMessageId: 'u1',
        codecMessageId: 'm1',
        serial: 's1',
        events: [{ type: 'append-message', message: { id: 'a', content: 'hi' } }],
      });
    });

    it('emits output with empty events for an inputs-only fold', () => {
      const handler = vi.fn();
      tree.on('output', handler);
      apply(tree, {
        runId: 'R1',
        codecMessageId: 'm1',
        events: [{ kind: 'append-input', message: { id: 'a', content: 'hi' } }],
        serial: 's1',
      });
      expect(handler).toHaveBeenCalledWith({
        runId: 'R1',
        inputCodecMessageId: undefined,
        codecMessageId: 'm1',
        serial: 's1',
        events: [],
      });
    });

    it('emits output with undefined serial for an optimistic fold', () => {
      const handler = vi.fn();
      tree.on('output', handler);
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' } });
      expect(handler).toHaveBeenCalledWith({
        runId: 'R1',
        inputCodecMessageId: undefined,
        codecMessageId: 'm1',
        serial: undefined,
        events: [{ type: 'append-message', message: { id: 'a', content: 'hi' } }],
      });
    });

    it('emits update on delete', () => {
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      const handler = vi.fn();
      tree.on('update', handler);
      tree.delete('R1');
      expect(handler).toHaveBeenCalled();
    });

    it('emits update on a run-start that creates a Run, but not on the run-end', () => {
      // `update` is the structural channel: a run-start that creates a Run is
      // structural; a run-end only mutates status/endSerial on the existing
      // node (content, not structure) and emits no `update`. Lifecycle
      // observers use the `run` event for run-end.
      const handler = vi.fn();
      tree.on('update', handler);
      tree.applyRunLifecycle({ type: 'start', runId: 'R1', clientId: 'c', invocationId: '', serial: 's1' });
      expect(handler).toHaveBeenCalledTimes(1);
      tree.applyRunLifecycle({
        type: 'end',
        runId: 'R1',
        clientId: 'c',
        invocationId: '',
        reason: 'complete',
        serial: 's2',
      });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('does not emit update on a run-suspend', () => {
      // Like run-end, a suspend only mutates status/endSerial on the existing
      // node (content, not structure), so it emits no `update`.
      tree.applyRunLifecycle({ type: 'start', runId: 'R1', clientId: 'c', invocationId: '', serial: 's1' });
      const handler = vi.fn();
      tree.on('update', handler);
      tree.applyRunLifecycle({ type: 'suspend', runId: 'R1', clientId: 'c', invocationId: '', serial: 's2' });
      expect(handler).not.toHaveBeenCalled();
    });

    it('does not emit update on a run-resume', () => {
      // A resume only flips status back to 'active' (content, not structure),
      // so it emits no `update`.
      tree.applyRunLifecycle({ type: 'start', runId: 'R1', clientId: 'c', invocationId: '', serial: 's1' });
      tree.applyRunLifecycle({ type: 'suspend', runId: 'R1', clientId: 'c', invocationId: '', serial: 's2' });
      const handler = vi.fn();
      tree.on('update', handler);
      tree.applyRunLifecycle({ type: 'resume', runId: 'R1', clientId: 'c', invocationId: '', serial: 's3' });
      expect(handler).not.toHaveBeenCalled();
    });

    it('does not emit update on a run-start that only re-activates an existing Run', () => {
      // A repeat run-start for a Run that already exists with its startSerial
      // set and no new structural metadata flips status to active at most —
      // content, not structure — so it emits no `update`.
      tree.applyRunLifecycle({ type: 'start', runId: 'R1', clientId: 'c', invocationId: '', serial: 's1' });
      const handler = vi.fn();
      tree.on('update', handler);
      tree.applyRunLifecycle({ type: 'start', runId: 'R1', clientId: 'c', invocationId: '', serial: 's1' });
      expect(handler).not.toHaveBeenCalled();
    });

    it('does not emit update on a content-only fold into an existing Run', () => {
      // The first apply creates the Run (structural → update). A subsequent
      // fold into the same Run changes only its projection (streaming
      // content), which flows through `output`, not `update`.
      apply(tree, { runId: 'R1', codecMessageId: 'm1', message: { id: 'a', content: 'hi' }, serial: 's1' });
      const handler = vi.fn();
      tree.on('update', handler);
      apply(tree, { runId: 'R1', codecMessageId: 'm2', message: { id: 'a', content: 'hi there' }, serial: 's2' });
      expect(handler).not.toHaveBeenCalled();
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
});
