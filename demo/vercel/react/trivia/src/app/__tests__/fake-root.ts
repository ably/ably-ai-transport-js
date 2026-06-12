/**
 * In-memory fake of the LiveObjects PathObject surface the demo uses, for
 * unit tests. Pairs with the inline `vi.mock('ably/liveobjects', ...)` factory
 * in each test file: the mocked `LiveMap.create` / `LiveCounter.create` return
 * marker objects this fake materializes into plain state.
 */

import type { LiveMapPathObject } from 'ably/liveobjects';
import type { GameMeta, PlayerEntry, TriviaRoot } from '../lib/trivia';

export interface MapCreateMarker {
  __kind: 'map-create';
  entries: Record<string, unknown>;
}

export interface CounterCreateMarker {
  __kind: 'counter-create';
  count: number;
}

const isMapCreate = (value: unknown): value is MapCreateMarker =>
  typeof value === 'object' && value !== null && (value as { __kind?: string }).__kind === 'map-create';

const isCounterCreate = (value: unknown): value is CounterCreateMarker =>
  typeof value === 'object' && value !== null && (value as { __kind?: string }).__kind === 'counter-create';

export interface FakeState {
  game?: Partial<GameMeta> & Record<string, unknown>;
  players?: Record<string, PlayerEntry>;
  scores?: Record<string, number>;
}

export class FakeRoot {
  state: FakeState;
  private readonly _listeners: Array<() => void> = [];

  constructor(initial: FakeState = {}) {
    this.state = initial;
  }

  notify(): void {
    for (const listener of [...this._listeners]) listener();
  }

  compactJson(): Record<string, unknown> {
    return { game: this.state.game, players: this.state.players, scores: this.state.scores };
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

  async set(key: keyof FakeState, value: unknown): Promise<void> {
    if (!isMapCreate(value)) throw new Error(`fake root.set expects a LiveMap.create value for "${key}"`);
    // CAST: the fake trusts the test to seed entries of the right shape.
    if (key === 'game') this.state.game = { ...value.entries } as FakeState['game'];
    if (key === 'players') this.state.players = { ...value.entries } as FakeState['players'];
    if (key === 'scores') {
      const scores: Record<string, number> = {};
      for (const [k, v] of Object.entries(value.entries)) {
        scores[k] = isCounterCreate(v) ? v.count : 0;
      }
      this.state.scores = scores;
    }
    this.notify();
  }

  get(key: 'game' | 'players' | 'scores'): FakeMapPath {
    return new FakeMapPath(this, key);
  }
}

class FakeMapPath {
  constructor(
    private readonly _root: FakeRoot,
    private readonly _key: 'game' | 'players' | 'scores',
  ) {}

  private get _map(): Record<string, unknown> | undefined {
    return this._root.state[this._key];
  }

  instance(): object | undefined {
    return this._map === undefined ? undefined : {};
  }

  async set(key: string, value: unknown): Promise<void> {
    const map = this._map;
    if (map === undefined) throw new Error(`fake: map "${this._key}" does not exist`);
    map[key] = isCounterCreate(value) ? value.count : value;
    this._root.notify();
  }

  async remove(key: string): Promise<void> {
    const map = this._map;
    if (map === undefined) throw new Error(`fake: map "${this._key}" does not exist`);
    delete map[key];
    this._root.notify();
  }

  /**
   * Mirrors the real batch semantics the demo relies on: the synchronous
   * callback collects operations, they apply together, and observers are
   * notified once for the whole batch.
   */
  async batch(fn: (ctx: { set: (key: string, value: unknown) => void; remove: (key: string) => void }) => void) {
    const map = this._map;
    if (map === undefined) throw new Error(`fake: map "${this._key}" does not exist`);
    const ops: Array<() => void> = [];
    fn({
      set: (key, value) => ops.push(() => (map[key] = isCounterCreate(value) ? value.count : value)),
      remove: (key) => ops.push(() => delete map[key]),
    });
    for (const op of ops) op();
    this._root.notify();
  }

  get(key: string): FakeCounterPath {
    return new FakeCounterPath(this._root, this._key, key);
  }
}

class FakeCounterPath {
  constructor(
    private readonly _root: FakeRoot,
    private readonly _mapKey: 'game' | 'players' | 'scores',
    private readonly _key: string,
  ) {}

  value(): number | undefined {
    const map = this._root.state[this._mapKey];
    const value = map?.[this._key];
    return typeof value === 'number' ? value : undefined;
  }

  async increment(amount: number): Promise<void> {
    const map = this._root.state[this._mapKey];
    const current = map?.[this._key];
    if (map === undefined || typeof current !== 'number') {
      throw new Error(`fake: no counter at ${this._mapKey}.${this._key}`);
    }
    map[this._key] = current + amount;
    this._root.notify();
  }

  async decrement(amount: number): Promise<void> {
    await this.increment(-amount);
  }
}

/** The fake typed as the real root path object the demo code expects. */
export function asRoot(fake: FakeRoot): LiveMapPathObject<TriviaRoot> {
  // CAST: structural fake implementing exactly the PathObject surface the
  // demo uses; unit tests run against mocks per the repo's testing strategy.
  return fake as unknown as LiveMapPathObject<TriviaRoot>;
}
