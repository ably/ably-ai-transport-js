import type { Tool } from 'ai';
import type { LiveMapPathObject } from 'ably/liveobjects';
import { z } from 'zod';
import type { ItineraryItem, ItineraryRoot } from '../../itinerary';

const itemSchema = z.object({
  id: z
    .string()
    .describe(
      'Stable id for this item — choose a short slug, e.g. "cine-belas-artes". Reuse the same id to update an existing item.',
    ),
  name: z.string().describe('Display name of the place, e.g. "Cine Belas Artes".'),
  lat: z.number().describe('Latitude in decimal degrees.'),
  lng: z.number().describe('Longitude in decimal degrees.'),
  order: z
    .number()
    .describe(
      'Sort key for day-of order; items render in ascending order. Floats are allowed: to insert between two existing items pick any value between their orders (e.g. 1.5 between 1 and 2) so you do not need to update neighbours.',
    ),
  time: z.string().optional().describe('Optional time of day, e.g. "15:30" or "evening".'),
  notes: z.string().optional().describe('Optional short notes — what they will do there, why it was chosen.'),
});

export function buildTools(root: LiveMapPathObject<ItineraryRoot>): Record<string, Tool> {
  return {
    addItineraryItem: {
      description:
        'Add a place to the shared itinerary. Use this once you have decided on a specific venue and roughly where and when. Picks a stable id; reuse the same id later to update.',
      inputSchema: itemSchema,
      execute: async (item: ItineraryItem) => {
        await root.set(item.id, JSON.stringify(item));
        return { ok: true, id: item.id, name: item.name };
      },
    },

    updateItineraryItem: {
      description:
        'Replace an existing itinerary item by id. Provide the full item — partial updates are not supported.',
      inputSchema: itemSchema,
      execute: async (item: ItineraryItem) => {
        await root.set(item.id, JSON.stringify(item));
        return { ok: true, id: item.id, name: item.name };
      },
    },

    removeItineraryItem: {
      description: 'Remove an itinerary item by id.',
      inputSchema: z.object({
        id: z.string().describe('Id of the item to remove.'),
      }),
      execute: async ({ id }: { id: string }) => {
        await root.remove(id);
        return { ok: true, id };
      },
    },
  };
}
