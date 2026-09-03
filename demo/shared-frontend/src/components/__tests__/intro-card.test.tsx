import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

import { IntroCard, COMMON_SCENARIOS } from '../intro-card';
import type { Scenario } from '../../lib/progress-steps';

// IntroCard renders the numbered walkthrough of a demo's scenarios under a
// heading and blurb, with sensible defaults.

afterEach(cleanup);

describe('<IntroCard>', () => {
  it('renders each scenario title, blurb, and its prompt / gesture line', () => {
    const scenarios: Scenario[] = [
      {
        id: 'server-weather',
        tag: 'Server tool',
        title: 'Server tool call',
        blurb: 'runs on the server',
        prompt: 'weather in Tokyo?',
      },
      { tag: 'Observability', title: 'Observability', blurb: 'inspect the wire', gesture: 'open the Debug pane' },
    ];
    render(<IntroCard scenarios={scenarios} />);

    expect(screen.getByText('Server tool call')).toBeTruthy();
    expect(screen.getByText('runs on the server')).toBeTruthy();
    expect(screen.getByText(/weather in Tokyo\?/)).toBeTruthy();
    expect(screen.getByText('Observability')).toBeTruthy();
    expect(screen.getByText('open the Debug pane')).toBeTruthy();
  });

  it('falls back to the generic title and blurb with no props', () => {
    render(<IntroCard />);
    expect(screen.getByText('AI chat over Ably')).toBeTruthy();
    expect(screen.getByText(/wired to the Ably AI Transport/)).toBeTruthy();
  });

  it('renders the shared baseline scenarios by default', () => {
    render(<IntroCard />);
    // COMMON_SCENARIOS leads with the server-side tool call scenario.
    expect(COMMON_SCENARIOS.length).toBeGreaterThan(0);
    expect(screen.getByText('Server-side tool call')).toBeTruthy();
  });

  it('applies a custom title and description', () => {
    render(
      <IntroCard
        scenarios={[]}
        title="My Demo"
        description="My blurb"
      />,
    );
    expect(screen.getByText('My Demo')).toBeTruthy();
    expect(screen.getByText('My blurb')).toBeTruthy();
  });

  it('lets a scenario action override the auto-rendered prompt line', () => {
    const scenarios: Scenario[] = [
      {
        id: 'approval-forecast',
        tag: 'Approval',
        title: 'Approval flow',
        blurb: 'b',
        prompt: 'ignored prompt',
        action: <span>CUSTOM ACTION LINE</span>,
      },
    ];
    render(<IntroCard scenarios={scenarios} />);

    expect(screen.getByText('CUSTOM ACTION LINE')).toBeTruthy();
    expect(screen.queryByText(/ignored prompt/)).toBeNull();
  });
});
