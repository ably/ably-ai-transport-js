import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HEADER_FORK_OF,
  HEADER_INVOCATION_ID,
  HEADER_PARENT,
  HEADER_ROLE,
  HEADER_RUN_ID,
} from '../../../src/constants.js';
import type { TreeInternal } from '../../../src/core/transport/tree.js';
import { createTree } from '../../../src/core/transport/tree.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestMessage {
  id: string;
  content: string;
}

const silentLogger = makeLogger({ logLevel: LogLevel.Silent });

/** Empty selections — always picks the latest sibling at every fork. */
const NO_SELECTIONS = new Map<string, string>();

/**
 * Build headers for a tree node.
 * @param opts - Optional parent and forkOf IDs.
 * @param opts.parent - The parent msg-id.
 * @param opts.forkOf - The forkOf msg-id.
 * @returns A headers object suitable for upsert.
 */
const headers = (opts?: { parent?: string; forkOf?: string }): Record<string, string> => {
  const h: Record<string, string> = {};
  if (opts?.parent) h[HEADER_PARENT] = opts.parent;
  if (opts?.forkOf) h[HEADER_FORK_OF] = opts.forkOf;
  return h;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Tree', () => {
  let tree: TreeInternal<TestMessage>;

  beforeEach(() => {
    tree = createTree(silentLogger);
  });

  // -------------------------------------------------------------------------
  // Linear conversation
  // -------------------------------------------------------------------------

  describe('linear conversation', () => {
    it('flattens a single message', () => {
      tree.upsert('m1', { id: 'a', content: 'hi' }, headers(), 'serial-001');
      expect(tree.flattenNodes(NO_SELECTIONS).map((n) => n.message)).toEqual([{ id: 'a', content: 'hi' }]);
    });

    it('flattens a linear chain in serial order', () => {
      tree.upsert('m1', { id: 'a', content: 'first' }, headers(), 'serial-001');
      tree.upsert('m2', { id: 'b', content: 'second' }, headers({ parent: 'm1' }), 'serial-002');
      tree.upsert('m3', { id: 'c', content: 'third' }, headers({ parent: 'm2' }), 'serial-003');

      const flat = tree.flattenNodes(NO_SELECTIONS).map((n) => n.message);
      expect(flat).toEqual([
        { id: 'a', content: 'first' },
        { id: 'b', content: 'second' },
        { id: 'c', content: 'third' },
      ]);
    });

    it('returns correct node via getNode', () => {
      tree.upsert('m1', { id: 'a', content: 'hi' }, headers(), 'serial-001');
      const node = tree.getNode('m1');
      expect(node).toBeDefined();
      expect(node?.msgId).toBe('m1');
      expect(node?.message).toEqual({ id: 'a', content: 'hi' });
    });

    it('returns undefined for unknown node', () => {
      expect(tree.getNode('unknown')).toBeUndefined();
    });

    it('returns stored headers', () => {
      const h = { ...headers({ parent: 'm0' }), 'x-custom': 'val' };
      tree.upsert('m1', { id: 'a', content: 'hi' }, h, 'serial-001');
      expect(tree.getHeaders('m1')).toEqual(h);
    });

    it('returns undefined headers for unknown node', () => {
      expect(tree.getHeaders('unknown')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Upsert — update in place
  // -------------------------------------------------------------------------

  describe('upsert updates', () => {
    it('updates message content on re-upsert', () => {
      tree.upsert('m1', { id: 'a', content: 'v1' }, headers(), 'serial-001');
      tree.upsert('m1', { id: 'a', content: 'v2' }, headers(), 'serial-001');

      const flat = tree.flattenNodes(NO_SELECTIONS).map((n) => n.message);
      expect(flat).toEqual([{ id: 'a', content: 'v2' }]);
    });

    it('does not erase headers on update with empty headers', () => {
      tree.upsert('m1', { id: 'a', content: 'v1' }, headers({ parent: 'm0' }), 'serial-001');
      // Streaming update with empty headers
      tree.upsert('m1', { id: 'a', content: 'v2' }, {});

      expect(tree.getHeaders('m1')).toEqual(headers({ parent: 'm0' }));
    });

    it('updates headers when new headers are non-empty', () => {
      tree.upsert('m1', { id: 'a', content: 'v1' }, { 'x-old': 'val' }, 'serial-001');
      tree.upsert('m1', { id: 'a', content: 'v2' }, { 'x-new': 'val2' });

      expect(tree.getHeaders('m1')).toEqual({ 'x-new': 'val2' });
    });
  });

  // -------------------------------------------------------------------------
  // Serial promotion
  // -------------------------------------------------------------------------

  describe('serial promotion', () => {
    it('promotes null serial to server-assigned serial', () => {
      // Optimistic insert (no serial)
      tree.upsert('m1', { id: 'a', content: 'optimistic' }, headers());
      // Server relay with serial
      tree.upsert('m1', { id: 'a', content: 'confirmed' }, headers(), 'serial-001');

      const node = tree.getNode('m1');
      expect(node?.serial).toBe('serial-001');
    });

    it('re-sorts after serial promotion', () => {
      // Insert m2 with serial first
      tree.upsert('m2', { id: 'b', content: 'second' }, headers({ parent: 'm1' }), 'serial-002');
      // Insert m1 optimistically (no serial) — sorts after m2 initially
      tree.upsert('m1', { id: 'a', content: 'first' }, headers());

      // Before promotion, m2 (serial-bearing) sorts before m1 (null-serial)
      // After promotion, m1 sorts before m2
      tree.upsert('m1', { id: 'a', content: 'first' }, headers(), 'serial-001');

      const flat = tree.flattenNodes(NO_SELECTIONS).map((n) => n.message);
      expect(flat[0]).toEqual({ id: 'a', content: 'first' });
      expect(flat[1]).toEqual({ id: 'b', content: 'second' });
    });

    it('does not demote an existing serial', () => {
      tree.upsert('m1', { id: 'a', content: 'v1' }, headers(), 'serial-001');
      // Re-upsert without serial should not clear it
      tree.upsert('m1', { id: 'a', content: 'v2' }, headers());

      expect(tree.getNode('m1')?.serial).toBe('serial-001');
    });
  });

  // -------------------------------------------------------------------------
  // Out-of-order inserts
  // -------------------------------------------------------------------------

  describe('out-of-order inserts', () => {
    it('produces correct flatten regardless of insertion order', () => {
      // Insert in reverse order
      tree.upsert('m3', { id: 'c', content: 'third' }, headers({ parent: 'm2' }), 'serial-003');
      tree.upsert('m1', { id: 'a', content: 'first' }, headers(), 'serial-001');
      tree.upsert('m2', { id: 'b', content: 'second' }, headers({ parent: 'm1' }), 'serial-002');

      const flat = tree.flattenNodes(NO_SELECTIONS).map((n) => n.message);
      expect(flat).toEqual([
        { id: 'a', content: 'first' },
        { id: 'b', content: 'second' },
        { id: 'c', content: 'third' },
      ]);
    });

    it('null-serial messages sort after serial-bearing messages', () => {
      tree.upsert('m1', { id: 'a', content: 'serial' }, headers(), 'serial-001');
      tree.upsert('m2', { id: 'b', content: 'optimistic' }, headers({ parent: 'm1' }));

      const flat = tree.flattenNodes(NO_SELECTIONS).map((n) => n.message);
      expect(flat).toEqual([
        { id: 'a', content: 'serial' },
        { id: 'b', content: 'optimistic' },
      ]);
    });

    it('null-serial messages sort among themselves by insertion order', () => {
      tree.upsert('m1', { id: 'a', content: 'first' }, headers());
      tree.upsert('m2', { id: 'b', content: 'second' }, headers({ parent: 'm1' }));
      tree.upsert('m3', { id: 'c', content: 'third' }, headers({ parent: 'm2' }));

      const flat = tree.flattenNodes(NO_SELECTIONS).map((n) => n.message);
      expect(flat).toEqual([
        { id: 'a', content: 'first' },
        { id: 'b', content: 'second' },
        { id: 'c', content: 'third' },
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Fork / regeneration
  // -------------------------------------------------------------------------

  describe('fork and regeneration', () => {
    beforeEach(() => {
      // Base linear chain: m1 -> m2 -> m3
      tree.upsert('m1', { id: 'a', content: 'user' }, headers(), 'serial-001');
      tree.upsert('m2', { id: 'b', content: 'assistant-v1' }, headers({ parent: 'm1' }), 'serial-002');
      tree.upsert('m3', { id: 'c', content: 'follow-up' }, headers({ parent: 'm2' }), 'serial-003');
    });

    it('fork creates a sibling group', () => {
      // Regenerate m2: new m4 forks m2
      tree.upsert('m4', { id: 'd', content: 'assistant-v2' }, headers({ parent: 'm1', forkOf: 'm2' }), 'serial-004');

      expect(tree.hasSiblings('m2')).toBe(true);
      expect(tree.hasSiblings('m4')).toBe(true);

      const siblings = tree.getSiblings('m2');
      expect(siblings).toHaveLength(2);
      expect(siblings[0]).toEqual({ id: 'b', content: 'assistant-v1' });
      expect(siblings[1]).toEqual({ id: 'd', content: 'assistant-v2' });
    });

    it('default selection (no selections) picks the latest sibling', () => {
      tree.upsert('m4', { id: 'd', content: 'assistant-v2' }, headers({ parent: 'm1', forkOf: 'm2' }), 'serial-004');

      // Flatten with empty selections follows the latest branch (m4, not m2)
      const flat = tree.flattenNodes(NO_SELECTIONS).map((n) => n.message);
      expect(flat).toEqual([
        { id: 'a', content: 'user' },
        { id: 'd', content: 'assistant-v2' },
      ]);
    });

    it('selections map controls which branch is followed', () => {
      tree.upsert('m4', { id: 'd', content: 'assistant-v2' }, headers({ parent: 'm1', forkOf: 'm2' }), 'serial-004');

      const groupRoot = tree.getGroupRoot('m2');
      // Select the first sibling (original m2) by msgId
      const selections = new Map([[groupRoot, 'm2']]);

      const flat = tree.flattenNodes(selections).map((n) => n.message);
      expect(flat).toEqual([
        { id: 'a', content: 'user' },
        { id: 'b', content: 'assistant-v1' },
        { id: 'c', content: 'follow-up' },
      ]);
    });

    it('stale selection msgId falls back to latest sibling', () => {
      tree.upsert('m4', { id: 'd', content: 'v2' }, headers({ parent: 'm1', forkOf: 'm2' }), 'serial-004');

      const groupRoot = tree.getGroupRoot('m2');

      // Unknown msgId falls back to latest
      const stale = new Map([[groupRoot, 'nonexistent']]);
      const flatStale = tree.flattenNodes(stale).map((n) => n.message.content);
      expect(flatStale).toContain('v2');
    });

    it('getSiblingNodes returns TreeNode objects with msgIds', () => {
      tree.upsert('m4', { id: 'd', content: 'assistant-v2' }, headers({ parent: 'm1', forkOf: 'm2' }), 'serial-004');

      const nodes = tree.getSiblingNodes('m2');
      expect(nodes).toHaveLength(2);
      expect(nodes[0]?.msgId).toBe('m2');
      expect(nodes[1]?.msgId).toBe('m4');
      expect(nodes[0]?.message).toEqual({ id: 'b', content: 'assistant-v1' });
      expect(nodes[1]?.message).toEqual({ id: 'd', content: 'assistant-v2' });
    });

    it('getSiblings returns single-element array for non-forked nodes', () => {
      expect(tree.getSiblings('m1')).toEqual([{ id: 'a', content: 'user' }]);
      expect(tree.hasSiblings('m1')).toBe(false);
    });

    it('getSiblings returns empty array for unknown msgId', () => {
      expect(tree.getSiblings('unknown')).toEqual([]);
    });

    it('multiple forks create a larger sibling group', () => {
      tree.upsert('m4', { id: 'd', content: 'v2' }, headers({ parent: 'm1', forkOf: 'm2' }), 'serial-004');
      tree.upsert('m5', { id: 'e', content: 'v3' }, headers({ parent: 'm1', forkOf: 'm2' }), 'serial-005');

      const siblings = tree.getSiblings('m2');
      expect(siblings).toHaveLength(3);
      expect(siblings.map((s) => s.content)).toEqual(['assistant-v1', 'v2', 'v3']);
    });

    it('children of non-selected sibling are excluded from flatten', () => {
      tree.upsert('m4', { id: 'd', content: 'v2' }, headers({ parent: 'm1', forkOf: 'm2' }), 'serial-004');
      tree.upsert('m5', { id: 'e', content: 'child-of-v2' }, headers({ parent: 'm4' }), 'serial-005');

      // Default selects latest (m4), so m5 should be included, m3 excluded
      const flat = tree.flattenNodes(NO_SELECTIONS).map((n) => n.message);
      expect(flat).toEqual([
        { id: 'a', content: 'user' },
        { id: 'd', content: 'v2' },
        { id: 'e', content: 'child-of-v2' },
      ]);
    });

    it('getGroupRoot returns the original message in a fork chain', () => {
      tree.upsert('m4', { id: 'd', content: 'v2' }, headers({ parent: 'm1', forkOf: 'm2' }), 'serial-004');

      expect(tree.getGroupRoot('m2')).toBe('m2');
      expect(tree.getGroupRoot('m4')).toBe('m2');
    });

    it('getGroupRoot returns msgId for non-forked nodes', () => {
      expect(tree.getGroupRoot('m1')).toBe('m1');
    });
  });

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  describe('delete', () => {
    it('removes a node from flatten', () => {
      tree.upsert('m1', { id: 'a', content: 'first' }, headers(), 'serial-001');
      tree.upsert('m2', { id: 'b', content: 'second' }, headers({ parent: 'm1' }), 'serial-002');

      tree.delete('m2');
      expect(tree.flattenNodes(NO_SELECTIONS).map((n) => n.message)).toEqual([{ id: 'a', content: 'first' }]);
    });

    it('removes the node from getNode', () => {
      tree.upsert('m1', { id: 'a', content: 'hi' }, headers(), 'serial-001');
      tree.delete('m1');
      expect(tree.getNode('m1')).toBeUndefined();
    });

    it('children become unreachable after parent delete', () => {
      tree.upsert('m1', { id: 'a', content: 'root' }, headers(), 'serial-001');
      tree.upsert('m2', { id: 'b', content: 'child' }, headers({ parent: 'm1' }), 'serial-002');
      tree.upsert('m3', { id: 'c', content: 'grandchild' }, headers({ parent: 'm2' }), 'serial-003');

      tree.delete('m1');
      // Children still exist in the tree but are unreachable via flatten
      expect(tree.flattenNodes(NO_SELECTIONS).map((n) => n.message)).toEqual([]);
      // m2 and m3 still accessible by getNode
      expect(tree.getNode('m2')).toBeDefined();
      expect(tree.getNode('m3')).toBeDefined();
    });

    it('is a no-op for unknown msgId', () => {
      tree.upsert('m1', { id: 'a', content: 'hi' }, headers(), 'serial-001');
      tree.delete('unknown');
      expect(tree.flattenNodes(NO_SELECTIONS).map((n) => n.message)).toEqual([{ id: 'a', content: 'hi' }]);
    });

    it('removes the deleted node from sibling groups', () => {
      tree.upsert('m1', { id: 'a', content: 'user' }, headers(), 'serial-001');
      tree.upsert('m2', { id: 'b', content: 'v1' }, headers({ parent: 'm1' }), 'serial-002');
      tree.upsert('m3', { id: 'c', content: 'v2' }, headers({ parent: 'm1', forkOf: 'm2' }), 'serial-003');

      expect(tree.getSiblings('m2')).toHaveLength(2);

      tree.delete('m3');
      expect(tree.getSiblings('m2')).toHaveLength(1);
      expect(tree.hasSiblings('m2')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('empty tree returns empty flatten', () => {
      expect(tree.flattenNodes(NO_SELECTIONS).map((n) => n.message)).toEqual([]);
    });

    it('handles messages with same serial by insertion order', () => {
      tree.upsert('m1', { id: 'a', content: 'first' }, headers(), 'serial-001');
      tree.upsert('m2', { id: 'b', content: 'second' }, headers({ parent: 'm1' }), 'serial-001');

      const flat = tree.flattenNodes(NO_SELECTIONS).map((n) => n.message);
      expect(flat[0]).toEqual({ id: 'a', content: 'first' });
      expect(flat[1]).toEqual({ id: 'b', content: 'second' });
    });
  });

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  describe('events', () => {
    it('emits update on upsert (new insert)', () => {
      const handler = vi.fn();
      tree.on('update', handler);
      tree.upsert('m1', { id: '1', content: 'hi' }, headers());
      expect(handler).toHaveBeenCalledOnce();
    });

    it('emits update on upsert (existing message update)', () => {
      tree.upsert('m1', { id: '1', content: 'hi' }, headers());
      const handler = vi.fn();
      tree.on('update', handler);
      tree.upsert('m1', { id: '1', content: 'updated' }, headers());
      expect(handler).toHaveBeenCalledOnce();
    });

    it('emits update on delete', () => {
      tree.upsert('m1', { id: '1', content: 'hi' }, headers());
      const handler = vi.fn();
      tree.on('update', handler);
      tree.delete('m1');
      expect(handler).toHaveBeenCalledOnce();
    });

    it('unsubscribe stops delivery', () => {
      const handler = vi.fn();
      const unsub = tree.on('update', handler);
      unsub();
      tree.upsert('m1', { id: '1', content: 'hi' }, headers());
      expect(handler).not.toHaveBeenCalled();
    });

    it('tracks and exposes active runs', () => {
      const fullTree = createTree<TestMessage>(silentLogger);
      fullTree.trackRun('run-1', 'client-a');
      fullTree.trackRun('run-2', 'client-a');
      fullTree.trackRun('run-3', 'client-b');

      const active = fullTree.getActiveRunIds();
      expect(active.get('client-a')).toEqual(new Set(['run-1', 'run-2']));
      expect(active.get('client-b')).toEqual(new Set(['run-3']));

      fullTree.untrackRun('run-1');
      const after = fullTree.getActiveRunIds();
      expect(after.get('client-a')).toEqual(new Set(['run-2']));
    });
  });

  // -------------------------------------------------------------------------
  // Winning invocation map
  // -------------------------------------------------------------------------

  describe('winning invocation map', () => {
    /**
     * Build user-message headers carrying run-id and invocation-id.
     * @param runId - Run identifier stamped in `x-ably-run-id`.
     * @param invocationId - Invocation identifier stamped in `x-ably-invocation-id`.
     * @returns A headers record with the standard user-message fields populated.
     */
    // eslint-disable-next-line unicorn/consistent-function-scoping -- describe-local helper
    const userH = (runId: string, invocationId: string): Record<string, string> => ({
      [HEADER_ROLE]: 'user',
      [HEADER_RUN_ID]: runId,
      [HEADER_INVOCATION_ID]: invocationId,
    });

    it('records the first user-message as the winner', () => {
      tree.upsert('m1', { id: 'a', content: 'hi' }, userH('run-1', 'inv-1'), 'serial-001');
      expect(tree.getWinningInvocation('run-1')).toEqual({ invocationId: 'inv-1', serial: 'serial-001' });
    });

    it('returns undefined for an unknown run-id', () => {
      expect(tree.getWinningInvocation('run-x')).toBeUndefined();
    });

    it('replaces the winner when a higher-serial user-message arrives', () => {
      tree.upsert('m1', { id: 'a', content: 'hi' }, userH('run-1', 'inv-1'), 'serial-005');
      tree.upsert('m2', { id: 'b', content: 'hi' }, userH('run-1', 'inv-2'), 'serial-007');
      expect(tree.getWinningInvocation('run-1')).toEqual({ invocationId: 'inv-2', serial: 'serial-007' });
    });

    it('keeps the existing winner when a lower-serial user-message arrives later', () => {
      tree.upsert('m2', { id: 'b', content: 'hi' }, userH('run-1', 'inv-2'), 'serial-007');
      tree.upsert('m1', { id: 'a', content: 'hi' }, userH('run-1', 'inv-1'), 'serial-005');
      expect(tree.getWinningInvocation('run-1')).toEqual({ invocationId: 'inv-2', serial: 'serial-007' });
    });

    it('ignores optimistic (null-serial) user-messages', () => {
      tree.upsert('m1', { id: 'a', content: 'hi' }, userH('run-1', 'inv-1'));
      expect(tree.getWinningInvocation('run-1')).toBeUndefined();
    });

    it('promotes to winner when an optimistic insert is later relayed with a serial', () => {
      tree.upsert('m1', { id: 'a', content: 'hi' }, userH('run-1', 'inv-1'));
      expect(tree.getWinningInvocation('run-1')).toBeUndefined();
      tree.upsert('m1', { id: 'a', content: 'hi' }, userH('run-1', 'inv-1'), 'serial-010');
      expect(tree.getWinningInvocation('run-1')).toEqual({ invocationId: 'inv-1', serial: 'serial-010' });
    });

    it('ignores assistant-role messages', () => {
      tree.upsert(
        'm1',
        { id: 'a', content: 'hi' },
        { [HEADER_ROLE]: 'assistant', [HEADER_RUN_ID]: 'run-1', [HEADER_INVOCATION_ID]: 'inv-x' },
        'serial-001',
      );
      expect(tree.getWinningInvocation('run-1')).toBeUndefined();
    });

    it('tracks distinct run-ids independently', () => {
      tree.upsert('m1', { id: 'a', content: 'hi' }, userH('run-1', 'inv-1'), 'serial-001');
      tree.upsert('m2', { id: 'b', content: 'hi' }, userH('run-2', 'inv-2'), 'serial-002');
      expect(tree.getWinningInvocation('run-1')).toEqual({ invocationId: 'inv-1', serial: 'serial-001' });
      expect(tree.getWinningInvocation('run-2')).toEqual({ invocationId: 'inv-2', serial: 'serial-002' });
    });

    it('emits invocation-winner-changed when the winner is set or replaced', () => {
      const handler = vi.fn();
      tree.on('invocation-winner-changed', handler);
      tree.upsert('m1', { id: 'a', content: 'hi' }, userH('run-1', 'inv-1'), 'serial-005');
      expect(handler).toHaveBeenCalledWith({ runId: 'run-1', invocationId: 'inv-1', serial: 'serial-005' });
      handler.mockClear();
      tree.upsert('m2', { id: 'b', content: 'hi' }, userH('run-1', 'inv-2'), 'serial-007');
      expect(handler).toHaveBeenCalledWith({ runId: 'run-1', invocationId: 'inv-2', serial: 'serial-007' });
    });

    it('does not emit invocation-winner-changed for optimistic inserts', () => {
      const handler = vi.fn();
      tree.on('invocation-winner-changed', handler);
      tree.upsert('m1', { id: 'a', content: 'hi' }, userH('run-1', 'inv-1'));
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
