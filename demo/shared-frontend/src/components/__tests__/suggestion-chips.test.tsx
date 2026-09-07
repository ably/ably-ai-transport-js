import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import { SuggestionChips } from '../suggestion-chips';
import type { Scenario } from '../../lib/progress-steps';

// SuggestionChips renders the unfinished scenarios: prompt scenarios are
// clickable buttons that prefill the composer; gesture scenarios are
// non-clickable reminder badges.

afterEach(cleanup);

const promptScenario: Scenario = {
  id: 'server-weather',
  tag: 'Server tool',
  title: 'Server tool call',
  blurb: 'b',
  prompt: "what's the weather in Tokyo?",
};

const gestureScenario: Scenario = {
  id: 'multi-tab',
  tag: 'Multi-client sync',
  title: 'Multi-client sync',
  blurb: 'b',
  gesture: 'open in a new tab',
};

describe('<SuggestionChips>', () => {
  it('renders nothing when there are no scenarios', () => {
    const { container } = render(
      <SuggestionChips
        scenarios={[]}
        onSelectPrompt={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('prefills the composer with a prompt scenario when its chip is clicked', () => {
    const onSelectPrompt = vi.fn();
    render(
      <SuggestionChips
        scenarios={[promptScenario]}
        onSelectPrompt={onSelectPrompt}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /weather in Tokyo/ }));
    expect(onSelectPrompt).toHaveBeenCalledWith("what's the weather in Tokyo?");
  });

  it('shows a gesture scenario as a non-clickable badge', () => {
    render(
      <SuggestionChips
        scenarios={[gestureScenario]}
        onSelectPrompt={() => {}}
      />,
    );

    expect(screen.getByText('open in a new tab')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers only the prompt scenarios as buttons when both kinds are present', () => {
    render(
      <SuggestionChips
        scenarios={[promptScenario, gestureScenario]}
        onSelectPrompt={() => {}}
      />,
    );

    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByText('open in a new tab')).toBeTruthy();
  });
});
