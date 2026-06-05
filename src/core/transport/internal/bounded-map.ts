/**
 * Helpers for FIFO-bounded `Map`s — Maps used as capacity-limited buffers that
 * must evict their oldest entry when full.
 */

/**
 * Make room for a new key in a FIFO-bounded map: if `map` is at (or over)
 * `limit` and does not already contain `key`, evict the oldest entry (insertion
 * order) and return its key so the caller can log the eviction. Returns
 * `undefined` when nothing was evicted (the key already exists, the map is
 * below the limit, or it is empty).
 *
 * The caller performs the actual set/append afterwards — this only frees a
 * slot — so it works for maps whose values are replaced and for maps whose
 * values are appended-to lists.
 * @param map - The bounded map to evict from.
 * @param key - The key about to be added; an existing key never evicts.
 * @param limit - The maximum number of entries the map may hold.
 * @returns The evicted key, or `undefined` if nothing was evicted.
 */
export const evictOldestIfFull = <K, V>(map: Map<K, V>, key: K, limit: number): K | undefined => {
  if (map.has(key) || map.size < limit) return undefined;
  const oldest = map.keys().next().value;
  if (oldest === undefined) return undefined;
  map.delete(oldest);
  return oldest;
};
