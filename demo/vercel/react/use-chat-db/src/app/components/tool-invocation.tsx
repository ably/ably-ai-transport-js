'use client';

import { getToolName, type DynamicToolUIPart, type ToolUIPart } from 'ai';

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
// Forecast card — generative UI for the getWeatherForecast tool result
// ---------------------------------------------------------------------------

interface ForecastDay {
  day: string;
  high: number;
  low: number;
  conditions: string;
}

interface ForecastData {
  location: string;
  forecast: ForecastDay[];
}

function ForecastCard({ data }: { data: ForecastData }) {
  return (
    <div className="rounded-lg bg-gradient-to-br from-indigo-900/40 to-purple-900/40 border border-indigo-800/30 p-3 my-1 max-w-[320px]">
      <div className="text-xs text-indigo-400/80 font-medium mb-2">5-Day Forecast: {data.location}</div>
      <div className="space-y-1">
        {data.forecast.map((day) => {
          const icon = conditionIcon[day.conditions] ?? '\uD83C\uDF24\uFE0F';
          const highC = Math.round(((day.high - 32) * 5) / 9);
          const lowC = Math.round(((day.low - 32) * 5) / 9);
          return (
            <div
              key={day.day}
              className="flex items-center justify-between text-xs"
            >
              <span className="text-zinc-300 w-8">{day.day}</span>
              <span className="text-base">{icon}</span>
              <span className="text-zinc-400 w-24 text-right">
                {day.high}&deg;/{day.low}&deg;F
                <span className="text-zinc-600 ml-1">
                  ({highC}&deg;/{lowC}&deg;C)
                </span>
              </span>
            </div>
          );
        })}
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
// Approval card — rendered for approval-requested tool parts
// ---------------------------------------------------------------------------

function ToolApprovalCard({
  part,
  onApprove,
  onDeny,
}: {
  part: ToolUIPart | DynamicToolUIPart;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const inputObj = part.input as Record<string, unknown> | undefined;
  const inputSummary = inputObj ? Object.values(inputObj).join(', ') : JSON.stringify(part.input);

  return (
    <div className="my-1 rounded-lg border border-amber-800/50 bg-amber-950/30 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-amber-400">Approval Required</span>
          </div>
          <p className="mt-1 text-sm text-zinc-300">
            <span className="font-mono text-amber-300">{getToolName(part)}</span>
            {inputSummary && <span className="text-zinc-500"> &mdash; {inputSummary}</span>}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={onApprove}
            className="rounded-md bg-emerald-900/60 px-3 py-1.5 text-xs font-medium text-emerald-300 transition-colors hover:bg-emerald-900/80"
          >
            Approve
          </button>
          <button
            onClick={onDeny}
            className="rounded-md bg-red-900/60 px-3 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-900/80"
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

interface ToolInvocationProps {
  part: ToolUIPart | DynamicToolUIPart;
  onApprove: () => void;
  onDeny: () => void;
}

export function ToolInvocation({ part, onApprove, onDeny }: ToolInvocationProps) {
  switch (part.state) {
    case 'input-streaming':
    case 'input-available':
      return (
        <ToolPending
          name={getToolName(part)}
          input={part.input}
        />
      );

    case 'output-available': {
      if (getToolName(part) === 'getWeather') {
        return <WeatherCard data={part.output as WeatherData} />;
      }
      if (getToolName(part) === 'getWeatherForecast') {
        return <ForecastCard data={part.output as ForecastData} />;
      }
      if (getToolName(part) === 'getLocation') {
        return <LocationResult output={part.output} />;
      }
      // Generic output fallback
      return (
        <div className="rounded-md bg-zinc-800/60 border border-zinc-700/40 px-2.5 py-1.5 text-xs text-zinc-400 my-1">
          <span className="font-mono">{getToolName(part)}</span>: {JSON.stringify(part.output)}
        </div>
      );
    }

    case 'output-error':
      return (
        <ToolError
          name={getToolName(part)}
          errorText={part.errorText}
        />
      );

    case 'approval-requested':
      return (
        <ToolApprovalCard
          part={part}
          onApprove={onApprove}
          onDeny={onDeny}
        />
      );

    case 'output-denied':
      return (
        <div className="rounded-md bg-zinc-800/60 border border-zinc-700/40 px-2.5 py-1.5 text-xs text-zinc-500 my-1">
          <span className="font-mono">{getToolName(part)}</span> &mdash; denied
        </div>
      );

    default:
      return null;
  }
}
