/**
 * Tool definitions for the chat demo.
 *
 * `getWeather` is server-executed: the agent runs it inside its agentic loop
 * (see `agent-stream.ts`) and appends the result as a `function_call_output`
 * item — the run never suspends. This mirrors the Vercel demo's server-executed
 * `getWeather` tool. Client-executed and approval-gated tools are a later
 * increment.
 */

import type { Responses } from 'openai/resources/responses/responses';

/** The shape `getWeather` returns; the client's WeatherCard renders these fields. */
export interface WeatherData {
  /** The location the weather is for, echoed back from the call arguments. */
  location: string;
  /** Current temperature in degrees Fahrenheit. */
  temperature: number;
  /** Temperature unit (always `fahrenheit` in this mock). */
  unit: 'fahrenheit';
  /** Human-readable sky conditions (e.g. `Sunny`). */
  conditions: string;
  /** Relative humidity as a percentage. */
  humidity: number;
  /** Wind speed in miles per hour. */
  windSpeed: number;
}

/**
 * The Responses `tools` array advertised to the model. A single server-executed
 * function tool, `getWeather`.
 */
export const tools: Responses.Tool[] = [
  {
    type: 'function',
    name: 'getWeather',
    description: 'Get the current weather for a location. Call this when the user asks about weather.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'The city and state or country, e.g. "San Francisco, CA"' },
      },
      required: ['location'],
      additionalProperties: false,
    },
  },
];

const CONDITIONS = ['Sunny', 'Partly Cloudy', 'Cloudy', 'Rainy', 'Thunderstorms', 'Snowy'] as const;

/** Produce mock weather for a location (stands in for a real weather API call). */
function getWeather(location: string): WeatherData {
  return {
    location,
    temperature: Math.round(50 + Math.random() * 40),
    unit: 'fahrenheit',
    conditions: CONDITIONS[Math.floor(Math.random() * CONDITIONS.length)],
    humidity: Math.round(30 + Math.random() * 50),
    windSpeed: Math.round(5 + Math.random() * 20),
  };
}

/** Parse the `location` argument from a function call's JSON arguments string. */
function readLocation(argumentsJson: string): string {
  try {
    // CAST: trust boundary — the model's arguments string is parsed JSON.
    const parsed = JSON.parse(argumentsJson) as { location?: unknown };
    return typeof parsed.location === 'string' ? parsed.location : 'your location';
  } catch {
    return 'your location';
  }
}

/**
 * Execute a server-side tool call by name and return its output payload. Throws
 * for an unknown tool — the agent advertises only the tools it can run. The
 * return type is `unknown` deliberately: it is the boundary type for any tool's
 * output (only `getWeather` today), which the agent JSON-serialises onto the
 * wire — callers narrow per tool name when rendering.
 * @param name - The function-call tool name.
 * @param argumentsJson - The call's arguments as a JSON string.
 * @returns The tool's output payload, JSON-serialisable for the wire.
 */
export function executeTool(name: string, argumentsJson: string): unknown {
  if (name === 'getWeather') return getWeather(readLocation(argumentsJson));
  throw new Error(`unknown tool: ${name}`);
}
