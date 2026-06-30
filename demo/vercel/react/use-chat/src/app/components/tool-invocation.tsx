'use client';

import type { DynamicToolUIPart } from 'ai';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Marker, MarkerContent } from '@/components/ui/marker';

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
  Sunny: '☀️',
  'Partly Cloudy': '⛅',
  Cloudy: '☁️',
  Rainy: '🌧️',
  Thunderstorms: '⛈️',
  Snowy: '❄️',
};

function WeatherCard({ data }: { data: WeatherData }) {
  const icon = conditionIcon[data.conditions] ?? '🌤️';
  const tempC = Math.round(((data.temperature - 32) * 5) / 9);

  return (
    <div className="my-1 max-w-[280px] rounded-lg border border-sky-800/30 bg-gradient-to-br from-sky-900/40 to-indigo-900/40 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-xs font-medium text-sky-400/80">{data.location}</div>
          <div className="mt-0.5 text-2xl font-semibold text-foreground">
            {data.temperature}&deg;F
            <span className="ml-1 text-sm font-normal text-muted-foreground">({tempC}&deg;C)</span>
          </div>
          <div className="mt-0.5 text-sm text-muted-foreground">{data.conditions}</div>
        </div>
        <div className="mt-1 text-3xl">{icon}</div>
      </div>
      <div className="mt-2 flex gap-4 text-xs text-muted-foreground">
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
    <div className="my-1 max-w-[360px] rounded-lg border border-indigo-800/30 bg-gradient-to-br from-indigo-900/40 to-purple-900/40 p-3">
      <div className="mb-2 text-xs font-medium text-indigo-400/80">5-Day Forecast: {data.location}</div>
      <div className="space-y-1">
        {data.forecast.map((day) => {
          const icon = conditionIcon[day.conditions] ?? '🌤️';
          const highC = Math.round(((day.high - 32) * 5) / 9);
          const lowC = Math.round(((day.low - 32) * 5) / 9);
          return (
            <div
              key={day.day}
              className="flex items-center gap-3 text-xs"
            >
              <span className="w-8 text-muted-foreground">{day.day}</span>
              <span className="text-base">{icon}</span>
              <span className="ml-auto text-right whitespace-nowrap text-muted-foreground">
                {day.high}&deg;/{day.low}&deg;F
                <span className="ml-1 text-muted-foreground/60">
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
      <Marker
        variant="border"
        className="my-1 text-destructive"
      >
        <MarkerContent>Location error: {data.error}</MarkerContent>
      </Marker>
    );
  }
  return (
    <Marker className="my-1">
      <MarkerContent>
        Location: {data.latitude?.toFixed(4)}, {data.longitude?.toFixed(4)}
      </MarkerContent>
    </Marker>
  );
}

// ---------------------------------------------------------------------------
// Generic tool states
// ---------------------------------------------------------------------------

function ToolPending({ name, input }: { name: string; input: unknown }) {
  return (
    <Marker className="my-1">
      <MarkerContent className="shimmer font-mono">
        Calling {name}
        {input != null && Object.keys(input as object).length > 0 && ` (${JSON.stringify(input)})`}
      </MarkerContent>
    </Marker>
  );
}

function ToolError({ name, errorText }: { name: string; errorText: string }) {
  return (
    <Marker
      variant="border"
      className="my-1 text-destructive"
    >
      <MarkerContent>
        <span className="font-mono">{name}</span> failed: {errorText}
      </MarkerContent>
    </Marker>
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
    <Card
      data-testid="tool-approval"
      className="my-1 gap-3 border-amber-800/50 bg-amber-950/30 py-3"
    >
      <CardContent className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-amber-400">Approval Required</div>
          <p className="mt-1 text-sm text-foreground">
            <span className="font-mono text-amber-300">{part.toolName}</span>
            {inputSummary && <span className="text-muted-foreground"> &mdash; {inputSummary}</span>}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            size="sm"
            onClick={onApprove}
            className="bg-emerald-900/60 text-emerald-300 hover:bg-emerald-900/80"
          >
            Approve
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={onDeny}
          >
            Deny
          </Button>
        </div>
      </CardContent>
    </Card>
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
        <Marker className="my-1">
          <MarkerContent className="font-mono">
            {part.toolName}: {JSON.stringify(part.output)}
          </MarkerContent>
        </Marker>
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
        <Marker className="my-1 text-muted-foreground">
          <MarkerContent>
            <span className="font-mono">{part.toolName}</span> &mdash; denied
          </MarkerContent>
        </Marker>
      );

    default:
      return null;
  }
}
