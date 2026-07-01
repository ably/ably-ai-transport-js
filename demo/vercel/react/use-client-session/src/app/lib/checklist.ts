/**
 * Shared checklist types and pure helpers, used by both the browser UI and the
 * agent endpoint.
 *
 * The checklist is the agent's live task list for a multi-step request. It
 * lives directly on the session channel's root object (a `LiveMap`) in Ably
 * LiveObjects, keyed by the step's 1-based position as a string ("1", "2", …).
 * Each entry carries the step text and its status, and the agent flips one
 * step's status at a time — a granular field update on shared state, synced to
 * every client without resending the rest of the list.
 *
 * Write ownership: the agent is the only writer (through the updateChecklist
 * tool); every client is read-only. With a single writer there are no
 * last-write-wins races to reconcile and the client never has to create or
 * heal structure.
 */

import type { LiveMapPathObject } from 'ably/liveobjects';

// ---------------------------------------------------------------------------
// Object schema
// ---------------------------------------------------------------------------

/** The lifecycle of a checklist step, in order. */
export type ChecklistItemStatus = 'pending' | 'active' | 'done';

/** One checklist step — plain JSON, written only by the agent. */
export type ChecklistItem = {
  /** The step description, as the agent phrased it. */
  text: string;
  /** Where the step is in its lifecycle. */
  status: ChecklistItemStatus;
  /** Server clock (ms) at the last write to this step; used for recency. */
  updatedAt: number;
};

/** The structure of the channel's root object: steps keyed by 1-based position. */
export type ChecklistRoot = Record<string, ChecklistItem>;

/** The root path object the agent writes through. */
export type ChecklistRootPath = LiveMapPathObject<ChecklistRoot>;

// ---------------------------------------------------------------------------
// Snapshot — plain-JS view of the object state
// ---------------------------------------------------------------------------

/** One rendered checklist row. */
export interface ChecklistItemRow {
  /** The step's 1-based position in the checklist. */
  index: number;
  /** The step description. */
  text: string;
  /** Where the step is in its lifecycle. */
  status: ChecklistItemStatus;
  /** Server clock (ms) at the last write to this step. */
  updatedAt: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStatus = (value: unknown): value is ChecklistItemStatus =>
  value === 'pending' || value === 'active' || value === 'done';

/** Parse a positive-integer step key, or null if the key isn't one. */
function stepIndex(key: string): number | null {
  if (!/^[1-9]\d*$/.test(key)) return null;
  return Number(key);
}

/**
 * Normalize a root `compactJson()` value into rows, in checklist order.
 *
 * The compacted value is wire-derived state (and typed with `ObjectIdReference`
 * arms for cycles we never create), so every field is runtime-validated rather
 * than trusted; anything malformed is dropped.
 */
export function checklistFrom(compacted: unknown): ChecklistItemRow[] {
  if (!isRecord(compacted)) return [];
  const rows: ChecklistItemRow[] = [];
  for (const [key, entry] of Object.entries(compacted)) {
    const index = stepIndex(key);
    if (index === null || !isRecord(entry)) continue;
    const { text, status, updatedAt } = entry;
    if (typeof text !== 'string' || !isStatus(status) || typeof updatedAt !== 'number') continue;
    rows.push({ index, text, status, updatedAt });
  }
  return rows.sort((a, b) => a.index - b.index);
}
