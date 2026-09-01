/**
 * Tool definitions for the chat demo, mirroring the Vercel demo's three tools.
 *
 * - `getWeather` — server-executed. The agent runs it inside its agentic loop
 *   (see `agent-stream.ts`) and appends the result as a `function_call_output`
 *   item; the run does not suspend.
 * - `getLocation` — client-executed. There is no server executor: the run
 *   suspends after the call, the client runs browser geolocation and publishes
 *   the result as a `function_call_output` item (a `kind: 'item'` input), and
 *   a continuation resumes the run.
 * - `getWeatherForecast` — server-executed but gated on user approval. The run
 *   suspends after the call and the agent publishes an approval request; the
 *   client answers with a `kind: 'approval'` input. On approval the agent runs
 *   the tool server-side on resume; on denial the client authors the rejection
 *   output and the agent resumes without running it.
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

/** One day of a {@link ForecastData} forecast. */
export interface ForecastDay {
  /** Short weekday label (e.g. `Mon`). */
  day: string;
  /** Forecast high in degrees Fahrenheit. */
  high: number;
  /** Forecast low in degrees Fahrenheit. */
  low: number;
  /** Human-readable sky conditions for the day. */
  conditions: string;
}

/** The shape `getWeatherForecast` returns; the client's ForecastCard renders these fields. */
export interface ForecastData {
  /** The location the forecast is for, echoed back from the call arguments. */
  location: string;
  /** The per-day forecast, one entry per day. */
  forecast: ForecastDay[];
}

/**
 * The shape the client's `getLocation` executor returns — browser geolocation
 * coordinates, or an `error` when the browser refuses or lacks support.
 */
export interface LocationData {
  /** The latitude in decimal degrees, absent when `error` is set. */
  latitude?: number;
  /** The longitude in decimal degrees, absent when `error` is set. */
  longitude?: number;
  /** A human-readable failure reason, present when geolocation was unavailable. */
  error?: string;
}

/**
 * The Responses `tools` array advertised to the model: the server-executed
 * `getWeather`, the client-executed `getLocation`, and the approval-gated
 * `getWeatherForecast`.
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
  {
    type: 'function',
    name: 'getLocation',
    description:
      "Get the user's current geographic location from their browser. Call this when the user asks where they are or asks for their location.",
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        highAccuracy: { type: 'boolean', description: 'Whether to request high-accuracy GPS positioning' },
      },
      required: ['highAccuracy'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'getWeatherForecast',
    description:
      'Get a 5-day weather forecast for a location. Requires user approval before executing. Use when the user asks about upcoming weather or a forecast.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'The city and state or country, e.g. "London, UK"' },
      },
      required: ['location'],
      additionalProperties: false,
    },
  },
];

/** Tool names the client executes in the browser — the agent has no server executor for these. */
const CLIENT_TOOLS = new Set(['getLocation']);

/** Tool names gated on a human decision before the agent may run them server-side. */
const APPROVAL_TOOLS = new Set(['getWeatherForecast']);

/** Whether a tool is executed on the client rather than by the agent. */
export function isClientTool(name: string): boolean {
  return CLIENT_TOOLS.has(name);
}

/** Whether a tool must be approved by the user before the agent runs it. */
export function needsApproval(name: string): boolean {
  return APPROVAL_TOOLS.has(name);
}

const CONDITIONS = ['Sunny', 'Partly Cloudy', 'Cloudy', 'Rainy', 'Thunderstorms', 'Snowy'] as const;
const FORECAST_CONDITIONS = ['Sunny', 'Partly Cloudy', 'Cloudy', 'Rainy', 'Thunderstorms'] as const;
const FORECAST_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] as const;

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

/** Produce a mock 5-day forecast for a location. */
function getWeatherForecast(location: string): ForecastData {
  return {
    location,
    forecast: FORECAST_DAYS.map((day) => ({
      day,
      high: Math.round(55 + Math.random() * 35),
      low: Math.round(35 + Math.random() * 25),
      conditions: FORECAST_CONDITIONS[Math.floor(Math.random() * FORECAST_CONDITIONS.length)],
    })),
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
 * for a tool the agent does not run server-side (an unknown name, or a
 * client-executed tool like `getLocation`) — the agent advertises only tools it
 * can produce output for here. The return type is `unknown` deliberately: it is
 * the boundary type for any tool's output, which the agent JSON-serialises onto
 * the wire — callers narrow per tool name when rendering.
 * @param name - The function-call tool name.
 * @param argumentsJson - The call's arguments as a JSON string.
 * @returns The tool's output payload, JSON-serialisable for the wire.
 */
export function executeTool(name: string, argumentsJson: string): unknown {
  if (name === 'getWeather') return getWeather(readLocation(argumentsJson));
  if (name === 'getWeatherForecast') return getWeatherForecast(readLocation(argumentsJson));
  throw new Error(`unknown or non-server tool: ${name}`);
}
