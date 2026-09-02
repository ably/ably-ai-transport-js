/**
 * Shorten an id for a badge.
 *
 * WDK and AIT ids share long, low-entropy prefixes (`run:wrun_…`, `wrun_…`,
 * `step_…`) and are ULID-time-ordered, so ids minted in the same turn agree on
 * their leading characters — slicing from the front makes a run, a step, and a
 * workflow all read as `…_01K…`. The random tail is what distinguishes them, so
 * show that. (A run derived from a workflow keeps the workflow's tail on
 * purpose — the shared tail reads as the correlation it is.)
 * @param id - The id to shorten.
 * @param tail - How many trailing characters to keep (default 6).
 * @returns The last `tail` characters, prefixed with an ellipsis when truncated.
 */
export function shortId(id: string, tail = 6): string {
  return id.length > tail ? `…${id.slice(-tail)}` : id;
}
