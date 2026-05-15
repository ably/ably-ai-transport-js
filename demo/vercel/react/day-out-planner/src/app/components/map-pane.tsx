'use client';

import dynamic from 'next/dynamic';
import type { ItineraryItem } from '../itinerary';

const MapImpl = dynamic(() => import('./map-impl'), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-xs text-zinc-600">Loading map...</div>,
});

export function MapPane({ items }: { items: ItineraryItem[] }) {
  return (
    <div className="h-full w-full">
      <MapImpl items={items} />
    </div>
  );
}
