/**
 * In-memory fake of the LiveObjects root PathObject surface the checklist uses,
 * for unit tests. The checklist keeps its steps directly on the root map, so
 * the fake only needs `compactJson`, `subscribe`, and `batch`.
 */

import type { ChecklistRootPath } from '../lib/checklist';

export class FakeRoot {
  state: Record<string, unknown>;
  private readonly _listeners: Array<() => void> = [];

  constructor(initial: Record<string, unknown> = {}) {
    this.state = initial;
  }

  notify(): void {
    for (const listener of [...this._listeners]) listener();
  }

  compactJson(): Record<string, unknown> {
    // Return a copy so callers can't mutate the fake's state by reference.
    return { ...this.state };
  }

  subscribe(listener: () => void): { unsubscribe: () => void } {
    this._listeners.push(listener);
    return {
      unsubscribe: () => {
        const index = this._listeners.indexOf(listener);
        if (index !== -1) this._listeners.splice(index, 1);
      },
    };
  }

  /**
   * Mirrors the real batch semantics the demo relies on: the synchronous
   * callback collects operations, they apply together, and observers are
   * notified once for the whole batch.
   */
  async batch(fn: (ctx: { set: (key: string, value: unknown) => void; remove: (key: string) => void }) => void) {
    const ops: Array<() => void> = [];
    fn({
      set: (key, value) => ops.push(() => (this.state[key] = value)),
      remove: (key) => ops.push(() => delete this.state[key]),
    });
    for (const op of ops) op();
    this.notify();
  }
}

/** The fake typed as the real root path object the demo code expects. */
export function asRoot(fake: FakeRoot): ChecklistRootPath {
  // CAST: structural fake implementing exactly the PathObject surface the
  // checklist uses; unit tests run against mocks per the repo's testing strategy.
  return fake as unknown as ChecklistRootPath;
}
