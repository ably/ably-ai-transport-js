'use client';

import { Loader2Icon } from 'lucide-react';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@ably-ai-demos/frontend/components/ui/card';
import { Marker, MarkerContent, MarkerIcon } from '@ably-ai-demos/frontend/components/ui/marker';
// Type-only import (erased at build time) of the agent's tool-output shape, so
// the renderer and the producer can't drift. No server runtime crosses over.
import type { WeatherData } from '../api/chat/tools';
import type { RenderPart } from '../helpers';

// Tool activity renders as bordered rows so programmatic calls stand out from
// the assistant's prose.
const toolBoxClasses = 'my-1 rounded-md border bg-muted/50 px-2.5 py-1.5 text-xs';

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
    <Card
      size="sm"
      className="my-1 max-w-[280px] bg-transparent bg-gradient-to-br from-sky-100 to-indigo-100 ring-sky-200 dark:from-sky-900/40 dark:to-indigo-900/40 dark:ring-sky-800/30"
    >
      <CardHeader>
        <CardDescription className="text-sky-700 dark:text-sky-400/80">{data.location}</CardDescription>
        <CardTitle className="text-2xl">
          {data.temperature}&deg;F
          <span className="ml-1 text-sm font-normal text-muted-foreground">({tempC}&deg;C)</span>
        </CardTitle>
        <CardAction className="text-3xl">{icon}</CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        <div className="text-muted-foreground">{data.conditions}</div>
        <div className="flex gap-4 text-xs text-muted-foreground">
          <span>Humidity: {data.humidity}%</span>
          <span>Wind: {data.windSpeed} mph</span>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Generic tool states
// ---------------------------------------------------------------------------

function ToolPending({ name, args }: { name: string; args: string }) {
  return (
    <Marker className={toolBoxClasses}>
      <MarkerIcon>
        <Loader2Icon className="animate-spin" />
      </MarkerIcon>
      <MarkerContent>
        Calling <span className="font-mono text-foreground">{name}</span>
        {args && args !== '{}' && <span> ({args})</span>}
      </MarkerContent>
    </Marker>
  );
}

function ToolResult({ name, output }: { name: string; output: string }) {
  return (
    <Marker className={toolBoxClasses}>
      <MarkerContent>
        <span className="font-mono">{name}</span>: {output}
      </MarkerContent>
    </Marker>
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
