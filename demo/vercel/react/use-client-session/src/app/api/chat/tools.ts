/**
 * Tool definitions for the chat demo.
 *
 * - getWeather: server-executed, returns mock weather data
 * - getLocation: client-executed, no execute function — the client
 *   runs browser geolocation and sends the result back via view.update()
 * - getWeatherForecast: server-executed but gated on user approval.
 *   `needsApproval` is a function that returns `false` once the matching
 *   `toolCallId` has an `approval-responded` part in the message stream
 *   — per-call approval, not per-tool-name.
 */

import type { ModelMessage, Tool } from 'ai';
import { z } from 'zod';

// `streamText` calls `needsApproval` with the model-message list it's
// about to send to the LLM — `ModelMessage[]`, not `UIMessage[]`. Tool
// approvals show up there as a `tool-approval-request` part on an
// assistant message paired with a `tool-approval-response` part on a
// later tool message; the pair is correlated by `approvalId`, with the
// `toolCallId` only present on the request side.
const isApprovedToolCall = (toolCallId: string, messages: readonly ModelMessage[]): boolean => {
  const approvalIdToToolCallId = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant' || typeof message.content === 'string') continue;
    for (const part of message.content) {
      if (part.type === 'tool-approval-request') {
        approvalIdToToolCallId.set(part.approvalId, part.toolCallId);
      }
    }
  }
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      if (part.type !== 'tool-approval-response' || !part.approved) continue;
      if (approvalIdToToolCallId.get(part.approvalId) === toolCallId) return true;
    }
  }
  return false;
};

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

  getWeatherForecast: {
    description:
      'Get a 5-day weather forecast for a location. Requires user approval before executing. Use when the user asks about upcoming weather or a forecast.',
    needsApproval: (_input, { toolCallId, messages }) => !isApprovedToolCall(toolCallId, messages),
    inputSchema: z.object({
      location: z.string().describe('The city and state or country, e.g. "London, UK"'),
    }),
    execute: async ({ location }: { location: string }) => {
      await new Promise((r) => setTimeout(r, 500));
      const conditions = ['Sunny', 'Partly Cloudy', 'Cloudy', 'Rainy', 'Thunderstorms'] as const;
      const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
      return {
        location,
        forecast: days.map((day) => ({
          day,
          high: Math.round(55 + Math.random() * 35),
          low: Math.round(35 + Math.random() * 25),
          conditions: conditions[Math.floor(Math.random() * conditions.length)],
        })),
      };
    },
  },
};
