import { describe, expect, it } from 'vitest';

import type { CodecMessage } from '../../../src/core/codec/types.js';
import { collectMessages, type NonHeadRegenerateResolver } from '../../../src/core/transport/collect-messages.js';
import type { ConversationNode, RunNode } from '../../../src/core/transport/types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

interface TestMessage {
  id: string;
}

/** A node's projection is just its ordered message ids. */
interface TestProjection {
  ids: string[];
}

const getMessages = (projection: TestProjection): CodecMessage<TestMessage>[] =>
  projection.ids.map((id) => ({ codecMessageId: id, message: { id } }));

const inputNode = (codecMessageId: string, ids: string[]): ConversationNode<TestProjection> => ({
  kind: 'input',
  codecMessageId,
  parentCodecMessageId: undefined,
  forkOf: undefined,
  projection: { ids },
  serial: undefined,
});

const runNode = (
  runId: string,
  ids: string[],
  extra: Partial<RunNode<TestProjection>> = {},
): RunNode<TestProjection> => ({
  kind: 'run',
  runId,
  parentCodecMessageId: undefined,
  forkOf: undefined,
  regeneratesCodecMessageId: undefined,
  clientId: '',
  state: { status: 'complete' },
  projection: { ids },
  invocationId: '',
  startSerial: undefined,
  endSerial: undefined,
  ...extra,
});

// A resolver with no non-head regeneration — the common case.
const plainResolver = (
  overrides: Partial<NonHeadRegenerateResolver<TestProjection>> = {},
): NonHeadRegenerateResolver<TestProjection> => ({
  regenerators: () => [],
  selected: (_t, ownerRunId) => ownerRunId,
  ...overrides,
});

const collect = (
  nodes: ConversationNode<TestProjection>[],
  resolver: NonHeadRegenerateResolver<TestProjection> = plainResolver(),
): string[] => collectMessages(nodes, getMessages, resolver).map((m) => m.codecMessageId);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('collectMessages', () => {
  it('concatenates each node projection in chronological order', () => {
    const nodes = [inputNode('u1', ['u1']), runNode('r1', ['a1', 'a2']), inputNode('u2', ['u2'])];
    expect(collect(nodes)).toEqual(['u1', 'a1', 'a2', 'u2']);
  });

  it('emits an empty list for an empty chain', () => {
    expect(collect([])).toEqual([]);
  });

  describe('non-head-regenerate substitution', () => {
    // Owner run r1 emits [a1, a2]; a non-head regenerator r2 replaces a2.
    const owner = runNode('r1', ['a1', 'a2']);
    const regenerator = runNode('r2', ['a2b']);

    it('substitutes the selected regenerator for the target and the run tail', () => {
      const resolver = plainResolver({
        regenerators: (target, predecessor) => (target === 'a2' && predecessor === 'a1' ? [regenerator] : []),
        // Select the regenerator.
        selected: () => 'r2',
      });
      // a2 (and any tail after it) is dropped; r2's a2b replaces it.
      expect(collect([inputNode('u1', ['u1']), owner], resolver)).toEqual(['u1', 'a1', 'a2b']);
    });

    it('keeps the original message when the owner run is selected', () => {
      const resolver = plainResolver({
        regenerators: (target, predecessor) => (target === 'a2' && predecessor === 'a1' ? [regenerator] : []),
        // Default: owner stays selected.
        selected: (_t, ownerRunId) => ownerRunId,
      });
      expect(collect([owner], resolver)).toEqual(['a1', 'a2']);
    });

    it('does not re-emit a substituted regenerator reached directly in the node walk', () => {
      // The regenerator run also appears as its own node later in the chain
      // (e.g. visibleNodes surfaced it); it is skipped in the top-level walk so
      // it is not emitted twice.
      const resolver = plainResolver({
        regenerators: (target, predecessor) => (target === 'a2' && predecessor === 'a1' ? [regenerator] : []),
        selected: () => 'r2',
      });
      expect(collect([owner, regenerator], resolver)).toEqual(['a1', 'a2b']);
    });

    it('surfaces a selected regenerator at every turn that has one (no over-skip)', () => {
      // Two turns, each with its own non-head regenerate selected. Collecting
      // regenerators across the whole chain must not over-skip: ra2 and rb2 each
      // surface via substitution at their own anchor.
      const o1 = runNode('o1', ['a1', 'a2']);
      const ra2 = runNode('ra2', ['a2b']);
      const o2 = runNode('o2', ['b1', 'b2']);
      const rb2 = runNode('rb2', ['b2b']);
      const resolver = plainResolver({
        regenerators: (target, predecessor) => {
          if (target === 'a2' && predecessor === 'a1') return [ra2];
          if (target === 'b2' && predecessor === 'b1') return [rb2];
          return [];
        },
        selected: (target, ownerRunId) => {
          if (target === 'a2') return 'ra2';
          if (target === 'b2') return 'rb2';
          return ownerRunId;
        },
      });
      const chain = [inputNode('u1', ['u1']), o1, ra2, inputNode('u2', ['u2']), o2, rb2];
      expect(collect(chain, resolver)).toEqual(['u1', 'a1', 'a2b', 'u2', 'b1', 'b2b']);
    });

    it('drops a regenerator anchored on the dropped tail of an earlier substitution', () => {
      // Owner r1 = [a1, a2, a3]; ra2 regenerates a2 (selected), ra3 regenerates
      // a3. Selecting ra2 drops a2 AND a3, so ra3 — which only ever replaced the
      // now-dropped a3 — must not surface.
      const ownerWithTail = runNode('r1', ['a1', 'a2', 'a3']);
      const ra2 = runNode('ra2', ['a2b']);
      const ra3 = runNode('ra3', ['a3b']);
      const resolver = plainResolver({
        regenerators: (target, predecessor) => {
          if (target === 'a2' && predecessor === 'a1') return [ra2];
          if (target === 'a3' && predecessor === 'a2') return [ra3];
          return [];
        },
        // ra2 is selected at the a2 slot; every other group keeps its owner.
        selected: (target, ownerRunId) => (target === 'a2' ? 'ra2' : ownerRunId),
      });
      expect(collect([ownerWithTail, ra2, ra3], resolver)).toEqual(['a1', 'a2b']);
    });

    it('drops the regenerator of a regenerator that lives on a dropped tail', () => {
      // The recursive variant: ra3 (which replaced the dropped a3) is itself a
      // multi-message run whose non-head message a3c has its own regenerator
      // ra3prime. Selecting ra2 drops the a3 slot, so neither ra3 nor ra3prime —
      // discoverable only by scanning ra3's own slots — may surface.
      const ownerWithTail = runNode('r1', ['a1', 'a2', 'a3']);
      const ra2 = runNode('ra2', ['a2b']);
      const ra3 = runNode('ra3', ['a3b', 'a3c']);
      const ra3prime = runNode('ra3prime', ['a3cb']);
      const resolver = plainResolver({
        regenerators: (target, predecessor) => {
          if (target === 'a2' && predecessor === 'a1') return [ra2];
          if (target === 'a3' && predecessor === 'a2') return [ra3];
          if (target === 'a3c' && predecessor === 'a3b') return [ra3prime];
          return [];
        },
        selected: (target, ownerRunId) => (target === 'a2' ? 'ra2' : ownerRunId),
      });
      expect(collect([ownerWithTail, ra2, ra3, ra3prime], resolver)).toEqual(['a1', 'a2b']);
    });
  });
});
