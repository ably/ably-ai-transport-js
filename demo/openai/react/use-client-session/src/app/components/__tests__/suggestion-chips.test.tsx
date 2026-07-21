import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import type { DemoStep } from '../../hooks/use-demo-progress';
import { SuggestionChips } from '../suggestion-chips';

const promptStep: DemoStep = {
  id: 'server-weather',
  type: 'prompt',
  tag: 'Server tool',
  label: `"what's the weather in Tokyo?"`,
  prompt: `what's the weather in Tokyo?`,
};

const gestureStep: DemoStep = {
  id: 'cancel',
  type: 'gesture',
  tag: 'Cancel mid-stream',
  label: 'send a long prompt, click Stop while it streams',
};

describe('<SuggestionChips>', () => {
  afterEach(() => cleanup());

  it('renders nothing when there are no steps', () => {
    const { container } = render(
      <SuggestionChips
        steps={[]}
        onSelectPrompt={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders a prompt step as a button that fires onSelectPrompt with its prompt', () => {
    const onSelectPrompt = vi.fn();
    render(
      <SuggestionChips
        steps={[promptStep]}
        onSelectPrompt={onSelectPrompt}
      />,
    );
    const chip = screen.getByRole('button', { name: /Server tool/ });
    fireEvent.click(chip);
    expect(onSelectPrompt).toHaveBeenCalledWith(`what's the weather in Tokyo?`);
  });

  it('renders a gesture step as a non-clickable hint (no button)', () => {
    const onSelectPrompt = vi.fn();
    render(
      <SuggestionChips
        steps={[gestureStep]}
        onSelectPrompt={onSelectPrompt}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/Cancel mid-stream/)).not.toBeNull();
  });
});
