'use client';

import { getToolName, type DynamicToolUIPart, type ToolUIPart } from 'ai';
import { Loader2Icon, ShieldAlertIcon } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './ui/card';
import { Marker, MarkerContent, MarkerIcon } from './ui/marker';
import { cn } from '../lib/utils';

// Tool activity renders as bordered rows so programmatic calls stand out from
// the assistant's prose.
const toolBoxClasses = 'my-1 rounded-md border bg-muted/50 px-2.5 py-1.5 text-xs';

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
      className="my-1 max-w-[280px] bg-transparent bg-gradient-to-br from-sky-900/40 to-indigo-900/40 ring-sky-800/30"
    >
      <CardHeader>
        <CardDescription className="text-sky-400/80">{data.location}</CardDescription>
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
      className="my-1 max-w-[320px] bg-transparent bg-gradient-to-br from-indigo-900/40 to-purple-900/40 ring-indigo-800/30"
    >
      <CardHeader>
        <CardTitle className="text-sm">5-day forecast</CardTitle>
        <CardDescription className="text-indigo-400/80">{data.location}</CardDescription>
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
  // CAST: getLocation's output is typed `unknown`; read it as the coords/error
  // shape the getLocation tool returns, guarding each field before use.
  const data = output as { latitude?: number; longitude?: number; error?: string } | undefined;
  if (!data) return null;
  if (data.error) {
    return (
      <Marker className={cn(toolBoxClasses, 'border-destructive/30 bg-destructive/10 text-destructive')}>
        <MarkerContent>Location error: {data.error}</MarkerContent>
      </Marker>
    );
  }
  return (
    <Marker className={toolBoxClasses}>
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
    <Marker className={toolBoxClasses}>
      <MarkerIcon>
        <Loader2Icon className="animate-spin" />
      </MarkerIcon>
      <MarkerContent>
        Calling <span className="font-mono text-foreground">{name}</span>
        {input != null && Object.keys(input as object).length > 0 && <span> ({JSON.stringify(input)})</span>}
      </MarkerContent>
    </Marker>
  );
}

function ToolError({ name, errorText }: { name: string; errorText: string }) {
  return (
    <Marker className={cn(toolBoxClasses, 'border-destructive/30 bg-destructive/10 text-destructive')}>
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
  onApprove?: () => void;
  onDeny?: () => void;
}) {
  // CAST: a tool call's input is typed `unknown`; summarise it as a plain record
  // of argument values, falling back to JSON when it is not an object.
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
          <span className="font-mono text-foreground">{getToolName(part)}</span>
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
  part: ToolUIPart | DynamicToolUIPart;
  onApprove?: () => void;
  onDeny?: () => void;
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
      // CAST: a tool's output is typed `unknown`; each card is dispatched by
      // tool name, so the output has the shape that tool's server contract emits.
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
        <Marker className={toolBoxClasses}>
          <MarkerContent>
            <span className="font-mono">{getToolName(part)}</span>: {JSON.stringify(part.output)}
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
        <Marker className={toolBoxClasses}>
          <MarkerContent>
            <span className="font-mono">{getToolName(part)}</span> — denied
          </MarkerContent>
        </Marker>
      );

    default:
      return null;
  }
}
