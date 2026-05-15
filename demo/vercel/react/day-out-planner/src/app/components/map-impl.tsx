'use client';

import { useEffect, useState } from 'react';
import L from 'leaflet';
import { MapContainer, Marker, Polyline, Popup, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import type { ItineraryItem } from '../itinerary';

const DEFAULT_CENTER: [number, number] = [-23.561, -46.656]; // São Paulo — matches the example interaction
const DEFAULT_ZOOM = 13;

/** Half the badge size in screen pixels, plus a small gap. */
const ARROW_OFFSET_FROM_BADGE_PX = 20;

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

/**
 * Arrowhead marker pointing along its segment. Angle is in degrees clockwise
 * from screen-up (matches CSS `transform: rotate`).
 */
function arrowIcon(angleDeg: number): L.DivIcon {
  return L.divIcon({
    className: 'day-out-planner-arrow',
    html: `<div style="transform: rotate(${angleDeg}deg); transform-origin: center;">
      <svg width="14" height="14" viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg">
        <path d="M7 1 L12 12 L7 9 L2 12 Z" fill="#d97706" stroke="white" stroke-width="1" stroke-linejoin="round"/>
      </svg>
    </div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

interface ArrowAnchor {
  key: string;
  position: L.LatLng;
  angle: number;
}

/**
 * Compute arrow anchors in pixel space so each arrow sits a fixed number of
 * screen pixels before the destination badge, regardless of zoom. Returns an
 * empty array for segments shorter than the badge offset (no room for an arrow).
 */
function arrowAnchors(map: L.Map, items: ItineraryItem[]): ArrowAnchor[] {
  const anchors: ArrowAnchor[] = [];
  for (let i = 0; i < items.length - 1; i++) {
    const a = items[i];
    const b = items[i + 1];
    const pa = map.latLngToContainerPoint([a.lat, a.lng]);
    const pb = map.latLngToContainerPoint([b.lat, b.lng]);
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const length = Math.hypot(dx, dy);
    if (length <= ARROW_OFFSET_FROM_BADGE_PX) continue;
    const t = (length - ARROW_OFFSET_FROM_BADGE_PX) / length;
    const arrowPx = L.point(pa.x + dx * t, pa.y + dy * t);
    // CSS rotation: 0deg points up the screen, positive clockwise. In screen
    // coords y grows downward, so the angle from up is atan2(dx, -dy).
    const angle = (Math.atan2(dx, -dy) * 180) / Math.PI;
    anchors.push({
      key: `${a.id}->${b.id}`,
      position: map.containerPointToLatLng(arrowPx),
      angle,
    });
  }
  return anchors;
}

/**
 * Renders the arrow markers. Lives inside MapContainer because it needs the
 * map instance and must recompute when the user pans/zooms (screen-space
 * geometry changes with both).
 */
function ArrowMarkers({ items }: { items: ItineraryItem[] }) {
  const map = useMap();
  const [tick, setTick] = useState(0);
  useMapEvents({
    zoomend: () => setTick((n) => n + 1),
    moveend: () => setTick((n) => n + 1),
  });
  // tick is read here to retain the dependency for re-renders.
  void tick;
  const anchors = arrowAnchors(map, items);
  return (
    <>
      {anchors.map((arrow) => (
        <Marker
          key={arrow.key}
          position={arrow.position}
          icon={arrowIcon(arrow.angle)}
          interactive={false}
          keyboard={false}
        />
      ))}
    </>
  );
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
      <ArrowMarkers items={items} />
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
