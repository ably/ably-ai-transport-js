'use client';

/**
 * React hook over the channel's LiveObjects checklist state.
 *
 * There are no first-party LiveObjects React hooks, so this is the demo's
 * reference implementation of the documented imperative read pattern: resolve
 * the root once, snapshot it, subscribe (nested changes included by default),
 * and re-snapshot on every update via `compactJson()`.
 *
 * The checklist is read-only on the client — the agent is the only writer — so
 * unlike a collaborative object this hook has no write or self-heal path.
 */

import { useEffect, useState } from 'react';
import type { RealtimeObject } from 'ably/liveobjects';
import { checklistFrom, type ChecklistItemRow, type ChecklistRoot } from '../lib/checklist';

/** What {@link useChecklist} returns. */
export interface ChecklistHandle {
  /** Latest validated steps, in checklist order. Empty until the root resolves. */
  steps: ChecklistItemRow[];
  /** Set if resolving the root failed (e.g. the LiveObjects plugin or object modes are missing). */
  error: Error | undefined;
}

/**
 * Read the checklist off a channel's LiveObjects entry point
 * (`channel.object`), re-snapshotting on every object update.
 * @param object - The channel's LiveObjects entry point.
 * @returns The validated steps and any resolution error.
 */
export function useChecklist(object: RealtimeObject): ChecklistHandle {
  const [steps, setSteps] = useState<ChecklistItemRow[]>([]);
  const [error, setError] = useState<Error | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    let subscription: { unsubscribe: () => void } | undefined;

    const start = async () => {
      const root = await object.get<ChecklistRoot>();
      if (cancelled) return;
      setSteps(checklistFrom(root.compactJson()));
      subscription = root.subscribe(() => {
        setSteps(checklistFrom(root.compactJson()));
      });
    };

    start().catch((err: unknown) => {
      if (cancelled) return;
      setError(err instanceof Error ? err : new Error(String(err)));
    });

    return () => {
      cancelled = true;
      subscription?.unsubscribe();
    };
  }, [object]);

  return { steps, error };
}
