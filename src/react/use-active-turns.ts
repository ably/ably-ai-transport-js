/**
 * useActiveTurns: reactive view of active turns on the channel,
 * keyed by clientId.
 *
 * Subscribes to transport tree turn lifecycle events and maintains a
 * Map<clientId, Set<turnId>> that updates on every turn start/end.
 *
 * Uses tree (not view) so that all turns are tracked — including remote
 * turns whose messages haven't arrived yet.
 *
 * Generic — works with any codec, not tied to Vercel types.
 */

import { useContext, useEffect, useState } from 'react';

import { EVENT_TURN_START } from '../constants.js';
import type { ClientTransport, TurnLifecycleEvent } from '../core/transport/types.js';
import { NearestTransportContext } from './contexts/transport-context.js';

/**
 * Returns a reactive Map of all active turns on the channel, keyed by clientId.
 * Updates when turns start or end. When `transport` is omitted, uses the nearest
 * {@link TransportProvider}'s transport via context.
 * @param props - Options including optional `transport`.
 * @param props.transport - Transport to track turns for; defaults to the nearest provider.
 * @returns A Map where keys are clientIds and values are Sets of active turnIds.
 */
export const useActiveTurns = <TEvent, TMessage>({
  transport,
}: { transport?: ClientTransport<TEvent, TMessage> | null } = {}): Map<string, Set<string>> => {
  const nearestSlot = useContext(NearestTransportContext);
  // CAST: NearestTransportContext stores transport with erased generics; types fixed at call site.
  const resolved = (transport ?? nearestSlot?.transport) as ClientTransport<TEvent, TMessage> | undefined;

  const [turns, setTurns] = useState<Map<string, Set<string>>>(() => new Map());

  useEffect(() => {
    if (!resolved) return;

    // Initialize from current state
    setTurns(resolved.tree.getActiveTurnIds());

    const unsubscribe = resolved.tree.on('turn', (event: TurnLifecycleEvent) => {
      setTurns((prev) => {
        const next = new Map(prev);

        if (event.type === EVENT_TURN_START) {
          const set = new Set(next.get(event.clientId));
          set.add(event.turnId);
          next.set(event.clientId, set);
        } else {
          const existing = next.get(event.clientId);
          if (existing) {
            const updated = new Set(existing);
            updated.delete(event.turnId);
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

  return turns;
};
