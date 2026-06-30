'use client';

import type { DynamicToolUIPart } from 'ai';
import { Loader2Icon, ShieldAlertIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker';

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
    <Card
      size="sm"
      className="my-1 max-w-[280px]"
    >
      <CardHeader>
        <CardDescription>{data.location}</CardDescription>
        <CardTitle className="text-2xl">
          {data.temperature}°F
          <span className="ml-1 text-sm font-normal text-muted-foreground">({tempC}°C)</span>
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
    <Card
      size="sm"
      className="my-1 max-w-[360px]"
    >
      <CardHeader>
        <CardTitle className="text-sm">5-day forecast</CardTitle>
        <CardDescription>{data.location}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
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
                {day.high}°/{day.low}°F
                <span className="ml-1 text-muted-foreground/60">
                  ({highC}°/{lowC}°C)
                </span>
              </span>
            </div>
          );
        })}
      </CardContent>
    </Card>
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
      <MarkerIcon>
        <Loader2Icon className="animate-spin" />
      </MarkerIcon>
      <MarkerContent className="font-mono">
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
  part: DynamicToolUIPart;
  onApprove?: () => void;
  onDeny?: () => void;
}) {
  const inputObj = part.input as Record<string, unknown> | undefined;
  const inputSummary = inputObj ? Object.values(inputObj).join(', ') : JSON.stringify(part.input);

  return (
    <Card
      size="sm"
      data-testid="tool-approval"
      className="my-1 max-w-[360px]"
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <ShieldAlertIcon className="size-4 text-muted-foreground" />
          Approval required
        </CardTitle>
        <CardDescription>
          <span className="font-mono text-foreground">{part.toolName}</span>
          {inputSummary && <span> — {inputSummary}</span>}
        </CardDescription>
      </CardHeader>
      {onApprove && onDeny && (
        <CardFooter className="gap-2">
          <Button
            size="sm"
            onClick={onApprove}
          >
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onDeny}
          >
            Deny
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

interface ToolInvocationProps {
  part: DynamicToolUIPart;
  onApprove?: () => void;
  onDeny?: () => void;
}

export function ToolInvocation({ part, onApprove, onDeny }: ToolInvocationProps) {
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
      if (part.toolName === 'getWeatherForecast') {
        return <ForecastCard data={part.output as ForecastData} />;
      }
      if (part.toolName === 'getLocation') {
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
          name={part.toolName}
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
            <span className="font-mono">{part.toolName}</span> — denied
          </MarkerContent>
        </Marker>
      );

    default:
      return null;
  }
}
