'use client';

import { getToolName, type DynamicToolUIPart, type ToolUIPart } from 'ai';
import {
  ForecastCard,
  LocationCard,
  ToolApprovalCard,
  ToolDeniedCard,
  ToolErrorCard,
  ToolPendingCard,
  ToolResultCard,
  WeatherCard,
  type ForecastCardData,
  type LocationCardData,
  type WeatherCardData,
} from './tool-cards';

/**
 * Summarise a call's input for a one-line prompt: the values of the arguments
 * object, else the raw JSON when it is not a plain object.
 */
function argsSummary(input: unknown): string | undefined {
  if (input == null) return undefined;
  if (typeof input === 'object') {
    const values = Object.values(input);
    return values.length > 0 ? values.join(', ') : undefined;
  }
  return JSON.stringify(input);
}

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
        <ToolPendingCard
          name={getToolName(part)}
          argsSummary={argsSummary(part.input)}
        />
      );

    case 'output-available': {
      // CAST: a tool's output is typed `unknown`; each card is dispatched by
      // tool name, so the output has the shape that tool's server contract emits.
      if (getToolName(part) === 'getWeather') {
        return <WeatherCard data={part.output as WeatherCardData} />;
      }
      if (getToolName(part) === 'getWeatherForecast') {
        return <ForecastCard data={part.output as ForecastCardData} />;
      }
      if (getToolName(part) === 'getLocation') {
        return <LocationCard data={(part.output ?? {}) as LocationCardData} />;
      }
      return (
        <ToolResultCard
          name={getToolName(part)}
          output={JSON.stringify(part.output)}
        />
      );
    }

    case 'output-error':
      return (
        <ToolErrorCard
          name={getToolName(part)}
          errorText={part.errorText}
        />
      );

    case 'approval-requested':
      return (
        <ToolApprovalCard
          name={getToolName(part)}
          argsSummary={argsSummary(part.input)}
          onApprove={onApprove}
          onDeny={onDeny}
        />
      );

    case 'output-denied':
      return <ToolDeniedCard name={getToolName(part)} />;

    default:
      return null;
  }
}
