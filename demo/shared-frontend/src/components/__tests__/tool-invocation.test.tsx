import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type * as AI from 'ai';

import { ToolInvocation } from '../tool-invocation';

// ToolInvocation dispatches on the tool part's state: a pending row while the
// call runs, generative cards for the weather tools, plain rows for other
// outputs and errors, and an approval card for approval-gated tools.

afterEach(cleanup);

// CAST: `ToolUIPart` is a discriminated union keyed on `state`; a plain object
// literal can't be inferred as one arm, so build only the fields the component
// reads for each state and assert the union type here.
function toolPart(fields: {
  name: string;
  state: AI.ToolUIPart['state'];
  input?: unknown;
  output?: unknown;
  errorText?: string;
}): AI.ToolUIPart {
  return {
    type: `tool-${fields.name}`,
    toolCallId: 'tc1',
    state: fields.state,
    input: fields.input ?? {},
    output: fields.output,
    errorText: fields.errorText,
  } as AI.ToolUIPart;
}

describe('<ToolInvocation> pending', () => {
  it('shows a calling row for an input-available tool call', () => {
    const { container } = render(
      <ToolInvocation part={toolPart({ name: 'getWeather', state: 'input-available', input: { city: 'Tokyo' } })} />,
    );
    expect(container.textContent).toContain('Calling');
    expect(container.textContent).toContain('getWeather');
    expect(container.textContent).toContain('Tokyo');
  });

  it('shows a calling row while the input is still streaming', () => {
    const { container } = render(<ToolInvocation part={toolPart({ name: 'getWeather', state: 'input-streaming' })} />);
    expect(container.textContent).toContain('Calling');
    expect(container.textContent).toContain('getWeather');
  });
});

describe('<ToolInvocation> outputs', () => {
  it('renders the weather card for a getWeather output', () => {
    const { container } = render(
      <ToolInvocation
        part={toolPart({
          name: 'getWeather',
          state: 'output-available',
          output: { location: 'Tokyo', temperature: 72, unit: 'F', conditions: 'Sunny', humidity: 40, windSpeed: 8 },
        })}
      />,
    );
    expect(container.textContent).toContain('Tokyo');
    expect(container.textContent).toContain('72');
    expect(container.textContent).toContain('Sunny');
  });

  it('renders the forecast card for a getWeatherForecast output', () => {
    const { container } = render(
      <ToolInvocation
        part={toolPart({
          name: 'getWeatherForecast',
          state: 'output-available',
          output: {
            location: 'London',
            forecast: [{ day: 'Mon', high: 60, low: 45, conditions: 'Cloudy' }],
          },
        })}
      />,
    );
    expect(container.textContent).toContain('5-day forecast');
    expect(container.textContent).toContain('London');
    expect(container.textContent).toContain('Mon');
  });

  it('renders coordinates for a getLocation output', () => {
    const { container } = render(
      <ToolInvocation
        part={toolPart({
          name: 'getLocation',
          state: 'output-available',
          output: { latitude: 51.5074, longitude: -0.1278 },
        })}
      />,
    );
    expect(container.textContent).toContain('Location:');
    expect(container.textContent).toContain('51.5074');
  });

  it('renders an error row for a getLocation output carrying an error', () => {
    const { container } = render(
      <ToolInvocation
        part={toolPart({ name: 'getLocation', state: 'output-available', output: { error: 'permission denied' } })}
      />,
    );
    expect(container.textContent).toContain('Location error:');
    expect(container.textContent).toContain('permission denied');
  });

  it('renders a generic row for any other tool output', () => {
    const { container } = render(
      <ToolInvocation
        part={toolPart({ name: 'getStockPrice', state: 'output-available', output: { symbol: 'AAPL', priceUSD: 100 } })}
      />,
    );
    expect(container.textContent).toContain('getStockPrice');
    expect(container.textContent).toContain('AAPL');
  });
});

describe('<ToolInvocation> error and denial', () => {
  it('renders a failure row for an output-error', () => {
    const { container } = render(
      <ToolInvocation part={toolPart({ name: 'getWeather', state: 'output-error', errorText: 'boom' })} />,
    );
    expect(container.textContent).toContain('getWeather');
    expect(container.textContent).toContain('failed');
    expect(container.textContent).toContain('boom');
  });

  it('renders a denied row for an output-denied tool', () => {
    const { container } = render(
      <ToolInvocation part={toolPart({ name: 'getWeatherForecast', state: 'output-denied' })} />,
    );
    expect(container.textContent).toContain('getWeatherForecast');
    expect(container.textContent).toContain('denied');
  });
});

describe('<ToolInvocation> approval card', () => {
  it('renders the approval card and fires approve / deny', () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    render(
      <ToolInvocation
        part={toolPart({ name: 'getWeatherForecast', state: 'approval-requested', input: { location: 'London' } })}
        onApprove={onApprove}
        onDeny={onDeny}
      />,
    );

    expect(screen.getByText('Approval required')).toBeTruthy();
    expect(screen.getByText(/London/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onApprove).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(onDeny).toHaveBeenCalledTimes(1);
  });

  it('omits the approve / deny buttons when no handlers are wired', () => {
    render(
      <ToolInvocation
        part={toolPart({ name: 'getWeatherForecast', state: 'approval-requested', input: { location: 'London' } })}
      />,
    );

    expect(screen.getByText('Approval required')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
});
