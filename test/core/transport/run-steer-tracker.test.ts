import { describe, expect, it } from 'vitest';

import { RunSteerTracker } from '../../../src/core/transport/run-steer-tracker.js';

describe('RunSteerTracker', () => {
  describe('addPending / hasPending', () => {
    it('reports false on an empty tracker', () => {
      const t = new RunSteerTracker();
      expect(t.hasPending()).toBe(false);
    });

    it('reports true after adding a pending id', () => {
      const t = new RunSteerTracker();
      t.addPending('id-1');
      expect(t.hasPending()).toBe(true);
    });

    it('dedups repeated adds of the same id', () => {
      const t = new RunSteerTracker();
      t.addPending('id-1');
      t.addPending('id-1');
      t.drainPending();
      expect(t.consumeRecentlyProcessed()).toEqual(['id-1']);
    });
  });

  describe('drainPending', () => {
    it('clears pending and moves ids into "recently processed"', () => {
      const t = new RunSteerTracker();
      t.addPending('id-1');
      t.addPending('id-2');
      t.drainPending();
      expect(t.hasPending()).toBe(false);
      expect(t.consumeRecentlyProcessed()).toEqual(['id-1', 'id-2']);
    });

    it('is a no-op when nothing is pending', () => {
      const t = new RunSteerTracker();
      t.drainPending();
      expect(t.hasPending()).toBe(false);
      expect(t.consumeRecentlyProcessed()).toEqual([]);
    });

    it('accumulates ids across multiple drains until consumed', () => {
      const t = new RunSteerTracker();
      t.addPending('a');
      t.drainPending();
      t.addPending('b');
      t.drainPending();
      // Both ids should be available — the next pipe stamps them as one delta.
      expect(t.consumeRecentlyProcessed()).toEqual(['a', 'b']);
    });
  });

  describe('consumeRecentlyProcessed', () => {
    it('returns ids and clears the internal set', () => {
      const t = new RunSteerTracker();
      t.addPending('id-1');
      t.drainPending();
      expect(t.consumeRecentlyProcessed()).toEqual(['id-1']);
      // Second consume after no new drains returns empty.
      expect(t.consumeRecentlyProcessed()).toEqual([]);
    });

    it('only returns ids drained since the previous consume', () => {
      const t = new RunSteerTracker();
      t.addPending('a');
      t.drainPending();
      t.consumeRecentlyProcessed();
      t.addPending('b');
      t.drainPending();
      // The next consume sees only the new id; "a" was stamped on a prior pipe.
      expect(t.consumeRecentlyProcessed()).toEqual(['b']);
    });
  });
});
