import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { UIMessage } from 'ai';
import type { CodecMessage } from '@ably/ai-transport';
import { DebugPane } from '../debug-pane';

const PANE_OPEN_STORAGE_KEY = 'ait-demo:debug-pane-open';

const renderPane = () =>
  render(
    <DebugPane
      messages={[] as CodecMessage<UIMessage>[]}
      ablyMessages={[]}
      status="ready"
      callbackLog={[]}
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
