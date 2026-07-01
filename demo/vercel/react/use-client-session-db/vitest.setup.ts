/**
 * Vitest setup — polyfill `localStorage` for the jsdom environment.
 *
 * The jsdom build used here exposes a `localStorage` object whose `Storage`
 * methods (`getItem` / `setItem` / …) are not callable, so components that
 * persist UI state to it (the DebugPane's open/closed flag) throw at render.
 * Install a minimal in-memory `Storage` so those code paths run under test.
 */

class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) ?? null) : null;
  }

  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

const storage = new MemoryStorage();
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
}
