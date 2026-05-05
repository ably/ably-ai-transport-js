/**
 * useActiveRuns: reactive view of active runs on the channel,
 * keyed by clientId.
 *
 * Subscribes to session tree run lifecycle events and maintains a
 * Map<clientId, Set<runId>> that updates on every run start/end.
 *
 * Uses tree (not view) so that all runs are tracked — including remote
 * runs whose messages haven't arrived yet.
 *
 * Generic — works with any codec, not tied to Vercel types.
 */

import { useEffect, useState } from 'react';

import { EVENT_RUN_START } from '../constants.js';
import type { RunLifecycleEvent } from '../core/transport/types.js';
import type { BaseSessionOption } from './internal/use-resolved-session.js';
import { useResolvedSession } from './internal/use-resolved-session.js';

/** Options for {@link useActiveRuns}. */
export interface UseActiveRunsOptions<TEvent, TMessage> extends BaseSessionOption<TEvent, TMessage> {
  /** When `true`, skip all subscriptions and return an empty Map immediately. */
  skip?: boolean;
}

/**
 * Returns a reactive Map of all active runs on the channel, keyed by clientId.
 * Updates when runs start or end. When `session` is omitted, uses the nearest
 * {@link ClientSessionProvider}'s session via context. When `skip` is `true`, returns
 * an empty Map without subscribing.
 * @param props - Options including optional `session` and `skip`.
 * @param props.session - Session to track runs for; defaults to the nearest provider.
 * @param props.skip - When `true`, skip all subscriptions and return an empty Map.
 * @returns A Map where keys are clientIds and values are Sets of active runIds.
 */
export const useActiveRuns = <TEvent, TMessage>({ session, skip }: UseActiveRunsOptions<TEvent, TMessage> = {}): Map<
  string,
  Set<string>
> => {
  const resolved = useResolvedSession({ session, skip });

  const [runs, setRuns] = useState<Map<string, Set<string>>>(() => new Map());

  useEffect(() => {
    if (!resolved) {
      setRuns(new Map());
      return;
    }

    // Initialize from current state
    setRuns(resolved.tree.getActiveRunIds());

    const unsubscribe = resolved.tree.on('run', (event: RunLifecycleEvent) => {
      setRuns((prev) => {
        const next = new Map(prev);

        if (event.type === EVENT_RUN_START) {
          const set = new Set(next.get(event.clientId));
          set.add(event.runId);
          next.set(event.clientId, set);
        } else {
          const existing = next.get(event.clientId);
          if (existing) {
            const updated = new Set(existing);
            updated.delete(event.runId);
            if (updated.size === 0) {
              next.delete(event.clientId);
            } else {
              next.set(event.clientId, updated);
            }
          }
        }

        return next;
      });
    });

    return unsubscribe;
  }, [resolved]);

  return runs;
};
