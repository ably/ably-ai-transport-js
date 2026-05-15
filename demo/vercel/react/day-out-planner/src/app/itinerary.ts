/**
 * Shared types for the itinerary stored in a sibling channel's LiveObjects
 * root LiveMap.
 *
 * Each entry is keyed by item id, value is a JSON-stringified ItineraryItem.
 * Whole-item updates only; granular field updates would need nested LiveMaps.
 *
 * The itinerary lives on a separate channel (`<chat channel>:itinerary`) from
 * the chat because the AI Transport SDK fetches the chat channel with its own
 * `channels.get()` call that wipes the channel's modes, and there is no
 * public way to pass `modes` through `ClientSessionOptions` /
 * `AgentSessionOptions`. Using a sibling channel keeps LiveObjects-required
 * modes (OBJECT_PUBLISH, OBJECT_SUBSCRIBE) untouched by the SDK.
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

/** Shape of the itinerary channel's LiveObjects root, used as a type parameter on get(). */
export type ItineraryRoot = Record<string, string>;

/** Derive the itinerary channel name from the chat channel name. */
export function itineraryChannelName(chatChannelName: string): string {
  return `${chatChannelName}:itinerary`;
}
