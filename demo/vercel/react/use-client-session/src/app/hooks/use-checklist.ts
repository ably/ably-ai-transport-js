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

/** The slice of a session this hook needs — a ClientSession satisfies it. */
export interface ObjectSession {
  /** The Ably LiveObjects entry point for the session's channel. */
  object: RealtimeObject;
}

/** What {@link useChecklist} returns. */
export interface ChecklistHandle {
  /** Latest validated steps, in checklist order. Empty until the root resolves. */
  steps: ChecklistItemRow[];
  /** Set if resolving the root failed (e.g. the LiveObjects plugin or object modes are missing). */
  error: Error | undefined;
}

export function useChecklist(session: ObjectSession): ChecklistHandle {
  const [steps, setSteps] = useState<ChecklistItemRow[]>([]);
  const [error, setError] = useState<Error | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    let subscription: { unsubscribe: () => void } | undefined;

    const start = async () => {
      const root = await session.object.get<ChecklistRoot>();
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
  }, [session]);

  return { steps, error };
}
