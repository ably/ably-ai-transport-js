import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TooltipProvider } from '@ably-ai-demos/frontend/components/ui/tooltip';
import type { ThreadMessage } from '../../lib/fold-thread';
import { DebugPane } from '../debug-pane';

const PANE_OPEN_STORAGE_KEY = 'ait-demo:debug-pane-open';

// The reopen affordance uses a Radix Tooltip, which requires a TooltipProvider
// ancestor; the shell provides one in the app, so the tests supply it too.
const renderPane = () =>
  render(
    <TooltipProvider>
      <DebugPane
        messages={[] as ThreadMessage[]}
        ablyMessages={[]}
        status="ready"
        callbackLog={[]}
        statusLog={[]}
        onClearLogs={() => {}}
      />
    </TooltipProvider>,
  );

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
});
