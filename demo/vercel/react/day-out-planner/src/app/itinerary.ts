/**
 * Shared types for the itinerary.
 *
 * The itinerary is a single LiveObjects root LiveMap on the session's channel:
 * one entry per place, keyed by item id, whose value is a JSON-stringified
 * {@link ItineraryItem}. Whole-item updates only — granular field updates would
 * need nested LiveMaps.
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
  /**
   * Sort key for the day-of order. Items are rendered in ascending `order`.
   * Floats are intentional so Bernard can insert between two existing items
   * by picking any value between their orders (e.g. 1.5 between 1 and 2)
   * without having to re-emit every neighbour.
   */
  order: number;
  /** Optional time of day, e.g. "15:30" or "evening". */
  time?: string;
  /** Optional free-form notes (e.g. "Devil Wears Prada 2"). */
  notes?: string;
}

/** Shape of the itinerary root LiveMap: item id → JSON-stringified {@link ItineraryItem}. */
export type ItineraryRoot = Record<string, string>;
