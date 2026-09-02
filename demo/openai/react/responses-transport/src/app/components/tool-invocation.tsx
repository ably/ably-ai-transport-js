'use client';

import {
  ForecastCard,
  LocationCard,
  ToolApprovalCard,
  ToolDeniedCard,
  ToolErrorCard,
  ToolPendingCard,
  ToolResultCard,
  WeatherCard,
} from '@ably-ai-demos/frontend/components/tool-cards';
// Type-only import (erased at build time) of the agent's tool-output shapes, so
// the renderer and the producer can't drift. No server runtime crosses over.
import type { ForecastData, LocationData, WeatherData } from '../api/chat/tools';
import type { DisplayPart } from '../display';

/**
 * Narrow a tool output's JSON text to `T` when `guard` accepts it. A tool output
 * arrives as a JSON string off the wire, so each card's data has to be parsed
 * and checked before it can be rendered.
 */
function parseOutput<T>(output: string, guard: (value: Partial<T>) => boolean): T | undefined {
  try {
    // CAST: trust boundary — the tool output is parsed JSON from the wire.
    const data = JSON.parse(output) as Partial<T>;
    // CAST: the caller's guard confirmed the fields the card renders are present.
    if (guard(data)) return data as T;
  } catch {
    // Not JSON — the caller falls back to the raw output.
  }
  return undefined;
}

/**
 * Summarise a call's arguments for the approval prompt: the values of the parsed
 * arguments object, else the raw string when it isn't a plain object.
 */
function argsSummary(args: string): string | undefined {
  if (!args || args === '{}') return undefined;
  try {
    // CAST: trust boundary — the arguments string is parsed JSON.
    const parsed = JSON.parse(args) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object') {
      const values = Object.values(parsed);
      return values.length > 0 ? values.join(', ') : undefined;
    }
  } catch {
    // Not JSON — fall through to the raw string.
  }
  return args;
}

interface ToolInvocationProps {
  /** The tool display part — the call plus its approval decision and output. */
  part: Extract<DisplayPart, { kind: 'tool' }>;
  /** Approve a pending gated call. Bound by the list to this call's transport-message-id + call_id. */
  onApprove?: () => void;
  /** Deny a pending gated call. Bound by the list to this call's transport-message-id + call_id. */
  onDeny?: () => void;
}

/**
 * Render a tool interaction. A gated call awaiting a decision shows the approval
 * card; a denied call shows a denied note; a call still running (no output yet)
 * shows a pending row; a completed call shows its generative card — a failed
 * client result shows the error instead.
 */
export function ToolInvocation({ part, onApprove, onDeny }: ToolInvocationProps) {
  // A gated call awaiting a human decision: show approve / deny.
  if (part.approval === 'pending') {
    return (
      <ToolApprovalCard
        name={part.name}
        argsSummary={argsSummary(part.args)}
        onApprove={onApprove}
        onDeny={onDeny}
      />
    );
  }

  // A denied call carries a rejection output; render the denial, not the output.
  if (part.approval === 'denied') {
    return <ToolDeniedCard name={part.name} />;
  }

  // No output yet — the call is still running (a server tool) or waiting
  // awaiting a client result (a client tool).
  if (part.output === undefined) {
    return (
      <ToolPendingCard
        name={part.name}
        argsSummary={argsSummary(part.args)}
      />
    );
  }

  // A failed client result merges the failure message into the output.
  if (part.result === 'failed') {
    return (
      <ToolErrorCard
        name={part.name}
        errorText={part.output}
      />
    );
  }

  if (part.name === 'getWeather') {
    const data = parseOutput<WeatherData>(
      part.output,
      (d) => typeof d.location === 'string' && typeof d.temperature === 'number',
    );
    if (data) return <WeatherCard data={data} />;
  }
  if (part.name === 'getWeatherForecast') {
    const data = parseOutput<ForecastData>(
      part.output,
      (d) => typeof d.location === 'string' && Array.isArray(d.forecast),
    );
    if (data) return <ForecastCard data={data} />;
  }
  if (part.name === 'getLocation') {
    const data = parseOutput<LocationData>(
      part.output,
      (d) => typeof d.latitude === 'number' || typeof d.error === 'string',
    );
    if (data) return <LocationCard data={data} />;
  }
  return (
    <ToolResultCard
      name={part.name}
      output={part.output}
    />
  );
}
