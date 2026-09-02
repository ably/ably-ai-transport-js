import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

import type { DisplayPart } from '../../display';
import { ToolInvocation } from '../tool-invocation';

type ToolPart = Extract<DisplayPart, { kind: 'tool' }>;

const toolPart = (over: Partial<ToolPart> = {}): ToolPart => ({
  kind: 'tool',
  callId: 'call-1',
  name: 'getWeather',
  args: '{"location":"London"}',
  ...over,
});

const weatherOutput = JSON.stringify({
  location: 'London',
  temperature: 60,
  unit: 'fahrenheit',
  conditions: 'Sunny',
  humidity: 40,
  windSpeed: 10,
});

describe('<ToolInvocation>', () => {
  afterEach(() => cleanup());

  it('renders a pending state while the call has no output', () => {
    render(<ToolInvocation part={toolPart({ output: undefined })} />);
    expect(screen.getByText('getWeather')).not.toBeNull();
    expect(screen.getByText(/Calling/)).not.toBeNull();
  });

  it('renders a weather card once getWeather output is available', () => {
    render(<ToolInvocation part={toolPart({ output: weatherOutput })} />);
    expect(screen.getByText('London')).not.toBeNull();
    expect(screen.getByText(/60/)).not.toBeNull();
    expect(screen.getByText('Sunny')).not.toBeNull();
    expect(screen.getByText(/Humidity: 40%/)).not.toBeNull();
  });

  it('falls back to a raw result when getWeather output is not weather-shaped', () => {
    render(<ToolInvocation part={toolPart({ output: 'not json' })} />);
    // No weather card; the generic ToolResult shows the tool name and raw output.
    expect(screen.queryByText(/Humidity:/)).toBeNull();
    expect(screen.getByText('getWeather')).not.toBeNull();
    expect(screen.getByText(/not json/)).not.toBeNull();
  });

  it('falls back to a raw result for a non-weather tool', () => {
    render(<ToolInvocation part={toolPart({ name: 'getTime', output: '{"now":"noon"}' })} />);
    expect(screen.queryByText(/Humidity:/)).toBeNull();
    expect(screen.getByText('getTime')).not.toBeNull();
  });
});
