/**
 * useActiveTurns: reactive view of active turns on the channel,
 * keyed by clientId.
 *
 * Subscribes to transport turn lifecycle events and maintains a
 * Map<clientId, Set<turnId>> that updates on every turn start/end.
 *
 * Generic — works with any codec, not tied to Vercel types.
 */

import { useEffect, useState } from 'react';

import { EVENT_TURN_START } from '../constants.js';
import type { ClientTransport, TurnLifecycleEvent } from '../core/transport/types.js';

/**
 * Returns a reactive Map of all active turns on the channel, keyed by clientId.
 * Updates when turns start or end.
 * @param transport - The client transport to observe, or null/undefined if not yet available.
 * @returns A Map where keys are clientIds and values are Sets of active turnIds.
 */
export const useActiveTurns = <TEvent, TMessage>(
  transport: ClientTransport<TEvent, TMessage> | null | undefined,
): Map<string, Set<string>> => {
  const [turns, setTurns] = useState<Map<string, Set<string>>>(() => new Map());

  useEffect(() => {
    if (!transport) return;

    // Initialize from current state
    setTurns(transport.getActiveTurnIds());

    const unsubscribe = transport.on('turn', (event: TurnLifecycleEvent) => {
      setTurns((prev) => {
        const next = new Map(prev);

        if (event.type === EVENT_TURN_START) {
          const set = new Set(next.get(event.clientId) ?? []);
          set.add(event.turnId);
          next.set(event.clientId, set);
        } else {
          const set = next.get(event.clientId);
          if (set) {
            set.delete(event.turnId);
            if (set.size === 0) {
              next.delete(event.clientId);
            } else {
              next.set(event.clientId, new Set(set));
            }
          }
        }

        return next;
      });
    });

    return unsubscribe;
  }, [transport]);

  return turns;
};
