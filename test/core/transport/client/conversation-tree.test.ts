import { beforeEach, describe, expect, it } from 'vitest';

import { HEADER_FORK_OF, HEADER_PARENT } from '../../../../src/constants.js';
import { createConversationTree } from '../../../../src/core/transport/client/conversation-tree.js';
import type { ConversationTree } from '../../../../src/core/transport/client/types.js';
import { LogLevel, makeLogger } from '../../../../src/logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestMessage {
  id: string;
  content: string;
}

const silentLogger = makeLogger({ logLevel: LogLevel.Silent });

const getKey = (m: TestMessage): string => m.id;

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

describe('ConversationTree', () => {
  let tree: ConversationTree<TestMessage>;

  beforeEach(() => {
    tree = createConversationTree(getKey, silentLogger);
  });

  // -------------------------------------------------------------------------
  // Linear conversation
  // -------------------------------------------------------------------------

  describe('linear conversation', () => {
    it('flattens a single message', () => {
      tree.upsert('m1', { id: 'a', content: 'hi' }, headers(), 'serial-001');
      expect(tree.flatten()).toEqual([{ id: 'a', content: 'hi' }]);
    });

    it('flattens a linear chain in serial order', () => {
      tree.upsert('m1', { id: 'a', content: 'first' }, headers(), 'serial-001');
      tree.upsert('m2', { id: 'b', content: 'second' }, headers({ parent: 'm1' }), 'serial-002');
      tree.upsert('m3', { id: 'c', content: 'third' }, headers({ parent: 'm2' }), 'serial-003');

      const flat = tree.flatten();
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

    it('returns correct node via getNodeByKey', () => {
      tree.upsert('m1', { id: 'a', content: 'hi' }, headers(), 'serial-001');
      const node = tree.getNodeByKey('a');
      expect(node).toBeDefined();
      expect(node?.msgId).toBe('m1');
    });

    it('returns undefined for unknown key', () => {
      expect(tree.getNodeByKey('unknown')).toBeUndefined();
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

      const flat = tree.flatten();
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

      const flat = tree.flatten();
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

      const flat = tree.flatten();
      expect(flat).toEqual([
        { id: 'a', content: 'first' },
        { id: 'b', content: 'second' },
        { id: 'c', content: 'third' },
      ]);
    });

    it('null-serial messages sort after serial-bearing messages', () => {
      tree.upsert('m1', { id: 'a', content: 'serial' }, headers(), 'serial-001');
      tree.upsert('m2', { id: 'b', content: 'optimistic' }, headers({ parent: 'm1' }));

      const flat = tree.flatten();
      expect(flat).toEqual([
        { id: 'a', content: 'serial' },
        { id: 'b', content: 'optimistic' },
      ]);
    });

    it('null-serial messages sort among themselves by insertion order', () => {
      tree.upsert('m1', { id: 'a', content: 'first' }, headers());
      tree.upsert('m2', { id: 'b', content: 'second' }, headers({ parent: 'm1' }));
      tree.upsert('m3', { id: 'c', content: 'third' }, headers({ parent: 'm2' }));

      const flat = tree.flatten();
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

    it('default selection is the latest sibling', () => {
      tree.upsert('m4', { id: 'd', content: 'assistant-v2' }, headers({ parent: 'm1', forkOf: 'm2' }), 'serial-004');

      // Default selection should be the last (newest) sibling
      const selectedIdx = tree.getSelectedIndex('m2');
      expect(selectedIdx).toBe(1); // m4 is at index 1

      // Flatten should follow the latest branch (m4, not m2)
      const flat = tree.flatten();
      expect(flat).toEqual([
        { id: 'a', content: 'user' },
        { id: 'd', content: 'assistant-v2' },
      ]);
    });

    it('select changes the active branch', () => {
      tree.upsert('m4', { id: 'd', content: 'assistant-v2' }, headers({ parent: 'm1', forkOf: 'm2' }), 'serial-004');

      // Select the first sibling (original m2)
      tree.select('m2', 0);

      const flat = tree.flatten();
      expect(flat).toEqual([
        { id: 'a', content: 'user' },
        { id: 'b', content: 'assistant-v1' },
        { id: 'c', content: 'follow-up' },
      ]);

      expect(tree.getSelectedIndex('m2')).toBe(0);
    });

    it('select clamps out-of-range index', () => {
      tree.upsert('m4', { id: 'd', content: 'v2' }, headers({ parent: 'm1', forkOf: 'm2' }), 'serial-004');

      tree.select('m2', 999);
      expect(tree.getSelectedIndex('m2')).toBe(1);

      tree.select('m2', -5);
      expect(tree.getSelectedIndex('m2')).toBe(0);
    });

    it('select is a no-op for a node with no siblings', () => {
      // m1 has no siblings
      tree.select('m1', 5);
      expect(tree.getSelectedIndex('m1')).toBe(0);
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
      const flat = tree.flatten();
      expect(flat).toEqual([
        { id: 'a', content: 'user' },
        { id: 'd', content: 'v2' },
        { id: 'e', content: 'child-of-v2' },
      ]);
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
      expect(tree.flatten()).toEqual([{ id: 'a', content: 'first' }]);
    });

    it('removes the node from getNode', () => {
      tree.upsert('m1', { id: 'a', content: 'hi' }, headers(), 'serial-001');
      tree.delete('m1');
      expect(tree.getNode('m1')).toBeUndefined();
    });

    it('removes the node from getNodeByKey', () => {
      tree.upsert('m1', { id: 'a', content: 'hi' }, headers(), 'serial-001');
      tree.delete('m1');
      expect(tree.getNodeByKey('a')).toBeUndefined();
    });

    it('children become unreachable after parent delete', () => {
      tree.upsert('m1', { id: 'a', content: 'root' }, headers(), 'serial-001');
      tree.upsert('m2', { id: 'b', content: 'child' }, headers({ parent: 'm1' }), 'serial-002');
      tree.upsert('m3', { id: 'c', content: 'grandchild' }, headers({ parent: 'm2' }), 'serial-003');

      tree.delete('m1');
      // Children still exist in the tree but are unreachable via flatten
      expect(tree.flatten()).toEqual([]);
      // m2 and m3 still accessible by getNode
      expect(tree.getNode('m2')).toBeDefined();
      expect(tree.getNode('m3')).toBeDefined();
    });

    it('is a no-op for unknown msgId', () => {
      tree.upsert('m1', { id: 'a', content: 'hi' }, headers(), 'serial-001');
      tree.delete('unknown');
      expect(tree.flatten()).toEqual([{ id: 'a', content: 'hi' }]);
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
      expect(tree.flatten()).toEqual([]);
    });

    it('getSelectedIndex returns 0 for a single message', () => {
      tree.upsert('m1', { id: 'a', content: 'hi' }, headers(), 'serial-001');
      expect(tree.getSelectedIndex('m1')).toBe(0);
    });

    it('getSelectedIndex returns 0 for unknown msgId', () => {
      expect(tree.getSelectedIndex('unknown')).toBe(0);
    });

    it('handles messages with same serial by insertion order', () => {
      tree.upsert('m1', { id: 'a', content: 'first' }, headers(), 'serial-001');
      tree.upsert('m2', { id: 'b', content: 'second' }, headers({ parent: 'm1' }), 'serial-001');

      const flat = tree.flatten();
      expect(flat[0]).toEqual({ id: 'a', content: 'first' });
      expect(flat[1]).toEqual({ id: 'b', content: 'second' });
    });
  });
});
