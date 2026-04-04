'use client';

import type { DynamicToolUIPart } from 'ai';

// ---------------------------------------------------------------------------
// Weather card — generative UI for the getWeather tool result
// ---------------------------------------------------------------------------

interface WeatherData {
  location: string;
  temperature: number;
  unit: string;
  conditions: string;
  humidity: number;
  windSpeed: number;
}

const conditionIcon: Record<string, string> = {
  Sunny: '\u2600\uFE0F',
  'Partly Cloudy': '\u26C5',
  Cloudy: '\u2601\uFE0F',
  Rainy: '\uD83C\uDF27\uFE0F',
  Thunderstorms: '\u26C8\uFE0F',
  Snowy: '\u2744\uFE0F',
};

function WeatherCard({ data }: { data: WeatherData }) {
  const icon = conditionIcon[data.conditions] ?? '\uD83C\uDF24\uFE0F';
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
// Location display
// ---------------------------------------------------------------------------

function LocationResult({ output }: { output: unknown }) {
  const data = output as { latitude?: number; longitude?: number; error?: string } | undefined;
  if (!data) return null;
  if (data.error) {
    return (
      <div className="rounded-md bg-red-950/30 border border-red-900/30 px-2.5 py-1.5 text-xs text-red-400 my-1">
        Location error: {data.error}
      </div>
    );
  }
  return (
    <div className="rounded-md bg-zinc-800/60 border border-zinc-700/40 px-2.5 py-1.5 text-xs text-zinc-400 my-1">
      Location: {data.latitude?.toFixed(4)}, {data.longitude?.toFixed(4)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Generic tool states
// ---------------------------------------------------------------------------

function ToolPending({ name, input }: { name: string; input: unknown }) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-zinc-800/60 border border-zinc-700/40 px-2.5 py-1.5 my-1 text-xs">
      <span className="inline-block w-2 h-2 rounded-full bg-amber-500/60 animate-pulse" />
      <span className="text-zinc-400">
        Calling <span className="font-mono text-zinc-300">{name}</span>
        {input != null && Object.keys(input as object).length > 0 && (
          <span className="text-zinc-500 ml-1">({JSON.stringify(input)})</span>
        )}
      </span>
    </div>
  );
}

function ToolError({ name, errorText }: { name: string; errorText: string }) {
  return (
    <div className="rounded-md bg-red-950/30 border border-red-900/30 px-2.5 py-1.5 text-xs my-1">
      <span className="text-red-400">
        <span className="font-mono">{name}</span> failed: {errorText}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

export function ToolInvocation({ part }: { part: DynamicToolUIPart }) {
  switch (part.state) {
    case 'input-streaming':
    case 'input-available':
      return (
        <ToolPending
          name={part.toolName}
          input={part.input}
        />
      );

    case 'output-available': {
      if (part.toolName === 'getWeather') {
        return <WeatherCard data={part.output as WeatherData} />;
      }
      if (part.toolName === 'getLocation') {
        return <LocationResult output={part.output} />;
      }
      // Generic output fallback
      return (
        <div className="rounded-md bg-zinc-800/60 border border-zinc-700/40 px-2.5 py-1.5 text-xs text-zinc-400 my-1">
          <span className="font-mono">{part.toolName}</span>: {JSON.stringify(part.output)}
        </div>
      );
    }

    case 'output-error':
      return (
        <ToolError
          name={part.toolName}
          errorText={part.errorText}
        />
      );

    case 'approval-requested':
      return (
        <ToolPending
          name={part.toolName}
          input={part.input}
        />
      );

    default:
      return null;
  }
}
