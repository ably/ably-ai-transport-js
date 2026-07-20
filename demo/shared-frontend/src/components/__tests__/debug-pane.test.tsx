import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { UIMessage } from 'ai';
import type { CodecMessage } from '@ably/ai-transport';
import { DebugPane } from '../../index';
import type { LifecycleLogEntry } from '../debug-pane';

const PANE_OPEN_STORAGE_KEY = 'ait-demo:debug-pane-open';

const renderPane = (lifecycleLog: LifecycleLogEntry[] = []) =>
  render(
    <DebugPane
      messages={[] as CodecMessage<UIMessage>[]}
      ablyMessages={[]}
      status="ready"
      lifecycleLog={lifecycleLog}
      statusLog={[]}
      clientToolLog={[]}
      onClearLogs={() => {}}
    />,
  );

// The pane is open when its "close" control is shown; closed when only the
// reopen tab ("Show debug pane") is shown.
const isOpen = () => screen.queryByText('close') !== null;
const isClosed = () => screen.queryByTitle('Show debug pane') !== null;

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
    fireEvent.click(screen.getByTitle('Show debug pane'));
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

describe('<DebugPane> Lifecycle log', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('shows the empty state when there are no lifecycle events', () => {
    renderPane([]);
    // Two "Lifecycle" texts exist: the tab and the section header. Click the tab.
    fireEvent.click(screen.getByRole('button', { name: /Lifecycle/ }));
    expect(screen.getByText('Run and step lifecycle events will appear here.')).not.toBeNull();
  });

  it('renders run and step events interleaved chronologically in one pane', () => {
    const lifecycleLog: LifecycleLogEntry[] = [
      { time: 1_000, type: 'runStart', detail: 'run: 209528f6, client: galaxy-otter' },
      { time: 1_050, type: 'stepStart', detail: 'run: 209528f6, step: e5d4a6fb, client: galaxy-otter' },
      {
        time: 1_100,
        type: 'stepEnd',
        detail: 'run: 209528f6, step: e5d4a6fb, client: galaxy-otter',
        reason: 'complete',
      },
      { time: 1_150, type: 'runEnd', detail: 'run: 209528f6, client: galaxy-otter', reason: 'complete' },
    ];
    renderPane(lifecycleLog);
    fireEvent.click(screen.getByRole('button', { name: /Lifecycle/ }));

    expect(screen.getByText('runStart')).not.toBeNull();
    expect(screen.getByText('stepStart')).not.toBeNull();
    expect(screen.getByText('stepEnd')).not.toBeNull();
    expect(screen.getByText('runEnd')).not.toBeNull();
    // Both terminal events carry the 'complete' reason label.
    expect(screen.getAllByText('complete').length).toBe(2);
    // Run and step details both render (step ids only on the step rows).
    expect(screen.getAllByText(/run: 209528f6/).length).toBe(4);
    expect(screen.getAllByText(/step: e5d4a6fb/).length).toBe(2);
  });
});
