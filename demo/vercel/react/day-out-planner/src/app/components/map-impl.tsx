'use client';

import { useEffect } from 'react';
import L from 'leaflet';
import { MapContainer, Marker, Polyline, Popup, TileLayer, useMap } from 'react-leaflet';
import type { ItineraryItem } from '../itinerary';

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

function numberedIcon(position: number): L.DivIcon {
  return L.divIcon({
    className: 'day-out-planner-marker',
    html: `<div style="
      width: 28px; height: 28px; border-radius: 9999px;
      background: #d97706; color: white;
      display: flex; align-items: center; justify-content: center;
      font: 600 13px/1 system-ui, sans-serif;
      box-shadow: 0 1px 4px rgba(0,0,0,0.4);
      border: 2px solid white;
    ">${position}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -14],
  });
}

export default function MapImpl({ items }: { items: ItineraryItem[] }) {
  const path: [number, number][] = items.map((i) => [i.lat, i.lng]);

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
      {path.length >= 2 && (
        <Polyline
          positions={path}
          pathOptions={{ color: '#d97706', weight: 3, opacity: 0.75, dashArray: '6 6' }}
        />
      )}
      {items.map((item, index) => (
        <Marker
          key={item.id}
          position={[item.lat, item.lng]}
          icon={numberedIcon(index + 1)}
        >
          <Popup>
            <div className="text-sm">
              <div className="font-medium">
                {index + 1}. {item.name}
              </div>
              {item.time && <div className="text-xs text-zinc-500">{item.time}</div>}
              {item.notes && <div className="mt-1 text-xs">{item.notes}</div>}
            </div>
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}
