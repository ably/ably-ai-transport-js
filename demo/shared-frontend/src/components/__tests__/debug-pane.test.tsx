import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { type ComponentProps } from 'react';
import type * as Ably from 'ably';
import { DebugPane } from '../debug-pane';
import { TooltipProvider } from '../ui/tooltip';

const PANE_OPEN_STORAGE_KEY = 'ait-demo:debug-pane-open';

type PaneProps = ComponentProps<typeof DebugPane>;

const baseProps: PaneProps = {
  messages: [],
  ablyMessages: [],
  status: 'ready',
  callbackLog: [],
  statusLog: [],
  clientToolLog: [],
  onClearLogs: () => {},
};

// The reopen affordance uses a Radix Tooltip, which requires a TooltipProvider
// ancestor; the shell provides one in the app, so the tests supply it too.
function renderPane(over: Partial<PaneProps> = {}) {
  return render(
    <TooltipProvider>
      <DebugPane
        {...baseProps}
        {...over}
      />
    </TooltipProvider>,
  );
}

// CAST: the Ably tab reads only `.name` (and optionally `.data`/`.extras`) off
// each inbound message; build the minimal shape and assert the type.
function ablyMessage(name: string): Ably.InboundMessage {
  return { name } as Ably.InboundMessage;
}

// The pane is open when its "close" control is shown; closed when only the
// reopen toggle (labelled "Show debug pane") is shown.
const isOpen = () => screen.queryByText('close') !== null;
const isClosed = () => screen.queryByRole('button', { name: 'Show debug pane' }) !== null;

describe('<DebugPane> open/closed persistence', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('defaults to open on first visit (no stored preference)', () => {
    renderPane();
    expect(isOpen()).toBe(true);
  });

  it('persists the closed state when the pane is closed', () => {
    renderPane();
    fireEvent.click(screen.getByText('close'));
    expect(isClosed()).toBe(true);
    expect(localStorage.getItem(PANE_OPEN_STORAGE_KEY)).toBe('false');
  });

  it('persists the open state when the pane is reopened', () => {
    localStorage.setItem(PANE_OPEN_STORAGE_KEY, 'false');
    renderPane();
    fireEvent.click(screen.getByRole('button', { name: 'Show debug pane' }));
    expect(isOpen()).toBe(true);
    expect(localStorage.getItem(PANE_OPEN_STORAGE_KEY)).toBe('true');
  });

  it('restores the closed state on a fresh mount (refresh)', () => {
    localStorage.setItem(PANE_OPEN_STORAGE_KEY, 'false');
    renderPane();
    expect(isClosed()).toBe(true);
  });

  it('restores the open state on a fresh mount (refresh)', () => {
    localStorage.setItem(PANE_OPEN_STORAGE_KEY, 'true');
    renderPane();
    expect(isOpen()).toBe(true);
  });

  it('honours a custom storage key', () => {
    localStorage.setItem('other-key', 'false');
    renderPane({ storageKey: 'other-key' });
    expect(isClosed()).toBe(true);
  });
});

describe('<DebugPane> content', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('renders inbound Ably messages by name in the default Ably tab', () => {
    renderPane({ ablyMessages: [ablyMessage('ai-run-start')] });
    expect(screen.getByText('ai-run-start')).toBeTruthy();
  });

  it('shows the current status in the UIMessages tab', () => {
    renderPane({ status: 'streaming' });
    // Radix Tabs triggers activate on mouse-down, not click.
    fireEvent.mouseDown(screen.getByRole('tab', { name: /UIMessages/ }));
    expect(screen.getByText('streaming')).toBeTruthy();
  });

  it('clears the logs from the Lifecycle tab', () => {
    const onClearLogs = vi.fn();
    renderPane({ callbackLog: [{ time: Date.now(), type: 'runStart', summary: 'run started' }], onClearLogs });
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Lifecycle/ }));
    fireEvent.click(screen.getByText('clear'));
    expect(onClearLogs).toHaveBeenCalledTimes(1);
  });
});
