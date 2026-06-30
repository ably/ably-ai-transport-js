// jsdom 26 under Node's experimental localStorage does not expose a working
// Storage (getItem/setItem/clear are absent), so components that read
// localStorage on mount (e.g. the debug pane's open/closed preference) throw in
// tests. Install a minimal in-memory Storage when the environment's one is
// non-functional. No-op when a real localStorage is present.
function installMemoryStorage(): void {
  const probe = globalThis.localStorage as Storage | undefined;
  if (probe && typeof probe.getItem === 'function') return;

  const store = new Map<string, string>();
  const memoryStorage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => (store.has(key) ? (store.get(key) as string) : null),
    key: (index) => Array.from(store.keys())[index] ?? null,
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, String(value));
    },
  };

  Object.defineProperty(globalThis, 'localStorage', {
    value: memoryStorage,
    configurable: true,
    writable: true,
  });
}

installMemoryStorage();
