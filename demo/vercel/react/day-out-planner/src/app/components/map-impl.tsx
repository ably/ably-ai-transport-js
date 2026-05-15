'use client';

import { useEffect } from 'react';
import L from 'leaflet';
import { MapContainer, Marker, Popup, TileLayer, useMap } from 'react-leaflet';
import type { ItineraryItem } from '../itinerary';

L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

const DEFAULT_CENTER: [number, number] = [-23.561, -46.656]; // São Paulo — matches the example interaction
const DEFAULT_ZOOM = 13;

function FitToItems({ items }: { items: ItineraryItem[] }) {
  const map = useMap();
  useEffect(() => {
    if (items.length === 0) return;
    if (items.length === 1) {
      map.setView([items[0].lat, items[0].lng], 14);
      return;
    }
    const bounds = L.latLngBounds(items.map((i) => [i.lat, i.lng]));
    map.fitBounds(bounds, { padding: [40, 40] });
  }, [items, map]);
  return null;
}

export default function MapImpl({ items }: { items: ItineraryItem[] }) {
  return (
    <MapContainer
      center={DEFAULT_CENTER}
      zoom={DEFAULT_ZOOM}
      scrollWheelZoom
      className="h-full w-full"
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <FitToItems items={items} />
      {items.map((item) => (
        <Marker
          key={item.id}
          position={[item.lat, item.lng]}
        >
          <Popup>
            <div className="text-sm">
              <div className="font-medium">{item.name}</div>
              {item.time && <div className="text-xs text-zinc-500">{item.time}</div>}
              {item.notes && <div className="mt-1 text-xs">{item.notes}</div>}
            </div>
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}
