'use client';

// Type-only import (erased at build time) of the agent's tool-output shape, so
// the renderer and the producer can't drift. No server runtime crosses over.
import type { WeatherData } from '../api/chat/tools';
import type { RenderPart } from '../helpers';

// ---------------------------------------------------------------------------
// Weather card — generative UI for the getWeather tool result
// ---------------------------------------------------------------------------

const conditionIcon: Record<string, string> = {
  Sunny: '☀️',
  'Partly Cloudy': '⛅',
  Cloudy: '☁️',
  Rainy: '🌧️',
  Thunderstorms: '⛈️',
  Snowy: '❄️',
};

/** Narrow a parsed tool output to WeatherData, or return undefined. */
function asWeatherData(output: string): WeatherData | undefined {
  try {
    // CAST: trust boundary — the tool output is parsed JSON from the wire.
    const data = JSON.parse(output) as Partial<WeatherData>;
    if (typeof data.location === 'string' && typeof data.temperature === 'number') {
      // CAST: the guard above confirmed the required fields are present.
      return data as WeatherData;
    }
  } catch {
    // fall through to undefined
  }
  return undefined;
}

function WeatherCard({ data }: { data: WeatherData }) {
  const icon = conditionIcon[data.conditions] ?? '🌤️';
  const tempC = Math.round(((data.temperature - 32) * 5) / 9);

  return (
    <div className="rounded-lg bg-gradient-to-br from-sky-900/40 to-indigo-900/40 border border-sky-800/30 p-3 my-1 max-w-[280px]">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-xs text-sky-400/80 font-medium">{data.location}</div>
          <div className="text-2xl font-semibold text-zinc-100 mt-0.5">
            {data.temperature}&deg;F
            <span className="text-sm font-normal text-zinc-400 ml-1">({tempC}&deg;C)</span>
          </div>
          <div className="text-sm text-zinc-300 mt-0.5">{data.conditions}</div>
        </div>
        <div className="text-3xl mt-1">{icon}</div>
      </div>
      <div className="flex gap-4 mt-2 text-xs text-zinc-400">
        <span>Humidity: {data.humidity}%</span>
        <span>Wind: {data.windSpeed} mph</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Generic tool states
// ---------------------------------------------------------------------------

function ToolPending({ name, args }: { name: string; args: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-zinc-800/60 border border-zinc-700/40 px-2.5 py-1.5 my-1 text-xs">
      <span className="inline-block w-2 h-2 rounded-full bg-amber-500/60 animate-pulse" />
      <span className="text-zinc-400">
        Calling <span className="font-mono text-zinc-300">{name}</span>
        {args && args !== '{}' && <span className="text-zinc-500 ml-1">({args})</span>}
      </span>
    </div>
  );
}

function ToolResult({ name, output }: { name: string; output: string }) {
  return (
    <div className="rounded-md bg-zinc-800/60 border border-zinc-700/40 px-2.5 py-1.5 text-xs text-zinc-400 my-1">
      <span className="font-mono">{name}</span>: {output}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Render a server-side tool interaction: pending while running, a card once done. */
export function ToolInvocation({ part }: { part: Extract<RenderPart, { kind: 'tool' }> }) {
  if (part.output === undefined) {
    return (
      <ToolPending
        name={part.name}
        args={part.args}
      />
    );
  }
  if (part.name === 'getWeather') {
    const data = asWeatherData(part.output);
    if (data) return <WeatherCard data={data} />;
  }
  return (
    <ToolResult
      name={part.name}
      output={part.output}
    />
  );
}
