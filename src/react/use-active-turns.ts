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

import { useEffect, useState } from 'react';

import { EVENT_TURN_START } from '../constants.js';
import type { TurnLifecycleEvent } from '../core/transport/types.js';
import type { BaseTransportOption } from './internal/use-resolved-transport.js';
import { useResolvedTransport } from './internal/use-resolved-transport.js';

/** Options for {@link useActiveTurns}. */
export interface UseActiveTurnsOptions<TEvent, TMessage> extends BaseTransportOption<TEvent, TMessage> {
  /** When `true`, skip all subscriptions and return an empty Map immediately. */
  skip?: boolean;
}

/**
 * Returns a reactive Map of all active turns on the channel, keyed by clientId.
 * Updates when turns start or end. When `transport` is omitted, uses the nearest
 * {@link TransportProvider}'s transport via context. When `skip` is `true`, returns
 * an empty Map without subscribing.
 * @param props - Options including optional `transport` and `skip`.
 * @param props.transport - Transport to track turns for; defaults to the nearest provider.
 * @param props.skip - When `true`, skip all subscriptions and return an empty Map.
 * @returns A Map where keys are clientIds and values are Sets of active turnIds.
 */
export const useActiveTurns = <TEvent, TMessage>({
  transport,
  skip,
}: UseActiveTurnsOptions<TEvent, TMessage> = {}): Map<string, Set<string>> => {
  const resolved = useResolvedTransport({ transport, skip });

  const [turns, setTurns] = useState<Map<string, Set<string>>>(() => new Map());

  useEffect(() => {
    if (!resolved) {
      setTurns(new Map());
      return;
    }

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
