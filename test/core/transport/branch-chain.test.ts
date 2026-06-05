import { describe, expect, it } from 'vitest';

import type { BranchChainNode } from '../../../src/core/transport/branch-chain.js';
import { buildBranchChain } from '../../../src/core/transport/branch-chain.js';

// Build a nodeMeta map from `{ id: parentId }` entries (undefined parent = root).
const meta = (entries: Record<string, string | undefined>): Map<string, BranchChainNode> => {
  const map = new Map<string, BranchChainNode>();
  for (const [id, parentTransportMessageId] of Object.entries(entries)) {
    map.set(id, { parentTransportMessageId });
  }
  return map;
};

describe('buildBranchChain', () => {
  it('orders a linear chain root-first to anchor-last', () => {
    const nodeMeta = meta({ a: undefined, b: 'a', c: 'b', d: 'c' });
    expect(buildBranchChain(nodeMeta, 'd')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns just the anchor when it is the root', () => {
    const nodeMeta = meta({ a: undefined });
    expect(buildBranchChain(nodeMeta, 'a')).toEqual(['a']);
  });

  it('stops at the anchor, not at the deepest descendant', () => {
    // The map also contains children of the anchor; the walk goes upward only.
    const nodeMeta = meta({ a: undefined, b: 'a', c: 'b', d: 'c' });
    expect(buildBranchChain(nodeMeta, 'b')).toEqual(['a', 'b']);
  });

  it('follows only the anchor’s own ancestors, never sibling branches', () => {
    // a → b (input), with two reply branches b→r1 and b→r2, and r1→b2→r3.
    // Walking from r3 must not surface the r2 sibling branch.
    const nodeMeta = meta({
      a: undefined,
      b: 'a',
      r1: 'b',
      r2: 'b',
      b2: 'r1',
      r3: 'b2',
    });
    expect(buildBranchChain(nodeMeta, 'r3')).toEqual(['a', 'b', 'r1', 'b2', 'r3']);
    expect(buildBranchChain(nodeMeta, 'r2')).toEqual(['a', 'b', 'r2']);
  });

  it('includes a dangling parent as the chain head then stops', () => {
    // `a`'s parent `missing` is not in the map: it is still emitted as the
    // head (the edge was declared), but the walk cannot continue past it.
    const nodeMeta = meta({ a: 'missing', b: 'a' });
    expect(buildBranchChain(nodeMeta, 'b')).toEqual(['missing', 'a', 'b']);
  });

  it('returns just the anchor when the anchor is absent from the map', () => {
    expect(buildBranchChain(meta({}), 'orphan')).toEqual(['orphan']);
  });

  it('breaks a cycle best-effort instead of looping forever', () => {
    // a ↔ b mutual parents; the walk visits each once and terminates.
    const nodeMeta = meta({ a: 'b', b: 'a' });
    expect(buildBranchChain(nodeMeta, 'a')).toEqual(['b', 'a']);
  });

  it('breaks a self-parent cycle', () => {
    const nodeMeta = meta({ a: 'a' });
    expect(buildBranchChain(nodeMeta, 'a')).toEqual(['a']);
  });

  it('accepts a richer node-meta shape structurally', () => {
    // A node-meta carrying extra fields (as the PR-2 index will) satisfies
    // BranchChainNode; the walk reads only parentTransportMessageId.
    interface RichMeta extends BranchChainNode {
      runId: string | undefined;
      forkOf: string | undefined;
    }
    const rich = new Map<string, RichMeta>([
      ['a', { parentTransportMessageId: undefined, runId: undefined, forkOf: undefined }],
      ['b', { parentTransportMessageId: 'a', runId: 'R1', forkOf: undefined }],
    ]);
    expect(buildBranchChain(rich, 'b')).toEqual(['a', 'b']);
  });
});
