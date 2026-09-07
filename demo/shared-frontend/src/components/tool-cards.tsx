'use client';

/**
 * Presentational cards for tool activity, shared by the demos.
 *
 * Each card takes plain props — a name, a summarised argument string, or an
 * already-narrowed output object — and holds no codec types. Every demo models
 * tool calls in its own codec's shape (Vercel's `ToolUIPart`, the OpenAI
 * Responses codec's display parts), so each demo keeps its own dispatcher and
 * narrows its own outputs; only the rendering is shared. That keeps two very
 * different tool models from being forced into one type while still giving the
 * demos a single look for a weather card, a pending row, or an approval prompt.
 */

import { Loader2Icon, ShieldAlertIcon } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './ui/card';
import { Marker, MarkerContent, MarkerIcon } from './ui/marker';
import { cn } from '../lib/utils';

// Tool activity renders as bordered rows so programmatic calls stand out from
// the assistant's prose.
const toolBoxClasses = 'my-1 rounded-md border bg-muted/50 px-2.5 py-1.5 text-xs';

const conditionIcon: Record<string, string> = {
  Sunny: '☀️',
  'Partly Cloudy': '⛅',
  Cloudy: '☁️',
  Rainy: '🌧️',
  Thunderstorms: '⛈️',
  Snowy: '❄️',
};

/** The current-conditions fields a weather card renders. */
export interface WeatherCardData {
  /** The place the reading is for. */
  location: string;
  /** Temperature in Fahrenheit; the card derives and shows Celsius too. */
  temperature: number;
  /** A condition label; keys the weather icon, falling back to a generic one. */
  conditions: string;
  /** Relative humidity as a percentage. */
  humidity: number;
  /** Wind speed in miles per hour. */
  windSpeed: number;
}

/** Generative UI for a current-conditions tool result. */
export function WeatherCard({ data }: { data: WeatherCardData }) {
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

/** One day of a forecast, as a forecast card renders it. */
export interface ForecastCardDay {
  /** Short day label, e.g. `Mon`. */
  day: string;
  /** The day's high in Fahrenheit. */
  high: number;
  /** The day's low in Fahrenheit. */
  low: number;
  /** A condition label; keys the day's icon. */
  conditions: string;
}

/** The multi-day fields a forecast card renders. */
export interface ForecastCardData {
  /** The place the forecast is for. */
  location: string;
  /** The forecast days, rendered in order. */
  forecast: readonly ForecastCardDay[];
}

/** Generative UI for a multi-day forecast tool result. */
export function ForecastCard({ data }: { data: ForecastCardData }) {
  return (
    <Card
      size="sm"
      className="my-1 max-w-[320px] bg-transparent bg-gradient-to-br from-indigo-100 to-purple-100 ring-indigo-200 dark:from-indigo-900/40 dark:to-purple-900/40 dark:ring-indigo-800/30"
    >
      <CardHeader>
        <CardTitle className="text-sm">5-day forecast</CardTitle>
        <CardDescription className="text-indigo-700 dark:text-indigo-400/80">{data.location}</CardDescription>
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
                {day.high}&deg;/{day.low}&deg;F
                <span className="ml-1 text-muted-foreground/60">
                  ({highC}&deg;/{lowC}&deg;C)
                </span>
              </span>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

/** The coordinates-or-error fields a location card renders. */
export interface LocationCardData {
  /** Resolved latitude, absent when the lookup failed. */
  latitude?: number;
  /** Resolved longitude, absent when the lookup failed. */
  longitude?: number;
  /** Why the lookup failed; when present the card renders the error instead. */
  error?: string;
}

/** Generative UI for a geolocation tool result, or its failure. */
export function LocationCard({ data }: { data: LocationCardData }) {
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

/** A spinner row for a call that has been made but has produced no output yet. */
export function ToolPendingCard({ name, argsSummary }: { name: string; argsSummary?: string }) {
  return (
    <Marker className={toolBoxClasses}>
      <MarkerIcon>
        <Loader2Icon className="animate-spin" />
      </MarkerIcon>
      <MarkerContent>
        Calling <span className="font-mono text-foreground">{name}</span>
        {argsSummary && <span> ({argsSummary})</span>}
      </MarkerContent>
    </Marker>
  );
}

/** The fallback row for a tool with no bespoke card: its name and raw output. */
export function ToolResultCard({ name, output }: { name: string; output: string }) {
  return (
    <Marker className={toolBoxClasses}>
      <MarkerContent>
        <span className="font-mono">{name}</span>: {output}
      </MarkerContent>
    </Marker>
  );
}

/** A failed tool call — the executor threw, or a client result came back as an error. */
export function ToolErrorCard({ name, errorText }: { name: string; errorText: string }) {
  return (
    <Marker className={cn(toolBoxClasses, 'border-destructive/30 bg-destructive/10 text-destructive')}>
      <MarkerContent>
        <span className="font-mono">{name}</span> failed: {errorText}
      </MarkerContent>
    </Marker>
  );
}

/** A gated call the user refused; it never ran. */
export function ToolDeniedCard({ name }: { name: string }) {
  return (
    <Marker className={toolBoxClasses}>
      <MarkerContent>
        <span className="font-mono">{name}</span> &mdash; denied
      </MarkerContent>
    </Marker>
  );
}

/**
 * The approve / deny prompt for a gated call awaiting a decision. Omit the
 * handlers to render the prompt read-only — the decision belongs to whichever
 * client can answer it, so other clients still show what is being asked.
 */
export function ToolApprovalCard({
  name,
  argsSummary,
  onApprove,
  onDeny,
}: {
  name: string;
  argsSummary?: string;
  onApprove?: () => void;
  onDeny?: () => void;
}) {
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
          <span className="font-mono text-foreground">{name}</span>
          {argsSummary && <span> &mdash; {argsSummary}</span>}
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
