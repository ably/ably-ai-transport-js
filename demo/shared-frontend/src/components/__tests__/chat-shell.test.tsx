import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { type ComponentProps } from 'react';

// The header's AvatarStack enters presence via ably-js's React hooks; stub them
// so the shell renders with no Ably client.
vi.mock('ably/react', () => ({
  usePresence: () => ({ updateStatus: async () => {}, connectionError: null, channelError: null }),
  usePresenceListener: () => ({ presenceData: [], connectionError: null, channelError: null }),
}));

// Imported after vi.mock so it picks up the stubbed presence hooks.
import { ChatShell } from '../chat-shell';
import type { Scenario } from '../../lib/progress-steps';

afterEach(cleanup);

type ShellProps = ComponentProps<typeof ChatShell>;

const baseProps: ShellProps = {
  title: 'Ably AI — Demo',
  channelName: 'ai:demo',
  transcript: <div>TRANSCRIPT</div>,
  debugPane: <div>DEBUG PANE</div>,
  suggestions: [],
  onSelectPrompt: () => {},
  input: '',
  onInputChange: () => {},
  onSend: () => {},
  onStop: () => {},
  isRunning: false,
};

function renderShell(over: Partial<ShellProps> = {}) {
  return render(
    <ChatShell
      {...baseProps}
      {...over}
    />,
  );
}

describe('<ChatShell>', () => {
  it('renders the title, transcript, debug pane, and composer', () => {
    renderShell();
    expect(screen.getByText('Ably AI — Demo')).toBeTruthy();
    expect(screen.getByText('TRANSCRIPT')).toBeTruthy();
    expect(screen.getByText('DEBUG PANE')).toBeTruthy();
    expect(screen.getByPlaceholderText('Type a message...')).toBeTruthy();
  });

  it('reports composer edits via onInputChange', () => {
    const onInputChange = vi.fn();
    renderShell({ onInputChange });
    fireEvent.change(screen.getByPlaceholderText('Type a message...'), { target: { value: 'hi' } });
    expect(onInputChange).toHaveBeenCalledWith('hi');
  });

  it('sends the composed text and clears the composer on submit', () => {
    const onSend = vi.fn();
    const onInputChange = vi.fn();
    renderShell({ input: 'hello', onInputChange, onSend });
    const form = screen.getByPlaceholderText('Type a message...').closest('form');
    if (!form) throw new Error('composer is not nested in a <form>');

    fireEvent.submit(form);
    expect(onInputChange).toHaveBeenCalledWith('');
    expect(onSend).toHaveBeenCalledWith('hello');
  });

  it('shows Stop (not Send) and fires onStop while a run is streaming', () => {
    const onStop = vi.fn();
    renderShell({ isRunning: true, onStop });
    const stop = screen.getByRole('button', { name: 'Stop' });
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();

    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('offers a suggestion chip that prefills the composer', () => {
    const onSelectPrompt = vi.fn();
    const suggestions: Scenario[] = [
      { id: 'server-weather', tag: 'Server tool', title: 't', blurb: 'b', prompt: 'weather in Tokyo?' },
    ];
    renderShell({ suggestions, onSelectPrompt });

    fireEvent.click(screen.getByRole('button', { name: /weather in Tokyo/ }));
    expect(onSelectPrompt).toHaveBeenCalledWith('weather in Tokyo?');
  });
});
