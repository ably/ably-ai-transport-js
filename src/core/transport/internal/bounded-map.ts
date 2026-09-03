/**
 * Helpers for FIFO-bounded `Map`s and `Set`s — collections used as
 * capacity-limited buffers that must evict their oldest entry when full.
 */

/**
 * Make room for a new key in a FIFO-bounded collection: if it is at (or over)
 * `limit` and does not already contain `key`, evict the oldest entry
 * (insertion order) and return its key so the caller can log the eviction.
 * Returns `undefined` when nothing was evicted (the key already exists, the
 * collection is below the limit, or it is empty).
 *
 * The caller performs the actual add/set/append afterwards — this only frees a
 * slot. That is what lets one implementation serve a `Set`, a map whose values
 * are replaced, and a map whose values are appended-to lists.
 * @param collection - The bounded collection to evict from.
 * @param key - The key about to be added; an existing key never evicts.
 * @param limit - The maximum number of entries it may hold.
 * @returns The evicted key, or `undefined` if nothing was evicted.
 */
export const evictOldestIfFull = <K>(collection: Map<K, unknown> | Set<K>, key: K, limit: number): K | undefined => {
  if (collection.has(key) || collection.size < limit) return undefined;
  const oldest = collection.keys().next().value;
  if (oldest === undefined) return undefined;
  collection.delete(oldest);
  return oldest;
};
