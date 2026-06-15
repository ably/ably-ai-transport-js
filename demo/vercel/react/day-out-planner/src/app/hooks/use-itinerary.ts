'use client';

import { useEffect, useState } from 'react';
import type { RealtimeObject, LiveMapPathObject } from 'ably/liveobjects';
import { type ItineraryItem, type ItineraryRoot } from '../itinerary';

function parseItem(id: string, raw: string): ItineraryItem | null {
  try {
    // CAST: JSON.parse returns unknown; we narrow each field below before constructing the item.
    const parsed = JSON.parse(raw) as Partial<ItineraryItem>;
    if (
      typeof parsed.name !== 'string' ||
      typeof parsed.lat !== 'number' ||
      typeof parsed.lng !== 'number' ||
      typeof parsed.order !== 'number'
    ) {
      return null;
    }
    return {
      id,
      name: parsed.name,
      lat: parsed.lat,
      lng: parsed.lng,
      order: parsed.order,
      time: typeof parsed.time === 'string' ? parsed.time : undefined,
      notes: typeof parsed.notes === 'string' ? parsed.notes : undefined,
    };
  } catch {
    return null;
  }
}

function snapshotItems(root: LiveMapPathObject<ItineraryRoot>): ItineraryItem[] {
  const data = root.compactJson();
  if (!data || 'objectId' in data) return [];
  const items: ItineraryItem[] = [];
  for (const [id, value] of Object.entries(data)) {
    if (typeof value !== 'string') continue;
    const item = parseItem(id, value);
    if (item) items.push(item);
  }
  items.sort((a, b) => a.order - b.order);
  return items;
}

/**
 * Subscribe to the itinerary stored in the session channel's LiveObjects root
 * LiveMap and return the items sorted by `order`. `objects` is the session's
 * `object` accessor (`session.object`).
 */
export function useItinerary(objects: RealtimeObject): ItineraryItem[] {
  const [items, setItems] = useState<ItineraryItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    (async () => {
      const root = await objects.get<ItineraryRoot>();
      if (cancelled) return;
      setItems(snapshotItems(root));
      const sub = root.subscribe(() => {
        setItems(snapshotItems(root));
      });
      if (cancelled) {
        sub.unsubscribe();
        return;
      }
      unsubscribe = () => sub.unsubscribe();
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [objects]);

  return items;
}
