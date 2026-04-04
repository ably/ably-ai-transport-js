/**
 * Tool definitions for the chat demo.
 *
 * - getWeather: server-executed, returns mock weather data
 * - getLocation: client-executed, no execute function — the client
 *   runs browser geolocation and sends the result back via view.update()
 */

import type { Tool } from 'ai';
import { z } from 'zod';

const weatherInput = z.object({
  location: z.string().describe('The city and state or country, e.g. "San Francisco, CA"'),
});

const locationOutput = z.object({
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  error: z.string().optional(),
});

export const tools: Record<string, Tool> = {
  getWeather: {
    description: 'Get the current weather for a location. Call this when the user asks about weather.',
    inputSchema: weatherInput,
    execute: async ({ location }: { location: string }) => {
      // Simulate a weather API call
      await new Promise((r) => setTimeout(r, 500));
      const conditions = ['Sunny', 'Partly Cloudy', 'Cloudy', 'Rainy', 'Thunderstorms', 'Snowy'] as const;
      return {
        location,
        temperature: Math.round(50 + Math.random() * 40),
        unit: 'fahrenheit' as const,
        conditions: conditions[Math.floor(Math.random() * conditions.length)],
        humidity: Math.round(30 + Math.random() * 50),
        windSpeed: Math.round(5 + Math.random() * 20),
      };
    },
  },

  getLocation: {
    description: `Get the user's current geographic location from their browser. Call this when the user doesn't specify a location, then call getWeather with the result.`,
    inputSchema: z.object({
      highAccuracy: z.boolean().describe('Whether to request high-accuracy GPS positioning'),
    }),
    // No execute — client-side tool. The client runs navigator.geolocation
    // and sends the result via view.update().
    outputSchema: locationOutput,
  },
};
