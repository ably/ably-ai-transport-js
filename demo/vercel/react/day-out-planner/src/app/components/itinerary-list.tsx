'use client';

import type { ItineraryItem } from '../itinerary';

export function ItineraryList({ items }: { items: ItineraryItem[] }) {
  if (items.length === 0) {
    return (
      <div className="px-4 py-3 text-xs text-zinc-600">
        Itinerary is empty. Mention <span className="font-mono text-zinc-400">@bernard</span> to add places.
      </div>
    );
  }

  return (
    <ol className="divide-y divide-zinc-800">
      {items.map((item, index) => (
        <li
          key={item.id}
          className="flex gap-3 px-4 py-3"
        >
          <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-600 text-[11px] font-semibold text-white">
            {index + 1}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-medium text-zinc-100">{item.name}</span>
              {item.time && <span className="text-xs text-zinc-500">{item.time}</span>}
            </div>
            {item.notes && <div className="mt-0.5 text-xs text-zinc-400">{item.notes}</div>}
            <div className="mt-0.5 text-[10px] font-mono text-zinc-600">
              {item.lat.toFixed(3)}, {item.lng.toFixed(3)}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
