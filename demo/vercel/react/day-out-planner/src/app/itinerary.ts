/**
 * Shared types for the itinerary stored in the channel's LiveObjects root LiveMap.
 *
 * Each entry is keyed by item id, value is a JSON-stringified ItineraryItem.
 * Whole-item updates only; granular field updates would need nested LiveMaps.
 */

export interface ItineraryItem {
  /** Stable item id chosen by Bernard. */
  id: string;
  /** Display name of the place (e.g. "Cine Belas Artes"). */
  name: string;
  /** Latitude. */
  lat: number;
  /** Longitude. */
  lng: number;
  /** Optional time of day, e.g. "15:30" or "evening". */
  time?: string;
  /** Optional free-form notes (e.g. "Devil Wears Prada 2"). */
  notes?: string;
}

/** Shape of the channel's LiveObjects root, used as a type parameter on get(). */
export type ItineraryRoot = Record<string, string>;
